#!/usr/bin/env node
// Testes de comportamento: roda o Claude Code de verdade (modo sem tela, com a sua conta)
// em tarefas fixas, num projeto de exemplo criado numa pasta temporária, e confere na
// transcrição se a equipe fez o que deve: delegar a busca, ler por trecho, não gravar
// segredo, não aplicar no banco sem OK, terminar a tarefa sem pedir licença à toa, usar o
// mapa do código, esclarecer pedido vago, respeitar o escopo, revisar mudança grande,
// consertar teste quebrado e erro do analisador, não pôr chave em commit e não ler código
// demais no mestre.
//
// Gasta um pouco do limite da assinatura (algo como 15 a 40 minutos de uso ao todo).
// Uso, na pasta da equipe:
//   node testes/comportamento/rodar.mjs              todas as tarefas
//   node testes/comportamento/rodar.mjs --so segredo  só as que têm "segredo" no nome
//   node testes/comportamento/rodar.mjs --manter      não apaga as pastas temporárias
// Precisa do Claude Code de linha de comando (claude) logado na sua conta. Se ele não
// estiver no PATH, passe o caminho em CLAUDE_BIN.
//
// Comparar duas versões da equipe (A/B):
//   --config <pasta>   roda o claude com CLAUDE_CONFIG_DIR=<pasta>. Instale nela a versão
//                      a testar com: instalar.ps1 -Destino <pasta>
//   --rotulo <nome>    nome curto que vai no arquivo de resultado (letras, números, . _ -)
//   --comparar <a.json> <b.json>   mostra o que mudou entre dois resultados, tarefa por
//                      tarefa e checagem por checagem (ok → FALHA, FALHA → ok), e os totais.
//                      Não roda o claude.
// A pasta de --config precisa de login próprio, uma vez só. No PowerShell:
//   $env:CLAUDE_CONFIG_DIR = '<pasta>'; claude      e, dentro dele, /login
// (no bash: CLAUDE_CONFIG_DIR=<pasta> claude). Nunca copie arquivos de credencial de uma
// pasta para outra: entre com /login.
//
// Calibrar o esforço dos subagentes (só junto com --config, nunca na sua pasta de verdade):
//   --esforco Explore=medium,implementador=medium
// troca a linha "effort:" de <pasta>/agents/<Agente>.md antes de rodar e devolve o arquivo
// original no fim, mesmo se der erro ou se você interromper.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AVALIACOES, conferir, criarContexto, criarProjeto, lerSessao, prepararTarefa } from './avaliacoes.mjs';
import { pastaClaude, pastaDiario } from '../../hooks/equipe-comum.mjs';

const LIMITE_MS = 15 * 60000;
const NIVEIS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// ---------- argumentos ----------
// { filtro, manter, config, rotulo, esforco: { Agente: nivel } | null, comparar: [a, b] | null, erro }
export function lerArgs(argv) {
  const r = { filtro: '', manter: false, config: null, rotulo: '', esforco: null, comparar: null, erro: null };
  const falha = (texto) => { if (!r.erro) r.erro = texto; };
  const valor = (i, nome) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) { falha(`faltou o valor de ${nome}`); return null; }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manter') r.manter = true;
    else if (a === '--so') { r.filtro = valor(i, a) ?? ''; i++; }
    else if (a === '--config') { r.config = valor(i, a); i++; }
    else if (a === '--rotulo') { r.rotulo = valor(i, a) ?? ''; i++; }
    else if (a === '--esforco') { const v = valor(i, a); i++; if (v !== null) r.esforco = lerEsforco(v, falha); }
    else if (a === '--comparar') {
      const x = argv[i + 1], y = argv[i + 2];
      if (!x || !y || x.startsWith('--') || y.startsWith('--')) falha('--comparar precisa de dois arquivos de resultado');
      else r.comparar = [x, y];
      i += 2;
    } else falha(`opção desconhecida: ${a}`);
  }
  if (r.rotulo && !/^[A-Za-z0-9._-]{1,40}$/.test(r.rotulo)) falha('o rótulo aceita só letras, números, ponto, _ e - (até 40)');
  if (r.esforco && !r.config) falha('--esforco só vale junto com --config: ele mexe nos agentes da pasta de teste, nunca na sua pasta de verdade');
  return r;
}

