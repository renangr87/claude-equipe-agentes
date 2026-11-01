// Funções comuns aos scripts da equipe que rodam no computador do usuário:
// equipe-boletim.mjs (hook SessionStart), equipe-contexto.mjs (hook SubagentStart)
// e equipe-medir.mjs (medição para a /retro-equipe).
//
// Só biblioteca padrão do Node. Nenhuma função aqui lança erro para fora: um hook
// que quebra não pode atrapalhar a sessão, então tudo devolve null ou vazio.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Pasta de configuração do Claude Code. Instalado, o script fica em <pasta>/hooks/.
// EQUIPE_PASTA_CLAUDE existe para os testes.
export function pastaClaude() {
  if (process.env.EQUIPE_PASTA_CLAUDE) return process.env.EQUIPE_PASTA_CLAUDE;
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  const acima = path.dirname(aqui);
  if (path.basename(aqui) === 'hooks' &&
      (fs.existsSync(path.join(acima, 'settings.json')) || fs.existsSync(path.join(acima, 'projects')))) {
    return acima;
  }
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function pastaDiario() {
  return path.join(pastaClaude(), 'equipe-diario');
}

// Entrada JSON do hook (stdin). Vazia ou inválida: objeto vazio.
export function lerEntrada() {
  try {
    let texto = fs.readFileSync(0, 'utf8');
    if (texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1);
    return texto.trim() ? JSON.parse(texto) : {};
  } catch {
    return {};
  }
}

// Orçamento de tempo do processo inteiro: o hook tem 15 segundos no settings.json, e
// os comandos do git não podem somar mais que isto. Acabou o tempo, o git devolve null
// e o hook sai com o que já tem (ou em silêncio).
const ORCAMENTO_MS = Number(process.env.EQUIPE_ORCAMENTO_MS) || 5000;
const INICIO = Date.now();

// --no-optional-locks: o status não pega a trava do índice, então não atrapalha um
// git add ou commit que esteja rodando ao mesmo tempo.
export function git(args, cwd, limite = 3000) {
  const resta = ORCAMENTO_MS - (Date.now() - INICIO);
  if (resta < 100) return null;
  try {
    return execFileSync('git', ['--no-optional-locks', ...args], {
      cwd, encoding: 'utf8', timeout: Math.min(limite, resta), windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    }).replace(/\r?\n$/, '');
  } catch {
    return null;
  }
}

export function lerTexto(arquivo) {
  try {
    let t = fs.readFileSync(arquivo, 'utf8');
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return t;
  } catch {
    return null;
  }
}

export function lerJson(arquivo) {
  const t = lerTexto(arquivo);
  if (t === null) return null;
  try { return JSON.parse(t); } catch { return null; }
}

// Caminho real: no Windows o mesmo lugar pode vir com nome curto (RUNNER~1) de um lado e
// longo do outro, ou por uma junção; compara depois de resolver.
const canonico = (p) => {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
};
// Caminho real de um arquivo que talvez não exista mais: o da pasta existente mais próxima,
// com o resto do caminho por cima. É o que o git devolve (nome longo, sem atalho).
export function caminhoReal(p) {
  const absoluto = path.resolve(String(p || '.'));
  let pasta = absoluto;
  const resto = [];
  for (let i = 0; i < 100; i++) {
    try { return path.join(fs.realpathSync.native(pasta), ...resto.reverse()); } catch { /* sobe */ }
    const acima = path.dirname(pasta);
    if (acima === pasta) break;
    resto.push(path.basename(pasta));
    pasta = acima;
  }
  return absoluto;
}
const mesmoCaminho = (a, b) => {
  const n = (p) => canonico(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};
const dentroDe = (filho, pai) => {
  const baixo = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = path.relative(baixo(canonico(pai)), baixo(canonico(filho)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// Extensões contadas como código (scripts e infraestrutura contam, como diz a regra).
const EXT_CODIGO = new Set([
  'dart', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'py', 'go', 'rs', 'java', 'kt', 'kts',
  'swift', 'm', 'mm', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'fs', 'rb', 'php', 'sql', 'ps1', 'psm1', 'sh',
  'bash', 'lua', 'scala', 'ex', 'exs', 'erl', 'clj', 'tf', 'hcl', 'gradle',
]);
// Código gerado não conta: o mapa e a regra falam do código escrito pelas pessoas.
const GERADO = /\.(g|freezed|mocks|pb|pbenum|pbjson|pbserver|gr|config)\.dart$|\.min\.js$|\.d\.ts$/;
const PASTA_IGNORADA = /(^|\/)(node_modules|vendor|build|dist|\.dart_tool|Pods|\.gradle|coverage)\//;
// Manifestos de módulo: cada pasta com um deles é um módulo (app, backend, pacote).
const MANIFESTO = /(^|\/)(pubspec\.yaml|package\.json|pyproject\.toml|go\.mod|Cargo\.toml|composer\.json|Gemfile|[^/]+\.csproj|supabase\/config\.toml)$/;
// Pastas de exemplo e de modelo: nem módulo do produto nem nota de área.
const PASTA_EXEMPLO = /(^|\/)(example|examples|exemplo|exemplos|template|templates|modelo|modelos|test|tests|fixtures)(\/|$)/;
// "<texto a preencher>" de um modelo que ainda não foi preenchido.
const MARCA_MODELO = /<[^<>\n`]*\s[^<>\n`]*>/;

// Pasta do projeto da sessão: a do CLAUDE_PROJECT_DIR, se estiver dentro do repositório
// da pasta atual (sessão aberta numa subpasta); senão, a raiz desse repositório (um
// worktree, por exemplo, é ele mesmo).
function pastaDoProjeto(raizGit) {
  const proj = process.env.CLAUDE_PROJECT_DIR;
  if (proj && fs.existsSync(proj) && dentroDe(proj, raizGit)) return path.resolve(proj);
  return raizGit;
}

// Mesma regra da guarda (perfil verificador): vale a lista do repositório da pasta atual,
// se ela estiver no git e for o mesmo projeto da sessão (worktree incluído); senão, a da
// pasta do projeto da sessão. "Em commit" quer dizer o que a guarda confere: o git status
// não mostra mudança no arquivo.
function listaDoVerificador(cwd, raizGit) {
  let pasta = null;
  if (raizGit) {
    let mesmoProjeto = true;
    const proj = process.env.CLAUDE_PROJECT_DIR;
    if (proj) {
      const comum = (dir) => {
        const c = git(['rev-parse', '--git-common-dir'], dir);
        return c ? path.resolve(dir, c) : null;
      };
      const a = comum(raizGit);
      const b = fs.existsSync(proj) ? comum(proj) : null;
      mesmoProjeto = Boolean(a && b && mesmoCaminho(a, b));
    }
    if (mesmoProjeto && git(['ls-files', '--error-unmatch', '--', '.claude/verificador-comandos.txt'], raizGit) !== null) {
      pasta = raizGit;
    }
  }
  if (!pasta) pasta = process.env.CLAUDE_PROJECT_DIR || cwd;
  const texto = lerTexto(path.join(pasta, '.claude', 'verificador-comandos.txt'));
  if (texto === null) return { comandos: null, emCommit: false };
  const comandos = texto.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l && !l.startsWith('#'));
  const mudanca = git(['status', '--porcelain', '--', '.claude/verificador-comandos.txt'], pasta);
  // Como a guarda: sem resposta do git, ela não bloqueia.
  return { comandos, emCommit: mudanca === null || mudanca === '' };
}

// CLAUDE.md que valem para a pasta do projeto, do mais próximo ao mais distante (o
// Claude Code carrega os das pastas acima também), parando na raiz do repositório.
function claudeMds(pastaProjeto, raizGit) {
  const achados = [];
  let atual = pastaProjeto;
  for (let i = 0; i < 20; i++) {
    const t = lerTexto(path.join(atual, 'CLAUDE.md'));
    if (t !== null) achados.push(t);
    if (mesmoCaminho(atual, raizGit)) break;
    const acima = path.dirname(atual);
    if (acima === atual) break;
    atual = acima;
  }
  return achados;
}

// Fatos do projeto em que o hook rodou. null se a pasta não está num repositório git.
export function fatosDoProjeto(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const raizGit = git(['rev-parse', '--show-toplevel'], cwd);
  if (!raizGit) return null;
  const raiz = pastaDoProjeto(raizGit);

  // Só o que está no git: rápido mesmo em repositório grande. Projeto sem nenhum commit
  // ainda: os arquivos novos, com pouco tempo.
  let lista = git(['ls-files', '-z'], raiz, 4000);
  if (lista === '') lista = git(['ls-files', '-z', '--others', '--exclude-standard'], raiz, 1500);
  const arquivos = lista ? lista.split('\0').filter(Boolean) : [];

  let codigo = 0;
  const modulos = new Set();
  const candidatasNota = [];
  for (const a of arquivos) {
    if (PASTA_IGNORADA.test(a)) continue;
    const ext = a.includes('.') ? a.slice(a.lastIndexOf('.') + 1).toLowerCase() : '';
    if (EXT_CODIGO.has(ext) && !GERADO.test(a)) codigo++;
    const m = a.match(MANIFESTO);
    if (m) {
      const nome = m[2];
      let pasta = a.slice(0, a.length - nome.length).replace(/\/$/, '');
      // A pasta supabase/ conta como módulo próprio (o backend), mesmo dentro de outra.
      if (nome === 'supabase/config.toml') pasta = pasta ? `${pasta}/supabase` : 'supabase';
      modulos.add(pasta || '.');
    }
    if (/(^|\/)CLAUDE\.md$/.test(a) && a !== 'CLAUDE.md' && !a.startsWith('.claude/') && !PASTA_EXEMPLO.test(a)) candidatasNota.push(a);
  }
  const modulosReais = [...modulos].filter((m) => !PASTA_EXEMPLO.test(m)).sort();
  // Nota que ainda é modelo (com "<texto a preencher>") não é nota de área.
  const notas = candidatasNota.slice(0, 60).filter((n) => {
    const t = lerTexto(path.join(raiz, n));
    return t !== null && !MARCA_MODELO.test(t.replace(/`[^`]*`/g, ''));
  }).sort();

  const mds = claudeMds(raiz, raizGit);
  const configurado = mds.some((t) => /^##\s*Comandos/im.test(t) && !/<comando/.test(t));
  let regras = null;
  for (const t of mds) {
    regras = secao(t, 'Regras deste projeto');
    if (regras) break;
  }
  const lista2 = listaDoVerificador(cwd, raizGit);

  return {
    raiz,
    codigo,
    modulos: modulosReais,
    mapaObrigatorio: codigo > 50 || modulosReais.length > 1,
    notas,
    claudeMd: mds.length > 0,
    configurado,
    regras,
    comandos: lista2.comandos,
    listaEmCommit: lista2.emCommit,
    plano: lerPlano(raiz),
  };
}

// Texto de uma seção "## Título" de um Markdown, sem o título, até a próxima seção de
// mesmo nível. Limitado para o contexto não crescer.
export function secao(texto, titulo, maxLinhas = 30) {
  if (!texto) return null;
  const linhas = texto.split(/\r?\n/);
  const alvo = titulo.toLowerCase();
  const inicio = linhas.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, '').trim().toLowerCase() === alvo);
  if (inicio < 0) return null;
  const corpo = [];
  for (let i = inicio + 1; i < linhas.length; i++) {
    if (/^##?\s+/.test(linhas[i])) break;
    corpo.push(linhas[i]);
  }
  // Linhas que ainda são do modelo (com "<texto a preencher>") não valem como regra.
  const preenchidas = corpo.filter((l) => !MARCA_MODELO.test(l.replace(/`[^`]*`/g, '')));
  const limpo = preenchidas.join('\n').trim();
  if (!limpo) return null;
  const cortado = limpo.split('\n').slice(0, maxLinhas).join('\n');
  return cortado.length > 2500 ? cortado.slice(0, 2500) + ' [...]' : cortado;
}

// Plano em .revisao/plano.md: passos com caixa de marcar e idade do arquivo.
function lerPlano(raiz) {
  const arquivo = path.join(raiz, '.revisao', 'plano.md');
  const texto = lerTexto(arquivo);
  if (texto === null) return null;
  const feitos = (texto.match(/^\s*[-*]\s*\[[xX]\]/gm) || []).length;
  const abertos = (texto.match(/^\s*[-*]\s*\[ \]/gm) || []).length;
  // Itens da seção "Já tentado" (o que não funcionou e por quê): para não repetir.
  let jaTentado = 0;
  const linhasPlano = texto.split(/\r?\n/);
  const ini = linhasPlano.findIndex((l) => /^#{2,3}\s+j[aá] tentad[oa]s?\b/i.test(l));
  if (ini >= 0) {
    for (let i = ini + 1; i < linhasPlano.length && !/^#{1,3}\s/.test(linhasPlano[i]); i++) if (/^\s*[-*]\s+\S/.test(linhasPlano[i])) jaTentado++;
  }
  let dias = null;
  try { dias = Math.floor((Date.now() - fs.statSync(arquivo).mtimeMs) / 86400000); } catch { /* sem data */ }
  return { feitos, abertos, dias, jaTentado };
}

// Versão instalada da equipe e se o GitHub tem uma mais nova. Não usa a rede aqui:
// compara com o último fetch e, se a última tentativa tiver mais de 20 horas, dispara
// outra em segundo plano (o resultado aparece no boletim seguinte).
export function versaoDaEquipe({ semRede = false } = {}) {
  const info = lerJson(path.join(pastaClaude(), 'equipe-versao.json'));
  if (!info || !info.commit || !info.pasta || !fs.existsSync(path.join(info.pasta, '.git'))) return null;
  const remoto = git(['rev-parse', '--verify', '-q', 'origin/main'], info.pasta);
  if (!semRede && !process.env.EQUIPE_SEM_REDE) buscarEmSegundoPlano(info.pasta);
  let atrasada = false;
  if (remoto && remoto !== info.commit) {
    // Só avisa se a instalada é ancestral da remota: commit local à frente não é atraso.
    const r = git(['merge-base', '--is-ancestor', info.commit, remoto], info.pasta);
    atrasada = r !== null;
  }
  return { instalada: info.commit, remota: remoto, atrasada, pasta: info.pasta };
}

// A marca da tentativa é gravada antes do fetch: sem rede, o FETCH_HEAD não muda, e
// sem a marca o fetch rodaria em toda sessão.
function buscarEmSegundoPlano(pasta) {
  const marca = path.join(pastaDiario(), 'ultimo-fetch.txt');
  const idade = (arquivo) => {
    try { return Date.now() - fs.statSync(arquivo).mtimeMs; } catch { return Infinity; }
  };
  if (Math.min(idade(marca), idade(path.join(pasta, '.git', 'FETCH_HEAD'))) < 20 * 3600 * 1000) return;
  try {
    fs.mkdirSync(path.dirname(marca), { recursive: true });
    fs.writeFileSync(marca, new Date().toISOString());
    const filho = spawn('git', ['-C', pasta, 'fetch', '-q', 'origin', 'main'], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    filho.on('error', () => {});
    filho.unref();
  } catch { /* sem git ou sem permissão: fica para a próxima */ }
}

// Sessões gravadas (arquivos .jsonl da sessão principal) depois de uma data.
export function sessoesDesde(desdeMs, limite = 20000) {
  const projetos = path.join(pastaClaude(), 'projects');
  let total = 0;
  let pastas = [];
  try { pastas = fs.readdirSync(projetos, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return 0; }
  for (const p of pastas) {
    let nomes = [];
    try { nomes = fs.readdirSync(path.join(projetos, p.name)); } catch { continue; }
    for (const n of nomes) {
      if (!n.endsWith('.jsonl')) continue;
      try {
        if (fs.statSync(path.join(projetos, p.name, n)).mtimeMs >= desdeMs) total++;
      } catch { /* sumiu */ }
      if (total >= limite) return total;
    }
  }
  return total;
}

export function saidaContexto(evento, texto) {
  if (!texto) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: evento, additionalContext: texto } }));
}

// ---------- Travas: registro, interruptor, estado por chamada e cache ----------

const limpo = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').slice(0, 80);

// Quem está chamando: o tipo do agente (o mestre não tem) e a chave da chamada, igual
// para todas as ferramentas da mesma chamada de subagente.
export function tipoDoAgente(entrada) {
  return String((entrada && entrada.agent_type) || '') || 'mestre';
}
export function chaveDaChamada(entrada) {
  const sessao = String((entrada && entrada.session_id) || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!sessao) return null;
  const agente = String((entrada && entrada.agent_id) || '').replace(/[^A-Za-z0-9_-]/g, '');
  return `${sessao}-${agente || 'mestre'}`;
}

// Registro das travas: uma linha por decisão, sem conteúdo (data, trava, decisão, tempo
// em ms, tipo de agente e chave da chamada). É por ele que a /retro-equipe vê falso
// positivo, fuga e lentidão. Arquivos com mais de 60 dias saem.
export function registrarTrava(trava, decisao, ms, entrada) {
  try {
    const pasta = pastaDiario();
    fs.mkdirSync(pasta, { recursive: true });
    const agora = new Date();
    const mes = agora.toISOString().slice(0, 7);
    const linha = [agora.toISOString(), limpo(trava), limpo(decisao), Math.max(0, Math.round(Number(ms) || 0)), limpo(tipoDoAgente(entrada)), limpo(chaveDaChamada(entrada) || '')].join('\t');
    fs.appendFileSync(path.join(pasta, `travas-${mes}.log`), `${linha}\n`);
    if (Math.random() < 0.02) {
      const limite = Date.now() - 60 * 86400000;
      for (const n of fs.readdirSync(pasta)) {
        if (!/^travas-\d{4}-\d{2}\.log$/.test(n)) continue;
        try { if (fs.statSync(path.join(pasta, n)).mtimeMs < limite) fs.unlinkSync(path.join(pasta, n)); } catch { /* segue */ }
      }
    }
  } catch { /* o registro nunca atrapalha */ }
}

// Interruptor de emergência das travas de economia e de retrabalho: EQUIPE_DESLIGAR com
// os nomes separados por vírgula (ou "tudo"), no bloco env do settings.json. As travas
// de segurança (banco, segredos, SQL) não desligam por aqui.
export const TRAVAS_DESLIGAVEIS = ['leitura', 'mapa', 'orcamento', 'briefing', 'convergencia', 'analisar', 'verificar', 'escopo', 'revisao'];
export function desligada(nome) {
  const lista = String(process.env.EQUIPE_DESLIGAR || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[\s,;]+/).filter(Boolean);
  if (!TRAVAS_DESLIGAVEIS.includes(nome)) return false;
  return lista.includes(nome) || lista.includes('tudo');
}

// Estado de uma chamada (marcas e anotações em arquivos pequenos, por chave da chamada).
// Anotar acrescenta no fim do arquivo: duas ferramentas ao mesmo tempo não se perdem.
function pastaEstado() {
  return path.join(pastaDiario(), 'estado');
}
const nomeEstado = (chave, nome) => path.join(pastaEstado(), `${String(chave).replace(/[^A-Za-z0-9_-]/g, '')}.${nome}`);

export function anotar(chave, nome, valor = '1') {
  if (!chave) return;
  try {
    fs.mkdirSync(pastaEstado(), { recursive: true });
    fs.appendFileSync(nomeEstado(chave, nome), `${String(valor).replace(/[\r\n]+/g, ' ')}\n`);
    if (Math.random() < 0.02) limparEstadoVelho();
  } catch { /* segue */ }
}
export function anotacoes(chave, nome) {
  if (!chave) return [];
  try { return fs.readFileSync(nomeEstado(chave, nome), 'utf8').split('\n').filter(Boolean); } catch { return []; }
}
export function gravarEstado(chave, nome, valor) {
  if (!chave) return;
  try {
    fs.mkdirSync(pastaEstado(), { recursive: true });
    fs.writeFileSync(nomeEstado(chave, nome), JSON.stringify(valor));
  } catch { /* segue */ }
}
export function lerEstado(chave, nome) {
  return chave ? lerJson(nomeEstado(chave, nome)) : null;
}
export function apagarEstado(chave, nome) {
  if (!chave) return;
  try { fs.rmSync(nomeEstado(chave, nome), { force: true }); } catch { /* segue */ }
}
// Fim da chamada: tudo o que foi anotado para ela sai (um agente retomado começa de novo).
export function limparChamada(chave, manter = []) {
  if (!chave) return;
  const prefixo = `${String(chave).replace(/[^A-Za-z0-9_-]/g, '')}.`;
  try {
    for (const n of fs.readdirSync(pastaEstado())) {
      if (n.startsWith(prefixo) && !manter.includes(n.slice(prefixo.length))) fs.rmSync(path.join(pastaEstado(), n), { force: true });
    }
  } catch { /* segue */ }
}
function limparEstadoVelho() {
  const limite = Date.now() - 3 * 86400000;
  for (const n of fs.readdirSync(pastaEstado())) {
    const arq = path.join(pastaEstado(), n);
    try { if (fs.statSync(arq).mtimeMs < limite) fs.unlinkSync(arq); } catch { /* segue */ }
  }
}

// Servidor MCP declarado para o projeto: no .mcp.json da raiz ou no .claude.json do
// usuário (geral ou do projeto).
export function servidorDeclarado(nome, raiz) {
  const tem = (servidores) => Boolean(servidores && typeof servidores === 'object' && servidores[nome]);
  if (raiz) {
    const mcp = lerJson(path.join(raiz, '.mcp.json'));
    if (mcp && tem(mcp.mcpServers)) return true;
  }
  const base = process.env.CLAUDE_CONFIG_DIR || os.homedir();
  const usuario = lerJson(path.join(base, '.claude.json'));
  if (!usuario) return false;
  if (tem(usuario.mcpServers)) return true;
  if (raiz && usuario.projects && typeof usuario.projects === 'object') {
    const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const alvo = norm(raiz);
    for (const [p, v] of Object.entries(usuario.projects)) {
      if (norm(p) === alvo && v && tem(v.mcpServers)) return true;
    }
  }
  return false;
}

// Fatos do projeto para as travas, guardados por 10 minutos: o git ls-files não roda a
// cada leitura. null fora de um repositório git.
const CACHE_MS = 10 * 60000;
export function fatosRapidos(cwd) {
  if (!cwd) return null;
  const chave = crypto.createHash('sha1').update(`${path.resolve(cwd)}|${process.env.CLAUDE_PROJECT_DIR || ''}`).digest('hex').slice(0, 16);
  const arq = path.join(pastaDiario(), 'cache', `${chave}.json`);
  const guardado = lerJson(arq);
  const listaMudou = (f) => {
    try { return Boolean(f && f.raiz) && fs.statSync(path.join(f.raiz, '.claude', 'verificador-comandos.txt')).mtimeMs > guardado.em; } catch { return false; }
  };
  if (guardado && typeof guardado.em === 'number' && Date.now() - guardado.em < CACHE_MS && !listaMudou(guardado.fatos)) return guardado.fatos;
  const f = fatosDoProjeto(cwd);
  const fatos = f ? {
    raiz: f.raiz,
    codigo: f.codigo,
    modulos: f.modulos,
    mapaObrigatorio: f.mapaObrigatorio,
    mapaDeclarado: servidorDeclarado('codebase-memory', f.raiz),
    comandos: f.comandos,
  } : null;
  try {
    fs.mkdirSync(path.dirname(arq), { recursive: true });
    fs.writeFileSync(arq, JSON.stringify({ em: Date.now(), fatos }));
  } catch { /* sem cache: roda de novo na próxima */ }
  return fatos;
}

// Arquivo de código (a mesma lista do tamanho do projeto). Gerado não conta.
export function ehCodigo(arquivo) {
  const a = String(arquivo || '').replace(/\\/g, '/');
  const nome = a.slice(a.lastIndexOf('/') + 1);
  if (!nome.includes('.')) return false;
  const ext = nome.slice(nome.lastIndexOf('.') + 1).toLowerCase();
  return EXT_CODIGO.has(ext) && !GERADO.test(a);
}
export const EXTENSOES_CODIGO = EXT_CODIGO;

// Texto sem acento e em minúsculas, para comparar rótulos e pedidos com tolerância.
export function normalizar(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Status do relatório de um subagente, pela palavra de status (o medidor e a trava de
// convergência leem do mesmo jeito). Relatório sem resultado nunca conta como sucesso.
export function statusDoRelatorio(tipo, texto) {
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
    // "passou" só com sinal de sucesso; relatório sem resultado não conta como sucesso.
    if (/\b(passou|passaram|passed|sucesso|tudo ok|ok)\b/i.test(t)) return 'passou';
    return 'sem status';
  }
  return '';
}
