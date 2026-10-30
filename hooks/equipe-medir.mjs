#!/usr/bin/env node
// Mede como a equipe trabalhou nas sessões recentes do Claude Code, para a /retro-equipe.
//
// Lê as transcrições em <pasta do Claude>/projects (sessão principal e subagentes) e
// tira só metadados: tokens e custo por agente, ferramentas usadas, status dos
// relatórios, bloqueios da guarda, compactações e esperas prováveis por aprovação.
// O conteúdo das conversas (pedidos, código, arquivos) nunca vai para a saída.
//
// Uso:
//   node equipe-medir.mjs [--dias 7] [--projeto texto] [--json]
//   node equipe-medir.mjs --retro                 mede, compara com a última retro e guarda a medição
//   node equipe-medir.mjs --guardar-propostas F   guarda as propostas da retro (arquivo .md)
//   node equipe-medir.mjs --ultima                mostra a última retro guardada
// Opções para teste: --raiz <pasta projects> (EQUIPE_PASTA_CLAUDE muda a pasta do Claude).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pastaClaude, pastaDiario, lerJson, lerTexto } from './equipe-comum.mjs';

// ---------- opções ----------
function opcoes(argv) {
  const o = { dias: 7, projeto: '', json: false, retro: false, propostas: '', ultima: false, raiz: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dias') o.dias = Math.max(1, Number(argv[++i]) || 7);
    else if (a === '--projeto') o.projeto = String(argv[++i] || '').toLowerCase();
    else if (a === '--json') o.json = true;
    else if (a === '--retro') o.retro = true;
    else if (a === '--guardar-propostas') o.propostas = String(argv[++i] || '');
    else if (a === '--ultima') o.ultima = true;
    else if (a === '--raiz') o.raiz = String(argv[++i] || '');
  }
  return o;
}

// ---------- preço (US$ por milhão de tokens, docs/modelos.md) ----------
// Na assinatura não se paga por token, mas a proporção mostra o que consome o limite.
const PRECOS = [
  [/fable|mythos/i, { e: 10, s: 50, l: 0.25 }],
  [/opus/i, { e: 4, s: 20, l: 0.2 }],
  [/sonnet/i, { e: 2, s: 10, l: 0.1 }],
  [/haiku/i, { e: 0.1, s: 0.5, l: 0.01, alto: { e: 0.5, s: 2.5, l: 0.05 }, limite: 100000 }],
];

function entradaTotal(u) {
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

function custo(modelo, u) {
  const achado = PRECOS.find(([re]) => re.test(modelo || ''));
  if (!achado) return 0;
  const p = achado[1];
  const t = p.alto && entradaTotal(u) > p.limite ? p.alto : p;
  const cc = u.cache_creation || {};
  const c1h = cc.ephemeral_1h_input_tokens || 0;
  const c5m = cc.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - c1h);
  return ((u.input_tokens || 0) * t.e + (u.output_tokens || 0) * t.s +
    (u.cache_read_input_tokens || 0) * t.l + c5m * t.e * 1.25 + c1h * t.e * 2) / 1e6;
}

// ---------- leitura das transcrições ----------
// Só as linhas que interessam são convertidas: o resto (pedidos, anexos) nem é lido.
const INTERESSA = ['"assistant"', 'tool_result', 'compact_boundary', 'cost-state', 'isApiErrorMessage', 'agent-message'];

// Lê em blocos de 4 MB: sessão longa pode passar do tamanho máximo de texto do Node.
function* linhas(arquivo) {
  let fd;
  try { fd = fs.openSync(arquivo, 'r'); } catch { return; }
  const bloco = Buffer.alloc(4 * 1024 * 1024);
  let resto = Buffer.alloc(0);
  try {
    for (;;) {
      const lidos = fs.readSync(fd, bloco, 0, bloco.length, null);
      if (lidos <= 0) break;
      let dados = Buffer.concat([resto, bloco.subarray(0, lidos)]);
      let inicio = 0;
      let fim;
      while ((fim = dados.indexOf(10, inicio)) !== -1) {
        const l = dados.toString('utf8', inicio, fim);
        inicio = fim + 1;
        const v = interpretar(l);
        if (v) yield v;
      }
      resto = Buffer.from(dados.subarray(inicio));
      dados = null;
    }
    if (resto.length) {
      const v = interpretar(resto.toString('utf8'));
      if (v) yield v;
    }
  } finally {
    try { fs.closeSync(fd); } catch { /* já fechado */ }
  }
}

function interpretar(l) {
  if (!l || !INTERESSA.some((k) => l.includes(k))) return null;
  try { return JSON.parse(l); } catch { return null; }
}

function textoDe(conteudo) {
  if (typeof conteudo === 'string') return conteudo;
  if (Array.isArray(conteudo)) return conteudo.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join(' ');
  return '';
}

// Sessões de versões recentes do Claude Code gravam a decisão de permissão de cada
// ferramenta (permissionDecision, toolDenialKind). Nas antigas, a medição estima: uma
// ferramenta que responde na hora e levou mais de 1 minuto quase sempre esperou aprovação.
const INSTANTANEAS = /^(Edit|Write|MultiEdit|NotebookEdit)$|__(execute_sql|apply_migration|deploy_edge_function|create_edge_function_secret|merge_branch|reset_branch|rebase_branch|delete_branch|pause_project|restore_project|create_project|upload_file|delete_project|manage_adr|ingest_traces|pub|vm_service|roots|dart_fix|dart_format|launch_app|stop_app|run_tests)$/;
const RECUSA = /doesn't want to proceed|tool use was rejected/i;
const BARRADO = /denied by the Claude Code auto mode classifier/i;
const MAPA_CONSULTA = /^mcp__codebase-memory__(search_graph|search_code|trace_path|query_graph|get_code_snippet|get_architecture|detect_changes)$/;