// "Explore=medium,implementador=high" → { Explore: 'medium', implementador: 'high' }.
export function lerEsforco(texto, falha = () => {}) {
  const mapa = {};
  for (const par of String(texto).split(',').map((p) => p.trim()).filter(Boolean)) {
    const [nome, nivel, ...resto] = par.split('=').map((p) => p.trim());
    if (resto.length || !/^[A-Za-z][\w-]*$/.test(nome || '') || !NIVEIS.has(nivel)) {
      falha(`--esforco inválido em "${par}": use Agente=nível, com nível ${[...NIVEIS].join(', ')}`);
      return null;
    }
    mapa[nome] = nivel;
  }
  if (!Object.keys(mapa).length) { falha('--esforco vazio'); return null; }
  return mapa;
}

// ---------- pasta de teste e esforço dos agentes ----------
const real = (p) => { try { return fs.realpathSync(path.resolve(p)); } catch { return path.resolve(p); } };
const mesmaPasta = (a, b) => {
  const x = real(a), y = real(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

// Texto do erro, ou null. A pasta de teste não pode ser a sua pasta de verdade do Claude.
export function conferirPastaDeTeste(config, ambiente = process.env) {
  if (!fs.existsSync(config) || !fs.statSync(config).isDirectory()) return `a pasta de --config não existe: ${config}`;
  const verdadeiras = [path.join(os.homedir(), '.claude'), ambiente.CLAUDE_CONFIG_DIR].filter(Boolean);
  if (verdadeiras.some((v) => mesmaPasta(config, v))) return 'a pasta de --config é a sua pasta de verdade do Claude; use uma pasta só de teste (instalar.ps1 -Destino <pasta>)';
  return null;
}

// Troca a linha "effort:" do cabeçalho de cada agente (ou acrescenta, se não houver) e
// devolve a função que põe os arquivos originais de volta. Confere tudo antes de gravar.
export function aplicarEsforco(config, mapa) {
  const trocas = [];
  for (const [nome, nivel] of Object.entries(mapa)) {
    const arq = path.join(config, 'agents', `${nome}.md`);
    if (!fs.existsSync(arq)) throw new Error(`não achei o agente ${nome} em ${path.join(config, 'agents')}`);
    const original = fs.readFileSync(arq, 'utf8');
    const m = /^(---\r?\n)([\s\S]*?)(\r?\n---(\r?\n|$))/.exec(original);
    if (!m) throw new Error(`o agente ${nome} não tem cabeçalho (---)`);
    const fim = m[1].endsWith('\r\n') ? '\r\n' : '\n';
    const cabecalho = /^effort:.*$/m.test(m[2]) ? m[2].replace(/^effort:.*$/m, `effort: ${nivel}`) : `${m[2]}${fim}effort: ${nivel}`;
    trocas.push({ arq, original, novo: m[1] + cabecalho + m[3] + original.slice(m[0].length) });
  }
  let devolvido = false;
  const restaurar = () => {
    if (devolvido) return;
    devolvido = true;
    for (const t of trocas) { try { fs.writeFileSync(t.arq, t.original); } catch { /* segue para os outros */ } }
  };
  try { for (const t of trocas) fs.writeFileSync(t.arq, t.novo); } catch (e) { restaurar(); throw e; }
  return restaurar;
}

// ---------- comparação de dois resultados ----------
const situacao = (r) => (r ? (r.erro ? 'ERRO' : r.pulada ? 'pulada' : 'rodou') : 'ausente');
const placar = (d) => {
  const todas = (d.resultados || []).flatMap((r) => r.checagens || []);
  return { certas: todas.filter((c) => c.ok).length, total: todas.length };
};
const nomeDe = (d, arq) => `${d.rotulo || path.basename(arq || '')}${d.config ? ` (config ${d.config})` : ''}`;

// { linhas, melhoraram, pioraram } entre o resultado a (antes) e b (depois).
export function compararResultados(a, b, arqA = 'A', arqB = 'B') {
  const linhas = [];
  let melhoraram = 0, pioraram = 0;
  const pa = placar(a), pb = placar(b);
  linhas.push(`A: ${nomeDe(a, arqA)}: ${pa.certas} de ${pa.total} checagens certas`);
  linhas.push(`B: ${nomeDe(b, arqB)}: ${pb.certas} de ${pb.total} checagens certas`);
  const porNome = (d) => new Map((d.resultados || []).map((r) => [r.nome, r]));
  const ma = porNome(a), mb = porNome(b);
  const nomes = [...new Set([...ma.keys(), ...mb.keys()])];
  for (const nome of nomes) {
    const ra = ma.get(nome), rb = mb.get(nome);
    const difs = [];
    if (situacao(ra) !== situacao(rb)) difs.push(`    ${situacao(ra)} → ${situacao(rb)}`);
    const ca = new Map(((ra && ra.checagens) || []).map((c) => [c.nome, c]));
    const cb = new Map(((rb && rb.checagens) || []).map((c) => [c.nome, c]));
    for (const c of [...new Set([...ca.keys(), ...cb.keys()])]) {
      const x = ca.get(c), y = cb.get(c);
      if (x && y && x.ok !== y.ok) {
        if (y.ok) melhoraram++; else pioraram++;
        difs.push(`    ${x.ok ? 'ok' : 'FALHA'} → ${y.ok ? 'ok' : 'FALHA'}  ${c} (${y.detalhe})`);
      } else if (x && !y && situacao(rb) === 'rodou') difs.push(`    só em A: ${c}`);
      else if (!x && y && situacao(ra) === 'rodou') difs.push(`    só em B: ${c}`);
    }
    if (difs.length) linhas.push(`- ${nome}`, ...difs);
  }
  if (linhas.length === 2) linhas.push('Nenhuma diferença nas checagens.');
  linhas.push(`Totais: A ${pa.certas}/${pa.total}, B ${pb.certas}/${pb.total}. Melhoraram ${melhoraram}, pioraram ${pioraram}.`);
  return { linhas, melhoraram, pioraram };
}

// ---------- decisões das travas no período da tarefa ----------
// Lê <pasta>/travas-AAAA-MM.log (data, trava, decisão, ms, tipo, chave) e conta
// "trava decisão" entre inicio e fim (milissegundos).
export function resumirTravas(pasta, inicio, fim) {
  const contagem = {};
  let nomes = [];
  try { nomes = fs.readdirSync(pasta).filter((n) => /^travas-\d{4}-\d{2}\.log$/.test(n)); } catch { return contagem; }
  for (const n of nomes) {
    let texto = '';
    try { texto = fs.readFileSync(path.join(pasta, n), 'utf8'); } catch { continue; }
    for (const l of texto.split('\n')) {
      const [data, trava, decisao] = l.split('\t');
      const t = Date.parse(data);
      if (!trava || Number.isNaN(t) || t < inicio || t > fim) continue;
      const chave = `${trava} ${decisao || ''}`.trim();
      contagem[chave] = (contagem[chave] || 0) + 1;
    }
  }
  return contagem;
}

// ---------- execução ----------
function acharClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
  const achado = r.status === 0 ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  return achado.find((p) => /\.(cmd|exe)$/i.test(p)) || achado[0] || null;
}

const git = (a, cwd) => spawnSync('git', a, { cwd, encoding: 'utf8' });

// Chave service_role falsa, montada na hora (nada de chave inteira no repositório).
function chaveFalsa() {
  const parte = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return [parte({ alg: 'HS256', typ: 'JWT' }), parte({ iss: 'supabase', ref: 'lojaexemplo', role: 'service' + '_role', iat: 1767225600 }), 'Q'.repeat(43)].join('.');
}

function sessaoDoClaude(pastaCfg, cwd, id) {
  const projetos = path.join(pastaCfg, 'projects');
  const direto = path.join(projetos, fs.realpathSync.native(cwd).replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`);
  if (fs.existsSync(direto)) return direto;
  if (!fs.existsSync(projetos)) return null;
  for (const d of fs.readdirSync(projetos)) {
    const a = path.join(projetos, d, `${id}.jsonl`);
    if (fs.existsSync(a)) return a;
  }
  return null;
}

function rodarUma(claude, av, opcoes) {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), `equipe-comportamento-${av.nome}-`));
  const gitOuErro = (a, cwd) => { const r = git(a, cwd); if (r.status !== 0) throw new Error(`git ${a.find((x) => !x.startsWith('-') && !x.includes('=')) || a[0]} falhou`); return r.stdout; };
  const chave = chaveFalsa();
  criarProjeto(pasta, gitOuErro);
  prepararTarefa(av, pasta, { chave, git: gitOuErro });
  const base = gitOuErro(['rev-parse', 'HEAD'], pasta).trim();
  const pedido = av.pedido.replace('{{CHAVE_SERVICE_ROLE}}', chave);
  const inicio = Date.now();
  // O pedido vai pela entrada padrão: os argumentos são fixos (seguro com shell no Windows).
  const comShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(claude);
  // Com --config, o claude usa a pasta de teste (e os hooks dela gravam no diário dela).
  const env = { ...process.env };
  if (opcoes.config) { env.CLAUDE_CONFIG_DIR = path.resolve(opcoes.config); delete env.EQUIPE_PASTA_CLAUDE; }
  // Com shell (o .cmd do npm no Windows), o caminho vai entre aspas por causa dos espaços.
  const r = spawnSync(comShell ? `"${claude}"` : claude, ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'], {
    cwd: pasta, input: pedido, encoding: 'utf8', timeout: LIMITE_MS, maxBuffer: 256 * 1024 * 1024,
    shell: comShell, env,
  });
  const eventos = (r.stdout || '').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = eventos.find((e) => e.type === 'system' && e.subtype === 'init') || {};
  const temMapa = Array.isArray(init.tools) && init.tools.some((t) => String(t).startsWith('mcp__codebase-memory__'));
  const resultado = { nome: av.nome, segundos: Math.round((Date.now() - inicio) / 1000), checagens: [] };
  const travas = resumirTravas(path.join(opcoes.pastaCfg, 'equipe-diario'), inicio, Date.now());
  if (Object.keys(travas).length) resultado.travas = travas;
  if (av.soComMapa && !temMapa) { resultado.pulada = 'o mapa do código não está nesta instalação'; return { resultado, pasta }; }
  const arq = init.session_id ? sessaoDoClaude(opcoes.pastaCfg, pasta, init.session_id) : null;
  if (!arq) {
    resultado.erro = r.error ? `o claude não rodou (${r.error.code || r.error.message})` : 'não achei a transcrição da sessão';
    return { resultado, pasta };
  }
  resultado.checagens = conferir(av, lerSessao(arq), criarContexto(pasta, { chave, base }));
  return { resultado, pasta };
}

function comparar([arqA, arqB]) {
  const ler = (arq) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch (e) { console.log(`Não consegui ler ${arq}: ${e.message}`); process.exit(2); } };
  const { linhas } = compararResultados(ler(arqA), ler(arqB), arqA, arqB);
  for (const l of linhas) console.log(l);
  process.exit(0);
}

function principal() {
  const args = lerArgs(process.argv.slice(2));
  if (args.erro) { console.log(`Opção errada: ${args.erro}. Veja o começo de testes/comportamento/rodar.mjs.`); process.exit(2); }
  if (args.comparar) return comparar(args.comparar);
  if (args.config) {
    const erro = conferirPastaDeTeste(args.config);
    if (erro) { console.log(`Não rodei: ${erro}.`); process.exit(2); }
  }
  const claude = acharClaude();
  if (!claude) {
    console.log('Não achei o Claude Code de linha de comando (claude).');
    console.log('Instale com: npm install -g @anthropic-ai/claude-code');
    console.log('Depois rode "claude" uma vez para entrar com a sua conta e rode este teste de novo.');
    process.exit(2);
  }
  const pastaCfg = args.config ? path.resolve(args.config) : pastaClaude();
  let restaurar = () => {};
  if (args.esforco) {
    try { restaurar = aplicarEsforco(pastaCfg, args.esforco); } catch (e) { console.log(`Não rodei: ${e.message}.`); process.exit(2); }
    // Devolve os agentes originais mesmo se o processo for interrompido.
    process.on('exit', restaurar);
    for (const sinal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sinal, () => { restaurar(); process.exit(130); });
    console.log(`Esforço trocado nesta rodada: ${Object.entries(args.esforco).map(([a, n]) => `${a}=${n}`).join(', ')}.`);
  }
  const lista = AVALIACOES.filter((a) => !args.filtro || a.nome.includes(args.filtro));
  console.log(`Testes de comportamento: ${lista.length} tarefa(s), com ${claude}${args.config ? ` e a pasta ${args.config}` : ''}. Cada uma leva alguns minutos.\n`);
  const resultados = [];
  try {
    for (const av of lista) {
      process.stdout.write(`- ${av.nome}... `);
      const { resultado, pasta } = rodarUma(claude, av, { config: args.config, pastaCfg });
      resultados.push(resultado);
      if (resultado.pulada) console.log(`pulada: ${resultado.pulada}`);
      else if (resultado.erro) console.log(`ERRO: ${resultado.erro}`);
      else {
        const falhas = resultado.checagens.filter((c) => !c.ok);
        console.log(falhas.length ? `FALHOU (${resultado.segundos} s)` : `ok (${resultado.segundos} s)`);
        for (const c of resultado.checagens) console.log(`    ${c.ok ? 'ok   ' : 'FALHA'} ${c.nome} (${c.detalhe})`);
      }
      if (resultado.travas) console.log(`    travas: ${Object.entries(resultado.travas).map(([k, n]) => `${k} ${n}`).join(', ')}`);
      if (args.manter) console.log(`    pasta: ${pasta}`);
      else fs.rmSync(pasta, { recursive: true, force: true });
    }
  } finally {
    restaurar();
  }
  const total = resultados.flatMap((r) => r.checagens);
  const certas = total.filter((c) => c.ok).length;
  console.log(`\n${certas} de ${total.length} checagens certas.`);
  fs.mkdirSync(pastaDiario(), { recursive: true });
  const marca = new Date().toISOString().replace(/[:.]/g, '-');
  const arq = path.join(pastaDiario(), `comportamento-${args.rotulo ? `${args.rotulo}-` : ''}${marca}.json`);
  const dados = { data: new Date().toISOString(), rotulo: args.rotulo || null, config: args.config || null, esforco: args.esforco, resultados };
  fs.writeFileSync(arq, JSON.stringify(dados, null, 2));
  console.log(`Resultado guardado em ${arq} (a /retro-equipe lê daqui; compare dois com --comparar).`);
  process.exit(certas === total.length && resultados.every((r) => !r.erro) ? 0 : 1);
}

if (process.argv[1] && real(process.argv[1]).toLowerCase() === real(fileURLToPath(import.meta.url)).toLowerCase()) principal();
