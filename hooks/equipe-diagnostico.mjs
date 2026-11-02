#!/usr/bin/env node
// Diagnóstico da instalação da equipe: confere o que foi instalado e diz o que fazer em
// cada problema.
//
//   node equipe-diagnostico.mjs [--claude-json <arquivo>]
//     Completo: hooks, agentes, servidores, mapa, aviso, memória e versão. Sai com 1 se
//     houver algum erro. O instalador roda no fim.
//   diagnosticoRapido() / resumoRapido()
//     Só lê arquivos (sem programa nenhum, em poucos milissegundos). O boletim de início
//     usa para escrever uma linha quando algo está errado.
//
// Níveis: erro (algo da equipe não funciona), aviso (funciona, mas falta um passo), info
// (opcional ou só informação) e ok.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { git, lerJson, lerTexto, pastaClaude, versaoDaEquipe } from './equipe-comum.mjs';

const barras = (p) => String(p).replace(/\\/g, '/');
const existe = (p) => { try { return fs.existsSync(p); } catch { return false; } };

// Hook da equipe no settings.json: o comando ou um argumento aponta para <pasta>/hooks/equipe-*.mjs.
const HOOK_EQUIPE = /[\\/]hooks[\\/]equipe-[a-z0-9-]+\.mjs$/i;
// Agentes da equipe e se cada um tem a guarda de terminal. Vale a cópia da equipe
// (equipe-versao.json), se existir; esta lista é a reserva.
const AGENTES_RESERVA = { Explore: true, implementador: true, revisor: false, verificador: true };

function item(nivel, texto, fazer = '') {
  return { nivel, texto, fazer };
}

// .claude.json do usuário: na pasta de configuração quando ela foi trocada
// (CLAUDE_CONFIG_DIR ou -Destino do instalador); senão, ao lado da pasta .claude.
export function arquivoUsuario(pasta = pastaClaude()) {
  if (process.env.CLAUDE_CONFIG_DIR) return path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
  const dentro = path.join(pasta, '.claude.json');
  if (path.resolve(pasta) !== path.resolve(os.homedir(), '.claude') && existe(dentro)) return dentro;
  return path.join(os.homedir(), '.claude.json');
}

// ---------- Programa do mapa (codebase-memory-mcp) ----------

// Caminho do programa do mapa, ou null. Ordem: EQUIPE_MAPA_BIN (testes), o comando
// registrado no .claude.json (se pedido), o PATH e a pasta onde o instalador oficial põe.
export function acharMapa({ registrado = null } = {}) {
  if (process.env.EQUIPE_MAPA_BIN !== undefined) {
    const p = process.env.EQUIPE_MAPA_BIN;
    return p && existe(p) ? p : null;
  }
  if (registrado && path.isAbsolute(registrado) && existe(registrado)) return registrado;
  const nomes = process.platform === 'win32'
    ? ['codebase-memory-mcp.exe', 'codebase-memory-mcp.cmd']
    : ['codebase-memory-mcp'];
  for (const dir of String(process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of nomes) {
      const c = path.join(dir.replace(/^"|"$/g, ''), n);
      try { if (fs.statSync(c).isFile()) return c; } catch { /* não está aqui */ }
    }
  }
  if (process.env.LOCALAPPDATA) {
    const c = path.join(process.env.LOCALAPPDATA, 'Programs', 'codebase-memory-mcp', 'codebase-memory-mcp.exe');
    if (existe(c)) return c;
  }
  return null;
}