// Agentes em segundo plano não devolvem o relatório no resultado da chamada: ele chega como
// mensagem na fila da sessão principal (anexo "queued_command" e a linha "enqueue" da fila,
// com o mesmo texto). Guarda o último relatório de cada agente; só a palavra-chave do status
// sai daqui, nunca o texto.
const MARCA_RELATORIO = 'The report follows:';
function guardarRelatorios(texto, mapa) {
  for (const m of texto.matchAll(/<agent-message from="([^"]+)">([\s\S]*?)(?=<agent-message from="|$)/g)) {
    if (!m[2].includes('[Subagent hand-back]')) continue;
    // Sem o marcador, o cabeçalho mudou de formato: não adivinha (o texto fixo poderia citar um status).
    const i = m[2].indexOf(MARCA_RELATORIO);
    if (i < 0) continue;
    const relatorio = m[2].slice(i + MARCA_RELATORIO.length).replace(/<\/agent-message>\s*$/, '').replace(/^ {2}/gm, '').trim();
    if (relatorio) mapa.set(m[1], relatorio);
  }
}

function novaAnalise() {
  return {
    msgs: new Map(), ferramentas: {}, usos: new Map(), resultados: new Set(), vistos: new Set(),
    esperas: [], perguntas: [], bloqueios: [], recusas: 0, compactacoes: 0, errosApi: 0,
    aprovacoes: [], barrados: [], recusasUsuario: 0, recusasTexto: 0, barradosTexto: [], temDecisoes: false,
    primeiro: null, ultimo: null, ultimoTs: null, cwd: null, custos: new Map(), ultimoTexto: '',
    entrega: '', entregaTs: null,
    agentes: [], tipoPorAgente: new Map(), relatorios: new Map(),
  };
}

// O subagente termina chamando a ferramenta SubagentHandback, com o relatório no campo
// "message". É a fonte mais segura do relatório: vale para agente em primeiro e em segundo
// plano e não depende de como a sessão principal recebe a mensagem.
const ENTREGA = /^SubagentHandback$/;
function textoDaEntrega(entrada) {
  if (!entrada || typeof entrada !== 'object') return '';
  if (typeof entrada.message === 'string') return entrada.message;
  // Formato diferente do esperado: junta os textos que houver, sem adivinhar o campo.
  return Object.values(entrada).map((v) => (typeof v === 'string' ? v : textoDe(v))).filter(Boolean).join('\n');
}

// Lê um arquivo de transcrição e soma em r. Uma sessão pode estar espalhada em mais de
// um arquivo (quando a pasta do projeto muda no meio), então tudo é deduplicado pelos
// identificadores: mensagem, chamada de ferramenta e linha.
function analisar(arquivo, desdeMs, r = novaAnalise()) {
  for (const d of linhas(arquivo)) {
    if (d.cwd && !r.cwd) r.cwd = d.cwd;
    if (d.type === 'cost-state') {
      // Custo acumulado de cada execução do Claude Code (startTime), já com o que não
      // aparece nas mensagens: compactação, classificador do modo Auto, resumo de páginas.
      const k = d.startTime || 0;
      if (typeof d.totalCostUSD === 'number') r.custos.set(k, Math.max(r.custos.get(k) || 0, d.totalCostUSD));
      continue;
    }
    const ts = Date.parse(d.timestamp || '') || null;
    if (ts !== null && ts < desdeMs) continue;
    if (d.uuid) {
      if (r.vistos.has(d.uuid)) continue;
      r.vistos.add(d.uuid);
    }
    if (ts !== null) {
      if (r.primeiro === null || ts < r.primeiro) r.primeiro = ts;
      if (r.ultimo === null || ts > r.ultimo) r.ultimo = ts;
    }
    if (d.type === 'system' && d.subtype === 'compact_boundary') r.compactacoes++;
    const fila = d.type === 'attachment' && d.attachment && d.attachment.type === 'queued_command' ? d.attachment.prompt
      : d.type === 'queue-operation' && d.operation === 'enqueue' ? d.content : null;
    if (typeof fila === 'string') guardarRelatorios(fila, r.relatorios);
    if (d.isApiErrorMessage) r.errosApi++;
    if (d.type === 'assistant' && d.message) {
      const m = d.message;
      const chave = m.id || d.requestId || d.uuid;
      if (m.usage && chave && !r.msgs.has(chave)) r.msgs.set(chave, { modelo: m.model || '', usage: m.usage, lado: Boolean(d.isSidechain) });
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c.type === 'tool_use') {
          if (r.usos.has(c.id)) continue;
          r.ferramentas[c.name] = (r.ferramentas[c.name] || 0) + 1;
          r.usos.set(c.id, { nome: c.name, ts, tipo: c.input && c.input.subagent_type });
          if (c.name === 'Agent' || c.name === 'Task') {
            r.agentes.push({ tipo: (c.input && c.input.subagent_type) || 'general-purpose', modelo: (c.input && c.input.model) || null });
          }
          if (ENTREGA.test(c.name) && (ts === null || r.entregaTs === null || ts >= r.entregaTs)) {
            // Agente retomado entrega de novo: vale a última entrega.
            const t = textoDaEntrega(c.input);
            if (t) { r.entrega = t; r.entregaTs = ts; }
          }
        } else if (c.type === 'text' && c.text && (ts === null || r.ultimoTs === null || ts >= r.ultimoTs)) {
          // Guardado só para ler o status do relatório final; nunca vai para a saída.
          r.ultimoTexto = c.text;
          r.ultimoTs = ts;
        }
      }
    }
    if (d.type === 'user' && d.message && Array.isArray(d.message.content)) {
      const decisao = d.permissionDecision && typeof d.permissionDecision === 'object' ? d.permissionDecision : null;
      if (decisao || d.toolDenialKind) r.temDecisoes = true;
      let primeiro = true;
      for (const c of d.message.content) {
        if (!c || c.type !== 'tool_result' || r.resultados.has(c.tool_use_id)) continue;
        r.resultados.add(c.tool_use_id);
        const uso = r.usos.get(c.tool_use_id);
        const nome = uso ? uso.nome : '?';
        const texto = textoDe(c.content);
        const s = uso && ts !== null && uso.ts !== null ? (ts - uso.ts) / 1000 : null;
        if (s !== null) {
          if (INSTANTANEAS.test(uso.nome) && s > 60) r.esperas.push({ nome, s });
          if (uso.nome === 'AskUserQuestion') r.perguntas.push(s);
        }
        // A decisão vale para a ferramenta desta linha (uma por linha).
        if (primeiro) {
          primeiro = false;
          if (d.toolDenialKind === 'user-rejected') r.recusasUsuario++;
          else if (d.toolDenialKind) r.barrados.push(nome);
          if (decisao && decisao.decision === 'accept' && /^user/.test(String(decisao.source || ''))) {
            r.aprovacoes.push({ nome, s: s === null ? 0 : s });
          }
        }
        // Bloqueio de verdade: o comando de terminal voltou com erro e a mensagem é curta.
        // Saída de teste ou arquivo lido que só cita a frase não conta.
        if (c.is_error && texto.length < 1500 && (!uso || /^(Bash|PowerShell)$/.test(uso.nome))) {
          const b = texto.match(/Bloqueado pela guarda \(([a-z]+)\):\s*([^\n]{0,90})/);
          if (b) r.bloqueios.push({ perfil: b[1], motivo: limparMotivo(b[2]) });
        }
        if (c.is_error && texto.length < 3000) {
          if (RECUSA.test(texto)) r.recusasTexto++;
          else if (BARRADO.test(texto)) r.barradosTexto.push(nome);
        }
        if (uso && (uso.nome === 'Agent' || uso.nome === 'Task') && d.toolUseResult && d.toolUseResult.agentId) {
          r.tipoPorAgente.set(String(d.toolUseResult.agentId), uso.tipo || 'general-purpose');
        }
      }
    }
  }
  return r;
}

// O motivo da guarda pode citar o comando barrado: o que vem entre aspas sai.
export function limparMotivo(m) {
  // Primeiro a sobra do texto em volta da mensagem (aspas e parêntese no fim), depois o
  // que está entre aspas.
  const sem = m.replace(/["'`)\]\s]+$/, '');
  return sem.replace(/'[^']*'?/g, "'…'").replace(/"[^"]*"?/g, '"…"').trim();
}

// Pedidos de aprovação, bloqueios do modo Auto e recusas: pelos campos que a sessão grava
// ou, em sessão de versão antiga, pela estimativa.
function decisoes(a) {
  if (a.temDecisoes) return { aprovacoes: a.aprovacoes, barrados: a.barrados, recusas: a.recusasUsuario, estimado: false };
  return { aprovacoes: a.esperas, barrados: a.barradosTexto, recusas: a.recusasTexto, estimado: a.esperas.length > 0 };
}

function somarUso(msgs, filtro = () => true) {
  const t = { entrada: 0, saida: 0, custo: 0, modelos: {}, passosAcima100k: 0, passos: 0 };
  for (const m of msgs.values()) {
    if (!filtro(m)) continue;
    const u = m.usage;
    t.entrada += entradaTotal(u);
    t.saida += u.output_tokens || 0;
    t.custo += custo(m.modelo, u);
    t.passos++;
    const nome = (m.modelo || 'desconhecido').replace(/^claude-/, '');
    t.modelos[nome] = (t.modelos[nome] || 0) + 1;
    if (/haiku/i.test(m.modelo) && entradaTotal(u) > 100000) t.passosAcima100k++;
  }
  return t;
}

function modeloPrincipal(modelos) {
  return Object.entries(modelos).sort((a, b) => b[1] - a[1]).map(([m]) => m)[0] || '?';
}

// Status do relatório final de cada agente (só a palavra-chave, nunca o texto).
function statusDoRelatorio(tipo, texto) {
  const t = texto || '';
  // Sem relatório não há status: nunca contar como "passou".
  if (!t.trim()) return tipo === 'revisor' ? 'sem veredito' : tipo === 'implementador' || tipo === 'verificador' ? 'sem status' : '';
  if (tipo === 'revisor') {
    const m = t.match(/veredito\W{0,6}(aprovado com ressalvas|aprovado|reprovado)/i);
    return m ? m[1].toLowerCase() : 'sem veredito';
  }
  if (tipo === 'implementador') {
    const m = t.match(/status\W{0,6}(feito com ressalvas|feito|parcial|bloqueado|precisa de contexto)/i);
    return m ? m[1].toLowerCase() : 'sem status';
  }
  if (tipo === 'verificador') {
    if (/bloque/i.test(t) && !/passou|passaram|passed/i.test(t)) return 'bloqueado';
    // Com contagem ("3 falharam", "0 failed"), vale o número; sem contagem, a palavra.
    const n = [...t.matchAll(/(\d+)\s+(?:testes?\s+|tests?\s+)?(falh|fail)/gi)].map((x) => Number(x[1]));
    if (n.length) return n.some((x) => x > 0) ? 'com falha' : 'passou';
    if (/\b(nenhum|nenhuma|sem|no)\b[^.\n]{0,20}(falh|fail)/i.test(t)) return 'passou';
    if (/\b(falhou|falharam|failed|failures?)\b/i.test(t)) return 'com falha';
    return 'passou';
  }
  return '';
}

// ---------- medição ----------
export function medir({ dias = 7, projeto = '', raiz = '' } = {}) {
  const pastaProjetos = raiz || path.join(pastaClaude(), 'projects');
  const desdeMs = Date.now() - dias * 86400000;
  const sessoes = [];
  let pastas = [];
  try { pastas = fs.readdirSync(pastaProjetos, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { /* sem pasta */ }

  // Uma sessão pode ter arquivos em mais de uma pasta de projeto (a pasta mudou no meio):
  // junta tudo pelo id da sessão, que é o nome do arquivo.
  const porSessao = new Map();
  for (const p of pastas) {
    const dir = path.join(pastaProjetos, p.name);
    let nomes = [];
    try { nomes = fs.readdirSync(dir); } catch { continue; }
    for (const n of nomes) {
      if (!n.endsWith('.jsonl')) continue;
      const arquivo = path.join(dir, n);
      let mtime = 0;
      try { mtime = fs.statSync(arquivo).mtimeMs; } catch { continue; }
      if (mtime < desdeMs) continue;
      const id = n.replace(/\.jsonl$/, '');
      if (!porSessao.has(id)) porSessao.set(id, []);
      porSessao.get(id).push({ arquivo, dirSub: path.join(dir, id, 'subagents') });
    }
  }

  for (const partes of porSessao.values()) {
    {
      const principal = novaAnalise();
      for (const parte of partes) analisar(parte.arquivo, desdeMs, principal);
      if (principal.primeiro === null) continue;
      const nomeProjeto = principal.cwd ? path.basename(principal.cwd.replace(/[\\/]+$/, '')) : '?';
      if (projeto && !nomeProjeto.toLowerCase().includes(projeto) && !(principal.cwd || '').toLowerCase().includes(projeto)) continue;

      // Subagentes: um arquivo por agente em <sessão>/subagents/, com o tipo no .meta.json.
      const arquivosSub = new Map();
      for (const parte of partes) {
        let subs = [];
        try { subs = fs.readdirSync(parte.dirSub).filter((x) => /^agent-.*\.jsonl$/.test(x)); } catch { /* sem subagentes */ }
        for (const s of subs) {
          const idAgente = s.replace(/^agent-/, '').replace(/\.jsonl$/, '');
          if (!arquivosSub.has(idAgente)) arquivosSub.set(idAgente, parte.dirSub);
        }
      }
      const agentes = [];
      for (const [id, dirSub] of arquivosSub) {
        const meta = lerJson(path.join(dirSub, `agent-${id}.meta.json`)) || {};
        const a = analisar(path.join(dirSub, `agent-${id}.jsonl`), desdeMs);
        if (a.primeiro === null) continue;
        const tipo = meta.agentType || principal.tipoPorAgente.get(id) || 'subagente';
        const uso = somarUso(a.msgs);
        const f = a.ferramentas;
        const nomesF = Object.keys(f);
        agentes.push({
          tipo,
          modelo: modeloPrincipal(uso.modelos),
          entrada: uso.entrada, saida: uso.saida, custo: uso.custo, passos: uso.passos,
          passosAcima100k: uso.passosAcima100k,
          segundos: a.ultimo && a.primeiro ? (a.ultimo - a.primeiro) / 1000 : 0,
          leituras: f.Read || 0,
          buscas: (f.Grep || 0) + (f.Glob || 0),
          consultouMapa: nomesF.some((x) => MAPA_CONSULTA.test(x)),
          indexou: Boolean(f['mcp__codebase-memory__index_repository']),
          conferiuIndice: Boolean(f['mcp__codebase-memory__index_status']),
          usouApoio: nomesF.some((x) => x.startsWith('mcp__apoio-local__') && x !== 'mcp__apoio-local__status_local'),
          bloqueios: a.bloqueios,
          ...decisoes(a),
          // Ordem: a entrega do próprio agente (SubagentHandback); a mensagem que chegou na fila
          // da sessão principal; o último texto do agente (versões antigas do Claude Code).
          status: statusDoRelatorio(tipo, a.entrega || principal.relatorios.get(id) || a.ultimoTexto),
        });
      }
      // Formato antigo: mensagens de subagente dentro do arquivo da sessão.
      const lado = somarUso(principal.msgs, (m) => m.lado);
      if (lado.passos > 0) {
        agentes.push({ tipo: 'subagente', modelo: modeloPrincipal(lado.modelos), entrada: lado.entrada, saida: lado.saida, custo: lado.custo, passos: lado.passos, passosAcima100k: lado.passosAcima100k, segundos: 0, leituras: 0, buscas: 0, consultouMapa: false, indexou: false, conferiuIndice: false, usouApoio: false, bloqueios: [], aprovacoes: [], barrados: [], recusas: 0, estimado: false, status: '' });
      }

      const mestre = somarUso(principal.msgs, (m) => !m.lado);
      const f = principal.ferramentas;
      sessoes.push({
        projeto: nomeProjeto,
        inicio: principal.primeiro, fim: principal.ultimo,
        mestre: {
          modelo: modeloPrincipal(mestre.modelos), entrada: mestre.entrada, saida: mestre.saida, custo: mestre.custo,
          leituras: f.Read || 0, buscas: (f.Grep || 0) + (f.Glob || 0), edicoes: (f.Edit || 0) + (f.Write || 0) + (f.MultiEdit || 0),
          terminal: (f.Bash || 0) + (f.PowerShell || 0),
        },
        chamadas: principal.agentes,
        agentes,
        compactacoes: principal.compactacoes,
        errosApi: principal.errosApi,
        ...decisoes(principal),
        perguntas: principal.perguntas,
        bloqueios: principal.bloqueios,
        // O custo que o próprio Claude Code registra é acumulado por execução, então só
        // entram as execuções que começaram dentro do período.
        custoRegistrado: custoRegistrado(principal.custos, desdeMs),
      });
    }
  }
  return { ...resumir(sessoes, { dias, desdeMs, pastaProjetos }), filtro: projeto || null };
}

function custoRegistrado(custos, desdeMs) {
  let soma = 0;
  let achou = false;
  for (const [inicio, valor] of custos) {
    if (inicio && inicio >= desdeMs) { soma += valor; achou = true; }
  }
  return achou ? soma : null;
}

const PADRAO_MODELO = { Explore: 'haiku', implementador: 'sonnet', verificador: 'haiku', revisor: 'sonnet' };

function resumir(sessoes, { dias, desdeMs, pastaProjetos }) {
  const porTipo = {};
  const projetos = {};
  const bloqueios = {};
  const aprovacoes = {};
  const barrados = {};
  const subidas = {};
  let estimado = false;
  let custoMestre = 0;
  let compactacoes = 0;
  let errosApi = 0;
  let recusas = 0;
  let perguntas = 0;
  let segundosPerguntas = 0;
  let custoRegistrado = 0;
  let sessoesComRegistro = 0;
  let leiturasMestre = 0;

  const somarDecisoes = (x) => {
    for (const e of x.aprovacoes) {
      aprovacoes[e.nome] = aprovacoes[e.nome] || { vezes: 0, segundos: 0 };
      aprovacoes[e.nome].vezes++;
      aprovacoes[e.nome].segundos += e.s;
    }
    for (const nome of x.barrados) barrados[nome] = (barrados[nome] || 0) + 1;
    recusas += x.recusas;
    if (x.estimado) estimado = true;
  };
  const somarBloqueios = (lista) => {
    for (const b of lista) {
      const k = `${b.perfil}: ${b.motivo}`;
      bloqueios[k] = (bloqueios[k] || 0) + 1;
    }
  };

  for (const s of sessoes) {
    custoMestre += s.mestre.custo;
    leiturasMestre += s.mestre.leituras;
    compactacoes += s.compactacoes;
    errosApi += s.errosApi;
    perguntas += s.perguntas.length;
    segundosPerguntas += s.perguntas.reduce((a, b) => a + b, 0);
    if (s.custoRegistrado !== null && s.custoRegistrado !== undefined) { custoRegistrado += s.custoRegistrado; sessoesComRegistro++; }
    somarDecisoes(s);
    somarBloqueios(s.bloqueios);
    const pj = projetos[s.projeto] = projetos[s.projeto] || { sessoes: 0, custo: 0, compactacoes: 0, agentes: 0 };
    pj.sessoes++;
    pj.custo += s.mestre.custo;
    pj.compactacoes += s.compactacoes;
    for (const c of s.chamadas) {
      if (c.modelo && PADRAO_MODELO[c.tipo] && !new RegExp(PADRAO_MODELO[c.tipo], 'i').test(c.modelo)) {
        const k = `${c.tipo} em ${c.modelo}`;
        subidas[k] = (subidas[k] || 0) + 1;
      }
    }
    for (const a of s.agentes) {
      pj.custo += a.custo;
      pj.agentes++;
      somarDecisoes(a);
      somarBloqueios(a.bloqueios);
      const t = porTipo[a.tipo] = porTipo[a.tipo] || {
        chamadas: 0, entrada: 0, saida: 0, custo: 0, segundos: 0, passosAcima100k: 0, leituras: 0,
        consultouMapa: 0, indexou: 0, conferiuIndice: 0, usouApoio: 0, status: {}, modelos: {},
      };
      t.chamadas++;
      t.entrada += a.entrada;
      t.saida += a.saida;
      t.custo += a.custo;
      t.segundos += a.segundos;
      t.passosAcima100k += a.passosAcima100k;
      t.leituras += a.leituras;
      if (a.consultouMapa) t.consultouMapa++;
      if (a.indexou) t.indexou++;
      if (a.conferiuIndice) t.conferiuIndice++;
      if (a.usouApoio) t.usouApoio++;
      if (a.status) t.status[a.status] = (t.status[a.status] || 0) + 1;
      t.modelos[a.modelo] = (t.modelos[a.modelo] || 0) + 1;
    }
  }

  const custoAgentes = Object.values(porTipo).reduce((x, t) => x + t.custo, 0);
  const custoTotal = custoMestre + custoAgentes;
  const n = sessoes.length || 1;
  const totalAprovacoes = Object.values(aprovacoes).reduce((x, e) => x + e.vezes, 0);
  const segundosAprovacao = Object.values(aprovacoes).reduce((x, e) => x + e.segundos, 0);
  const totalBarrados = Object.values(barrados).reduce((x, v) => x + v, 0);
  const totalBloqueios = Object.values(bloqueios).reduce((x, b) => x + b, 0);
  const ex = porTipo.Explore;
  const rev = porTipo.revisor;
  const imp = porTipo.implementador;

  const indicadores = {
    sessoes: sessoes.length,
    custo_por_sessao: custoTotal / n,
    custo_mestre_pct: custoTotal ? (100 * custoMestre) / custoTotal : 0,
    leituras_do_mestre_por_sessao: leiturasMestre / n,
    explore_tokens_por_chamada: ex ? ex.entrada / ex.chamadas : 0,
    explore_mapa_pct: ex ? (100 * ex.consultouMapa) / ex.chamadas : 0,
    haiku_passos_acima_100k: Object.values(porTipo).reduce((x, t) => x + t.passosAcima100k, 0),
    bloqueios_por_sessao: totalBloqueios / n,
    aprovacoes_por_sessao: totalAprovacoes / n,
    minutos_esperando_aprovacao_por_sessao: segundosAprovacao / 60 / n,
    barrados_pelo_auto_por_sessao: totalBarrados / n,
    revisor_reprovado_pct: rev ? (100 * (rev.status.reprovado || 0)) / rev.chamadas : 0,
    implementador_incompleto_pct: imp ? (100 * (imp.chamadas - (imp.status.feito || 0) - (imp.status['feito com ressalvas'] || 0))) / imp.chamadas : 0,
    compactacoes_por_sessao: compactacoes / n,
    subidas_de_modelo: Object.values(subidas).reduce((x, v) => x + v, 0),
  };

  return {
    geradoEm: new Date().toISOString(),
    dias, desde: new Date(desdeMs).toISOString(), pastaProjetos,
    sessoes: sessoes.length,
    custo: { total: custoTotal, mestre: custoMestre, agentes: custoAgentes, registradoPeloClaudeCode: sessoesComRegistro ? custoRegistrado : null, sessoesComRegistro },
    mestre: { leituras: leiturasMestre, modelos: contar(sessoes.map((s) => s.mestre.modelo)) },
    porTipo, projetos, bloqueios, aprovacoes, barrados, estimado, subidas,
    compactacoes, errosApi, recusas, perguntas, segundosPerguntas,
    indicadores,
  };
}

function contar(lista) {
  const o = {};
  for (const x of lista) o[x] = (o[x] || 0) + 1;
  return o;
}

// ---------- texto ----------
const nf = (casas = 0) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
const dinheiro = (v) => `US$ ${nf(2).format(v || 0)}`;
const mil = (v) => (v >= 1e6 ? `${nf(1).format(v / 1e6)} mi` : v >= 1e3 ? `${nf(0).format(v / 1e3)} mil` : nf(0).format(v || 0));
const pct = (v) => `${nf(0).format(v || 0)}%`;
const minutos = (s) => (s >= 3600 ? `${nf(1).format(s / 3600)} h` : `${nf(0).format(s / 60)} min`);
const data = (iso) => new Date(iso).toLocaleDateString('pt-BR');

export function texto(r) {
  const out = [];
  out.push(`# Medição da equipe: últimos ${r.dias} dias (desde ${data(r.desde)})`);
  out.push('');
  if (!r.sessoes) {
    out.push(`Nenhuma sessão encontrada em ${r.pastaProjetos} neste período${r.filtro ? ` para o projeto "${r.filtro}"` : ''}.`);
    return out.join('\n');
  }
  const pj = Object.keys(r.projetos).length;
  out.push(`${r.sessoes} sessões em ${pj} projeto(s). Fonte: ${r.pastaProjetos}`);
  out.push('Custo em preço de API, aproximado: na assinatura serve como proporção do limite usado.');
  out.push('');
  out.push('## Gasto por agente');
  out.push('');
  out.push('| Quem | Chamadas | Modelo | Entrada | Saída | Custo | % |');
  out.push('|---|---|---|---|---|---|---|');
  const total = r.custo.total || 1;
  out.push(`| mestre | ${r.sessoes} sessões | ${Object.keys(r.mestre.modelos).join(', ')} | — | — | ${dinheiro(r.custo.mestre)} | ${pct((100 * r.custo.mestre) / total)} |`);
  for (const [tipo, t] of Object.entries(r.porTipo).sort((a, b) => b[1].custo - a[1].custo)) {
    out.push(`| ${tipo} | ${t.chamadas} | ${Object.keys(t.modelos).join(', ')} | ${mil(t.entrada)} | ${mil(t.saida)} | ${dinheiro(t.custo)} | ${pct((100 * t.custo) / total)} |`);
  }
  out.push(`| **total** | | | | | **${dinheiro(r.custo.total)}** | |`);
  if (r.custo.registradoPeloClaudeCode !== null) {
    out.push('');
    out.push(`Custo registrado pelo próprio Claude Code nas ${r.custo.sessoesComRegistro} sessões que começaram no período: ${dinheiro(r.custo.registradoPeloClaudeCode)}.`);
  }
  out.push('');
  out.push('## Sinais');
  out.push('');
  const i = r.indicadores;
  const ex = r.porTipo.Explore;
  if (ex) {
    out.push(`- Explore: ${ex.chamadas} chamadas; consultou o mapa em ${ex.consultouMapa} (${pct(i.explore_mapa_pct)}), conferiu o índice em ${ex.conferiuIndice}, indexou ${ex.indexou} vez(es); usou o apoio local em ${ex.usouApoio}; ${nf(1).format(ex.leituras / ex.chamadas)} leituras (Read) e ${mil(i.explore_tokens_por_chamada)} tokens de entrada por chamada.`);
  }
  if (i.haiku_passos_acima_100k) out.push(`- Passos de Haiku acima de 100 mil tokens (custam 5 vezes mais): ${i.haiku_passos_acima_100k}.`);
  for (const tipo of ['implementador', 'verificador', 'revisor']) {
    const t = r.porTipo[tipo];
    if (!t) continue;
    const st = Object.entries(t.status).map(([k, v]) => `${v} ${k}`).join(', ');
    out.push(`- ${tipo}: ${t.chamadas} chamadas${st ? ` (${st})` : ''}; ${minutos(t.segundos / t.chamadas)} em média.`);
  }
  out.push(`- Mestre: ${r.mestre.leituras} leituras próprias (Read), ${nf(1).format(i.leituras_do_mestre_por_sessao)} por sessão.`);
  const subidas = Object.entries(r.subidas);
  out.push(`- Subidas de modelo: ${subidas.length ? subidas.map(([k, v]) => `${k} (${v})`).join(', ') : 'nenhuma'}.`);
  out.push(`- Compactações: ${r.compactacoes} (${nf(1).format(i.compactacoes_por_sessao)} por sessão). Erros da API: ${r.errosApi}.`);
  const aprov = Object.entries(r.aprovacoes).sort((a, b) => b[1].segundos - a[1].segundos);
  const totalAprov = aprov.reduce((x, [, e]) => x + e.vezes, 0);
  const comoMedido = r.estimado ? ' (estimado onde a sessão não grava as decisões: ferramenta instantânea que levou mais de 1 min)' : '';
  out.push(`- Pedidos de aprovação que você respondeu${comoMedido}: ${totalAprov}${aprov.length ? `, com a sessão parada ${minutos(aprov.reduce((x, [, e]) => x + e.segundos, 0))} no total: ` + aprov.slice(0, 6).map(([k, e]) => `${k} ${e.vezes}x (${minutos(e.segundos)})`).join(', ') : ''}.`);
  const barr = Object.entries(r.barrados).sort((a, b) => b[1] - a[1]);
  out.push(`- Barrados pelo modo Auto: ${barr.reduce((x, [, v]) => x + v, 0)}${barr.length ? ` (${barr.slice(0, 6).map(([k, v]) => `${k} ${v}x`).join(', ')})` : ''}. Recusados por você: ${r.recusas}.`);
  out.push(`- Perguntas ao usuário: ${r.perguntas}${r.perguntas ? `, esperando ${minutos(r.segundosPerguntas)} no total` : ''}.`);
  const bloqueios = Object.entries(r.bloqueios).sort((a, b) => b[1] - a[1]);
  const totalBloqueios = bloqueios.reduce((x, [, v]) => x + v, 0);
  out.push(`- Bloqueios da guarda: ${totalBloqueios}.`);
  for (const [k, v] of bloqueios.slice(0, 8)) out.push(`  - ${v}x ${k}`);
  out.push('');
  out.push('## Por projeto');
  out.push('');
  out.push('| Projeto | Sessões | Chamadas de agente | Compactações | Custo |');
  out.push('|---|---|---|---|---|');
  for (const [nome, p] of Object.entries(r.projetos).sort((a, b) => b[1].custo - a[1].custo)) {
    out.push(`| ${nome} | ${p.sessoes} | ${p.agentes} | ${p.compactacoes} | ${dinheiro(p.custo)} |`);
  }
  return out.join('\n');
}

// Indicadores em que subir é bom; nos outros, descer é bom.
const MAIOR_MELHOR = new Set(['explore_mapa_pct']);
const ROTULOS = {
  custo_por_sessao: ['Custo por sessão', dinheiro],
  custo_mestre_pct: ['Parte do mestre no custo', pct],
  leituras_do_mestre_por_sessao: ['Leituras do mestre por sessão', (v) => nf(1).format(v)],
  explore_tokens_por_chamada: ['Tokens de entrada por chamada do Explore', mil],
  explore_mapa_pct: ['Chamadas do Explore que consultaram o mapa', pct],
  haiku_passos_acima_100k: ['Passos de Haiku acima de 100 mil', (v) => nf(0).format(v)],
  bloqueios_por_sessao: ['Bloqueios da guarda por sessão', (v) => nf(1).format(v)],
  aprovacoes_por_sessao: ['Pedidos de aprovação por sessão', (v) => nf(1).format(v)],
  minutos_esperando_aprovacao_por_sessao: ['Minutos parados esperando aprovação, por sessão', (v) => nf(0).format(v)],
  barrados_pelo_auto_por_sessao: ['Barrados pelo modo Auto por sessão', (v) => nf(1).format(v)],
  revisor_reprovado_pct: ['Revisões reprovadas', pct],
  implementador_incompleto_pct: ['Tarefas do implementador não concluídas', pct],
  compactacoes_por_sessao: ['Compactações por sessão', (v) => nf(1).format(v)],
  subidas_de_modelo: ['Subidas de modelo', (v) => nf(0).format(v)],
};

export function comparacao(antes, agora) {
  const out = ['| Indicador | Antes | Agora | |', '|---|---|---|---|'];
  for (const [k, [rotulo, fmt]] of Object.entries(ROTULOS)) {
    if (!(k in agora) || !(k in antes)) continue;
    const a = antes[k];
    const b = agora[k];
    let sinal = '=';
    if (Math.abs(b - a) > Math.max(Math.abs(a) * 0.05, 1e-9)) {
      const melhorou = MAIOR_MELHOR.has(k) ? b > a : b < a;
      sinal = melhorou ? 'melhorou' : 'piorou';
    }
    out.push(`| ${rotulo} | ${fmt(a)} | ${fmt(b)} | ${sinal} |`);
  }
  return out.join('\n');
}

// ---------- diário ----------
function carimbo() {
  const d = new Date();
  const p = (x, n = 2) => String(x).padStart(n, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

// Nome que ainda não existe na pasta: duas rodadas no mesmo instante não se sobrescrevem.
function arquivoNovo(pasta, prefixo, extensao) {
  const base = `${prefixo}-${carimbo()}`;
  let nome = path.join(pasta, `${base}${extensao}`);
  for (let i = 2; fs.existsSync(nome); i++) nome = path.join(pasta, `${base}-${i}${extensao}`);
  return nome;
}

// Estado das retrospectivas em ultima-retro.json:
//   data, medicao, propostas, dias, filtro: a última retrospectiva concluída (com as
//     propostas guardadas). É a base de comparação e a data que o boletim usa.
//   pendente: a medição de uma retrospectiva em andamento. Só vira base quando as
//     propostas são guardadas; repetir --retro, ou rodar com outro período ou projeto,
//     não apaga a base nem as propostas anteriores.
function principal() {
  const o = opcoes(process.argv.slice(2));
  const diario = pastaDiario();
  const arquivoEstado = path.join(diario, 'ultima-retro.json');
  const estado = lerJson(arquivoEstado) || {};
  const gravarEstado = (e) => {
    fs.mkdirSync(diario, { recursive: true });
    fs.writeFileSync(arquivoEstado, JSON.stringify(e, null, 2));
  };

  if (o.propostas) {
    const conteudo = lerTexto(o.propostas);
    if (conteudo === null) { console.error(`Não achei o arquivo ${o.propostas}.`); process.exit(1); }
    fs.mkdirSync(diario, { recursive: true });
    const destino = arquivoNovo(diario, 'retro-propostas', '.md');
    fs.writeFileSync(destino, conteudo);
    const base = estado.pendente || { data: new Date().toISOString(), medicao: estado.medicao || null, dias: estado.dias ?? null, filtro: estado.filtro ?? null };
    gravarEstado({ data: base.data, medicao: base.medicao, dias: base.dias, filtro: base.filtro, propostas: destino, pendente: null });
    console.log(`Propostas guardadas em ${destino}. A próxima retrospectiva compara com esta.`);
    return;
  }

  if (o.ultima) {
    if (!estado.data) { console.log('Nenhuma retrospectiva concluída ainda.'); }
    else {
      console.log(`Última retrospectiva concluída: ${data(estado.data)} (${estado.dias || '?'} dias${estado.filtro ? `, projeto "${estado.filtro}"` : ''}).`);
      const prop = estado.propostas ? lerTexto(estado.propostas) : null;
      console.log(prop ? `\n${prop.slice(0, 4000)}` : 'Sem propostas guardadas.');
    }
    if (estado.pendente) console.log(`\nHá uma medição de ${data(estado.pendente.data)} esperando as propostas (--guardar-propostas).`);
    return;
  }

  const r = medir({ dias: o.dias, projeto: o.projeto, raiz: o.raiz });
  if (o.json) { console.log(JSON.stringify(r, null, 2)); return; }
  const saida = [texto(r)];

  if (o.retro) {
    const versao = lerJson(path.join(pastaClaude(), 'equipe-versao.json'));
    if (versao && versao.pasta) {
      saida.push('');
      saida.push(`Cópia da equipe neste computador: ${versao.pasta}${versao.commit ? ` (instalada a partir do commit ${String(versao.commit).slice(0, 7)})` : ''}.`);
    }
    const medicaoAnterior = estado.medicao ? lerJson(estado.medicao) : null;
    const mesmaBase = (estado.dias ?? o.dias) === o.dias && (estado.filtro || null) === (o.projeto || null);
    if (medicaoAnterior && medicaoAnterior.indicadores && mesmaBase) {
      saida.push('');
      saida.push(`## Desde a última retrospectiva (${data(estado.data)})`);
      saida.push('');
      saida.push(comparacao(medicaoAnterior.indicadores, r.indicadores));
    } else if (medicaoAnterior) {
      saida.push('');
      saida.push(`A última retrospectiva (${data(estado.data)}) usou outro período ou outro projeto: sem comparação de números desta vez.`);
    } else {
      saida.push('');
      saida.push('Primeira retrospectiva: esta medição vira a base de comparação da próxima, quando as propostas forem guardadas.');
    }
    const prop = estado.propostas ? lerTexto(estado.propostas) : null;
    if (prop) {
      saida.push('');
      saida.push('### Propostas da última retrospectiva');
      saida.push('');
      saida.push(prop.slice(0, 4000));
    }
    if (r.sessoes) {
      fs.mkdirSync(diario, { recursive: true });
      const arq = arquivoNovo(diario, 'medicao', '.json');
      fs.writeFileSync(arq, JSON.stringify(r, null, 2));
      gravarEstado({ ...estado, pendente: { data: new Date().toISOString(), medicao: arq, dias: o.dias, filtro: o.projeto || null } });
      saida.push('');
      saida.push(`Medição guardada em ${arq}. Ela vira a base quando as propostas forem guardadas (--guardar-propostas).`);
    }
  }
  console.log(saida.join('\n'));
}

// Só roda como programa; importado pelos testes, expõe as funções.
// Compara o caminho real: chamado por um atalho (junção, symlink), também roda.
const real = (p) => {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch { /* fica o caminho dado */ }
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) principal();