// Roda o programa do mapa e devolve a saída, ou null (erro, tempo esgotado ou jeito de
// rodar que não é seguro). Script .mjs roda no Node (testes). No Windows, um .cmd (atalho
// do npm) só roda com argumentos simples: o cmd.exe estraga aspas de JSON.
export function rodarMapa(programa, args, limite = 2000) {
  if (!programa) return null;
  let exe = programa;
  let lista = args;
  let shell = false;
  if (/\.(mjs|js)$/i.test(programa)) {
    exe = process.execPath;
    lista = [programa, ...args];
  } else if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(programa)) {
    if (!args.every((a) => /^[A-Za-z0-9_.-]+$/.test(a))) return null;
    // Uma linha só: argumentos separados com shell ligado dão aviso no Node novo.
    exe = [`"${programa}"`, ...args].join(' ');
    lista = [];
    shell = true;
  }
  try {
    return execFileSync(exe, lista, {
      encoding: 'utf8', timeout: limite, windowsHide: true, shell,
      stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

// Valores de "codebase-memory-mcp config list". O formato atual é
//   Configuration:
//     auto_index                = false
// mas aceita também "chave: valor" e JSON. Chave ausente fica de fora (vale o padrão do
// programa: auto_index false, auto_index_limit 50000, auto_watch true).
export function lerConfigMapa(texto) {
  const valores = {};
  if (!texto) return valores;
  const re = /"?\b(auto_index_limit|auto_index|auto_watch)\b"?\s*[:=]\s*"?([A-Za-z0-9_.-]+)/g;
  let m;
  while ((m = re.exec(texto)) !== null) {
    if (!(m[1] in valores)) valores[m[1]] = m[2].toLowerCase();
  }
  return valores;
}

export const PADRAO_MAPA = { auto_index: 'false', auto_index_limit: '50000', auto_watch: 'true' };

// Projetos de "codebase-memory-mcp cli list_projects". Aceita a lista pura, o objeto
// {"projects": [...]} e o envelope do MCP ({"content": [{"text": "..."}]}). null se a
// saída não for JSON reconhecível.
export function projetosDoMapa(texto) {
  if (!texto) return null;
  const tentar = (t) => { try { return JSON.parse(t); } catch { return undefined; } };
  let v = tentar(texto.trim());
  if (v === undefined) {
    const i = texto.search(/[[{]/);
    if (i < 0) return null;
    v = tentar(texto.slice(i).trim());
    if (v === undefined) return null;
  }
  for (let passo = 0; passo < 4; passo++) {
    if (Array.isArray(v)) return v;
    if (!v || typeof v !== 'object') return null;
    if (Array.isArray(v.projects)) return v.projects;
    const conteudo = v.content || (v.result && v.result.content);
    if (Array.isArray(conteudo) && conteudo[0] && typeof conteudo[0].text === 'string') {
      const dentro = tentar(conteudo[0].text);
      if (dentro === undefined) return null;
      v = dentro;
      continue;
    }
    if (v.result !== undefined) { v = v.result; continue; }
    return null;
  }
  return null;
}

// A pasta está entre os projetos do mapa? Compara a pasta raiz (root_path e parecidos)
// e, na falta dela, o nome que o mapa dá ao projeto (o caminho com traços).
export function projetoIndexado(projetos, raiz) {
  if (!Array.isArray(projetos) || !raiz) return false;
  const caminho = (p) => {
    let s = barras(p).replace(/\/+$/, '');
    if (process.platform === 'win32') s = s.toLowerCase();
    return s;
  };
  const nome = (p) => barras(p).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const alvos = new Set([caminho(raiz)]);
  try { alvos.add(caminho(fs.realpathSync.native(raiz))); } catch { /* fica o caminho dado */ }
  const nomes = new Set([...alvos].map(nome));
  for (const p of projetos) {
    if (typeof p === 'string') {
      if (alvos.has(caminho(p)) || nomes.has(nome(p))) return true;
      continue;
    }
    if (!p || typeof p !== 'object') continue;
    const r = p.root_path || p.rootPath || p.root || p.repo_path || p.path;
    if (typeof r === 'string' && r) {
      if (alvos.has(caminho(r))) return true;
      continue;
    }
    if (typeof p.name === 'string' && nomes.has(nome(p.name))) return true;
  }
  return false;
}

// ---------- Conferências que só leem arquivos ----------

// Agentes da equipe: nome -> tem guarda. Da cópia da equipe, se houver; senão, a reserva.
function agentesEsperados(pasta) {
  const info = lerJson(path.join(pasta, 'equipe-versao.json'));
  const origem = info && typeof info.pasta === 'string' ? path.join(info.pasta, 'agents') : null;
  if (origem) {
    try {
      const nomes = fs.readdirSync(origem).filter((n) => n.endsWith('.md'));
      if (nomes.length) {
        const r = {};
        for (const n of nomes) r[n.slice(0, -3)] = (lerTexto(path.join(origem, n)) || '').includes('guarda-comandos.ps1');
        return r;
      }
    } catch { /* usa a reserva */ }
  }
  return { ...AGENTES_RESERVA };
}

// Scripts que um hook importa (./equipe-*.mjs), um nível por vez, sem repetir.
function importsFaltando(script) {
  const faltam = [];
  const vistos = new Set();
  const fila = [script];
  while (fila.length && vistos.size < 60) {
    const atual = fila.shift();
    if (vistos.has(atual)) continue;
    vistos.add(atual);
    const texto = lerTexto(atual);
    if (texto === null) continue;
    for (const m of texto.matchAll(/^\s*import\s[^'"]*['"](\.\/[^'"]+\.mjs)['"]/gm)) {
      const alvo = path.join(path.dirname(atual), m[1]);
      if (existe(alvo)) fila.push(alvo);
      else faltam.push(path.basename(alvo));
    }
  }
  return [...new Set(faltam)];
}

function conferirHooks(pasta, saida) {
  const arq = path.join(pasta, 'settings.json');
  const texto = lerTexto(arq);
  if (texto === null) {
    saida.push(item('aviso', `Não há ${barras(arq)}: nem bloqueios nem hooks da equipe estão instalados.`, 'Rode o instalador da equipe sem -SemBloqueios.'));
    return 0;
  }
  let s;
  try { s = JSON.parse(texto.replace(/^﻿/, '')); } catch {
    saida.push(item('erro', `${barras(arq)} não é um JSON válido: o Claude Code ignora os bloqueios e os hooks.`, 'Corrija o arquivo (ou volte a cópia .bak-* mais nova) e rode o instalador de novo.'));
    return 0;
  }
  const hooks = s && typeof s.hooks === 'object' && s.hooks ? s.hooks : {};
  let total = 0;
  const semScript = new Set();
  const semNode = new Set();
  const semImport = new Set();
  for (const grupos of Object.values(hooks)) {
    for (const g of Array.isArray(grupos) ? grupos : []) {
      for (const h of g && Array.isArray(g.hooks) ? g.hooks : []) {
        if (!h || typeof h !== 'object') continue;
        const partes = [h.command, ...(Array.isArray(h.args) ? h.args : [])].filter((p) => typeof p === 'string');
        const script = partes.find((p) => HOOK_EQUIPE.test(p));
        if (!script) continue;
        total++;
        if (!existe(script)) { semScript.add(barras(script)); continue; }
        if (typeof h.command === 'string' && h.command !== script && /[\\/]/.test(h.command) && !existe(h.command)) semNode.add(barras(h.command));
        for (const f of importsFaltando(script)) semImport.add(f);
      }
    }
  }
  if (!total) {
    saida.push(item('aviso', 'Nenhum hook da equipe no settings.json: sem boletim, travas, aviso e memória.', 'Rode o instalador da equipe sem -SemHooks (precisa do Node.js 20 ou mais novo).'));
    return 0;
  }
  if (semScript.size) saida.push(item('erro', `Hook da equipe aponta para arquivo que não existe: ${[...semScript].join(', ')}.`, 'Rode o instalador da equipe de novo: ele copia os scripts para a pasta hooks.'));
  if (semNode.size) saida.push(item('erro', `O Node.js registrado nos hooks não existe mais: ${[...semNode].join(', ')}.`, 'Instale o Node.js 20 ou mais novo (ou confira onde ele está) e rode o instalador de novo.'));
  if (semImport.size) saida.push(item('erro', `Faltam scripts que os hooks usam: ${[...semImport].join(', ')}.`, 'Rode o instalador da equipe de novo.'));
  if (!semScript.size && !semNode.size && !semImport.size) saida.push(item('ok', `Hooks da equipe: ${total} registro(s), todos os arquivos existem.`));
  return total;
}

function conferirAgentes(pasta, saida) {
  const esperados = agentesEsperados(pasta);
  const dir = path.join(pasta, 'agents');
  const faltam = [];
  const marcas = [];
  const semGuarda = [];
  const guardaSumiu = new Set();
  for (const [nome, temGuarda] of Object.entries(esperados)) {
    const texto = lerTexto(path.join(dir, `${nome}.md`));
    if (texto === null) { faltam.push(nome); continue; }
    if (texto.includes('__NODE__') || texto.includes('__PASTA_CLAUDE__')) marcas.push(nome);
    if (!temGuarda) continue;
    const m = texto.match(/&\s*'((?:[^']|'')+guarda-comandos\.ps1)'/);
    if (!m) { semGuarda.push(nome); continue; }
    const caminho = m[1].replace(/''/g, "'");
    if (!caminho.includes('__PASTA_CLAUDE__') && !existe(caminho)) guardaSumiu.add(barras(caminho));
  }
  if (faltam.length) saida.push(item('erro', `Agente(s) da equipe não instalado(s): ${faltam.join(', ')}.`, 'Rode o instalador da equipe de novo.'));
  if (marcas.length) saida.push(item('erro', `Agente(s) com marcador não trocado (__NODE__ ou __PASTA_CLAUDE__): ${marcas.join(', ')}. Os hooks deles não rodam.`, 'Rode o instalador da equipe de novo; não copie os agentes à mão.'));
  if (semGuarda.length) saida.push(item('erro', `Agente(s) sem a guarda de terminal: ${semGuarda.join(', ')}.`, 'Rode o instalador da equipe de novo (ele troca o arquivo e guarda uma cópia .bak-*).'));
  if (guardaSumiu.size) saida.push(item('erro', `A guarda de terminal que os agentes usam não existe: ${[...guardaSumiu].join(', ')}.`, 'Rode o instalador da equipe de novo.'));
  if (!faltam.length && !marcas.length && !semGuarda.length && !guardaSumiu.size) {
    saida.push(item('ok', `Agentes da equipe: ${Object.keys(esperados).join(', ')}, com a guarda onde ela vale.`));
  }
}

function conferirAviso(pasta, saida) {
  const arq = path.join(pasta, 'equipe-aviso.json');
  if (!existe(arq)) {
    saida.push(item('info', 'Aviso no celular desligado (sem equipe-aviso.json).', 'Para ligar, rode o instalador sem -SemAviso.'));
    return;
  }
  const cfg = lerJson(arq);
  if (!cfg || typeof cfg.ntfy !== 'string' || !/^https?:\/\/[^/\s]+\/[^/\s]+/.test(cfg.ntfy)) {
    saida.push(item('aviso', `${barras(arq)} não tem um endereço do ntfy válido: o aviso no celular não sai.`, 'Apague o arquivo e rode o instalador de novo (ele cria um tópico novo).'));
    return;
  }
  // O tópico é a senha do aviso: não aparece aqui (o diagnóstico pode ser copiado para alguém).
  saida.push(item('ok', 'Aviso no celular ligado (ntfy).'));
}

// Configuração da memória: a pasta do clone, ou null (não configurada ou inválida).
function conferirMemoria(pasta, saida) {
  const arq = path.join(pasta, 'equipe-memoria.json');
  if (!existe(arq)) {
    saida.push(item('info', 'Memória entre computadores não configurada (opcional).', 'Para ligar: rode o instalador com -Memoria <repositório git privado>.'));
    return null;
  }
  const cfg = lerJson(arq);
  const clone = cfg && typeof cfg.pasta === 'string' ? cfg.pasta : '';
  if (!clone || !existe(path.join(clone, '.git'))) {
    saida.push(item('aviso', `A memória aponta para ${clone ? barras(clone) : '(nada)'}, que não é um clone do git: a sincronização não roda.`, 'Rode o instalador de novo com -Memoria <repositório ou pasta do clone>.'));
    return null;
  }
  return clone;
}

// ---------- Conferências completas (rodam programas) ----------

function conferirServidores(arqUsuario, saida) {
  const u = lerJson(arqUsuario);
  const servidores = u && u.mcpServers && typeof u.mcpServers === 'object' ? u.mcpServers : {};
  const descricao = {
    'codebase-memory': ['mapa do código', 'obrigatório em projeto médio ou grande: rode o instalador sem -SemMapa'],
    'apoio-local': ['Apoio Local', 'opcional: rode o instalador sem -SemApoio'],
    dart: ['servidor do Dart', 'só para projetos Flutter e Dart: instale o Dart 3.13 ou mais novo e rode o instalador'],
  };
  for (const [nome, [titulo, fazer]] of Object.entries(descricao)) {
    const s = servidores[nome];
    if (!s) { saida.push(item('info', `Servidor ${nome} (${titulo}) não registrado em ${barras(arqUsuario)}.`, fazer)); continue; }
    const cmd = typeof s.command === 'string' ? s.command : '';
    if (cmd && path.isAbsolute(cmd) && !existe(cmd)) {
      saida.push(item('aviso', `Servidor ${nome} registrado com um programa que não existe: ${barras(cmd)}.`, 'Rode o instalador da equipe de novo para registrar o caminho certo.'));
    } else {
      saida.push(item('ok', `Servidor ${nome} (${titulo}) registrado.`));
    }
  }
  const mapa = servidores['codebase-memory'];
  return mapa && typeof mapa.command === 'string' ? mapa.command : null;
}

function conferirConfigMapa(registrado, saida) {
  const programa = acharMapa({ registrado });
  if (!programa) return;
  const texto = rodarMapa(programa, ['config', 'list'], 2000);
  if (texto === null) {
    saida.push(item('info', 'Não consegui ler a configuração do mapa (codebase-memory-mcp config list).', 'Confira à mão: codebase-memory-mcp config list'));
    return;
  }
  const v = { ...PADRAO_MAPA, ...lerConfigMapa(texto) };
  const problemas = [];
  if (v.auto_index !== 'true') problemas.push('codebase-memory-mcp config set auto_index true');
  if (v.auto_watch === 'false') problemas.push('codebase-memory-mcp config set auto_watch true');
  if (problemas.length) {
    saida.push(item('aviso', 'Mapa sem indexação automática: o primeiro uso em cada projeto fica mais lento.', `Rode o instalador de novo (sem -SemAutoIndex) ou: ${problemas.join(' e ')}`));
  } else {
    saida.push(item('ok', `Mapa com indexação automática (auto_index true, limite ${v.auto_index_limit} arquivos).`));
  }
}

// Há algo da memória ainda não enviado (commit à frente, arquivo fora de commit ou ramo
// que nunca foi enviado)? Mesma regra do equipe-memoria.mjs.
function conferirEnvioMemoria(clone, saida) {
  const st = git(['status', '--porcelain', '-b'], clone);
  if (st === null) {
    saida.push(item('info', `Não consegui conferir o envio da memória em ${barras(clone)} (git status).`));
    return;
  }
  const linhas = st.split('\n');
  const cabeca = linhas[0] || '';
  const sujo = linhas.slice(1).some((l) => l.trim());
  const nunca = /^## /.test(cabeca) && !cabeca.includes('...') && !/No commits yet|Initial commit/i.test(cabeca);
  if (/\[ahead /.test(cabeca) || sujo || nunca) {
    saida.push(item('aviso', `O último envio da memória não saiu: ${barras(clone)} tem mudança que não chegou ao GitHub.`, `Confira o login do git e a rede e rode: git -C "${barras(clone)}" push (o próximo fim de sessão também tenta de novo).`));
  } else {
    saida.push(item('ok', `Memória entre computadores em dia (${barras(clone)}).`));
  }
}

function conferirVersao(saida) {
  const v = versaoDaEquipe({ semRede: true });
  if (!v) {
    saida.push(item('info', 'Versão instalada desconhecida (sem equipe-versao.json, ou a pasta da equipe não é um clone do git).', 'Instale pela linha de instalação do README para receber o aviso de versão nova.'));
    return;
  }
  if (!v.remota) {
    saida.push(item('info', `Versão instalada ${v.instalada.slice(0, 7)}; a do GitHub ainda não foi buscada (o boletim busca uma vez por dia).`));
  } else if (v.atrasada) {
    saida.push(item('aviso', `Há versão nova da equipe no GitHub (instalada ${v.instalada.slice(0, 7)}, disponível ${v.remota.slice(0, 7)}).`, 'Rode de novo a linha de instalação do README.'));
  } else {
    saida.push(item('ok', `Versão da equipe em dia com o GitHub (${v.instalada.slice(0, 7)}).`));
  }
}

// ---------- Travas vivas ----------

// Fim do registro das travas (só o pedaço final de cada mês: rápido mesmo com arquivo grande).
function linhasRecentes(pasta, desdeMs) {
  const diario = path.join(pasta, 'equipe-diario');
  const meses = new Set([new Date().toISOString().slice(0, 7), new Date(desdeMs).toISOString().slice(0, 7)]);
  const linhas = [];
  for (const mes of meses) {
    const arq = path.join(diario, `travas-${mes}.log`);
    let fd;
    try {
      const tam = fs.statSync(arq).size;
      const ler = Math.min(tam, 256 * 1024);
      const buf = Buffer.alloc(ler);
      fd = fs.openSync(arq, 'r');
      fs.readSync(fd, buf, 0, ler, tam - ler);
      for (const l of buf.toString('utf8').split('\n')) {
        const c = l.split('\t');
        if (c.length >= 6 && Date.parse(c[0]) >= desdeMs) linhas.push(c);
      }
    } catch { /* sem registro deste mês */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* fechado */ } }
  }
  return linhas;
}

// Sessões gravadas nesta pasta do Claude depois de uma data (para no limite).
function sessoesDesde(pasta, desdeMs, limite) {
  let n = 0;
  const projetos = path.join(pasta, 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(projetos, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return 0; }
  for (const d of dirs) {
    let nomes = [];
    try { nomes = fs.readdirSync(path.join(projetos, d.name)); } catch { continue; }
    for (const x of nomes) {
      if (!x.endsWith('.jsonl')) continue;
      try { if (fs.statSync(path.join(projetos, d.name, x)).mtimeMs >= desdeMs && ++n >= limite) return n; } catch { /* sumiu */ }
    }
  }
  return n;
}

// As travas estão de fato rodando? Dois sinais no registro dos últimos 3 dias:
// - houve sessões, mas nenhum hook registrou nada: os hooks não estão rodando;
// - houve fim de subagente, mas nenhum veio com o tipo do agente: o Claude Code não manda
//   o tipo aos hooks, e as travas de cada agente (e o orçamento do mestre) ficam sem saber
//   quem chamou.
function conferirTravasVivas(pasta, saida, hooksRegistrados) {
  if (!hooksRegistrados) return;
  const desde = Date.now() - 3 * 86400000;
  const linhas = linhasRecentes(pasta, desde);
  if (!linhas.length) {
    if (sessoesDesde(pasta, desde, 3) >= 3) {
      saida.push(item('aviso', 'Os hooks da equipe não registraram nada nos últimos 3 dias, mas houve sessões: eles podem não estar rodando.', `Rode node ${barras(path.join(pasta, 'hooks', 'equipe-diagnostico.mjs'))} e confira as linhas de hooks; se estiverem certas, rode a linha de instalação de novo.`));
    }
    return;
  }
  const fins = linhas.filter((c) => c[1] === 'eventos' && c[2] === 'SubagentStop');
  if (fins.length >= 3 && fins.every((c) => c[4] === 'mestre')) {
    saida.push(item('aviso', 'O Claude Code não está mandando aos hooks o tipo do agente: as travas do Explore, do revisor e do implementador e o orçamento do mestre não sabem quem chamou.', 'Atualize o app do Claude (a versão 2.1.69 ou mais nova manda o tipo do agente).'));
    return;
  }
  saida.push(item('ok', `Travas rodando: ${linhas.length} decisões registradas nos últimos 3 dias.`));
}

// ---------- Modos ----------

// Só arquivos: hooks, agentes, aviso e configuração da memória. Sem a equipe instalada
// (nenhum hook nem agente dela), não há o que conferir.
export function diagnosticoRapido(pasta = pastaClaude()) {
  try {
    const saida = [];
    const s = lerTexto(path.join(pasta, 'settings.json'));
    const temAgente = Object.keys(AGENTES_RESERVA).some((n) => existe(path.join(pasta, 'agents', `${n}.md`)));
    if (s === null && !temAgente) return [];
    const total = conferirHooks(pasta, saida);
    if (!total && !temAgente) return [];
    conferirAgentes(pasta, saida);
    conferirTravasVivas(pasta, saida, total);
    conferirAviso(pasta, saida);
    conferirMemoria(pasta, saida);
    return saida.filter((i) => i.nivel === 'erro' || i.nivel === 'aviso');
  } catch {
    return [];
  }
}

// Uma linha para o boletim, ou '' se está tudo certo.
export function resumoRapido(pasta = pastaClaude()) {
  const p = diagnosticoRapido(pasta);
  if (!p.length) return '';
  const primeiro = p.find((i) => i.nivel === 'erro') || p[0];
  const mais = p.length > 1 ? ` (e mais ${p.length - 1})` : '';
  return `Instalação da equipe com problema: ${primeiro.texto.replace(/[.:]\s*$/, '')}${mais}; rode node ${barras(path.join(pasta, 'hooks', 'equipe-diagnostico.mjs'))}`;
}

export function diagnosticoCompleto({ pasta = pastaClaude(), claudeJson = '' } = {}) {
  const saida = [];
  const total = conferirHooks(pasta, saida);
  conferirAgentes(pasta, saida);
  conferirTravasVivas(pasta, saida, total);
  const registrado = conferirServidores(claudeJson || arquivoUsuario(pasta), saida);
  conferirConfigMapa(registrado, saida);
  conferirAviso(pasta, saida);
  const clone = conferirMemoria(pasta, saida);
  if (clone) conferirEnvioMemoria(clone, saida);
  conferirVersao(saida);
  return saida;
}

const ROTULO = { erro: 'ERRO ', aviso: 'aviso', info: 'info ', ok: 'ok   ' };

export function textoDoDiagnostico(itens, pasta = pastaClaude()) {
  const l = [`Diagnóstico da equipe (${barras(pasta)}):`];
  for (const i of itens) {
    l.push(`  ${ROTULO[i.nivel] || i.nivel} ${i.texto}`);
    if (i.fazer && i.nivel !== 'ok') l.push(`        O que fazer: ${i.fazer}`);
  }
  const erros = itens.filter((i) => i.nivel === 'erro').length;
  const avisos = itens.filter((i) => i.nivel === 'aviso').length;
  l.push(erros || avisos ? `  Resumo: ${erros} erro(s) e ${avisos} aviso(s).` : '  Resumo: tudo certo.');
  return l.join('\n');
}

function principal() {
  const i = process.argv.indexOf('--claude-json');
  const claudeJson = i > 0 ? process.argv[i + 1] || '' : '';
  const pasta = pastaClaude();
  const itens = diagnosticoCompleto({ pasta, claudeJson });
  process.stdout.write(`${textoDoDiagnostico(itens, pasta)}\n`);
  process.exitCode = itens.some((x) => x.nivel === 'erro') ? 1 : 0;
}

const real = (p) => {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch { /* fica o caminho dado */ }
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) principal();
