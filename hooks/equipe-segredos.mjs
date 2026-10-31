#!/usr/bin/env node
// Hook PreToolUse da equipe: chave secreta não entra em arquivo do projeto nem em commit.
//
// Confere o texto que vai ser gravado (Write, Edit, MultiEdit, NotebookEdit) e, num
// "git commit", as linhas acrescentadas do que vai entrar no commit. Achou uma chave
// secreta conhecida (service_role do Supabase, sb_secret_, chaves da Anthropic, OpenAI,
// GitHub, AWS, Stripe, Slack, Telegram, chave privada, URL do Postgres com senha), barra e
// explica. A chave nunca aparece na mensagem. Chave pública (anon, publishable, a do
// Firebase no app) passa. Arquivo ignorado pelo git passa: ele não vai para o repositório.
// Erro vira silêncio: segue o fluxo normal.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lerEntrada } from './equipe-comum.mjs';

const PADROES = [
  ['chave secreta do Supabase (sb_secret_)', /\bsb_secret_[A-Za-z0-9_-]{20,}/],
  ['chave da Anthropic', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  // OpenAI: só com maiúscula e número no meio (classe CSS "sk-skeleton-..." não conta).
  ['chave da OpenAI', /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{40,}/],
  ['segredo OAuth do Google', /\bGOCSPX-[A-Za-z0-9_-]{20,}/],
  ['token do GitHub', /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ['chave da AWS', /\b(?:AKIA|ASIA)(?![0-9A-Z]{9}EXAMPLE\b)[0-9A-Z]{16}\b/],
  ['chave secreta do Stripe', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/],
  ['token do Slack', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['token de bot do Telegram', /\b\d{8,10}:AA[0-9A-Za-z_-]{33}\b/],
  ['chave privada', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/],
];
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g;
const POSTGRES = /\b(?:postgres(?:ql)?|mongodb(?:\+srv)?|mysql):\/\/[^:\s/@]+:([^@\s]+)@([^\s/:?'"]+)/gi;

// Nome do tipo de chave achado, ou null. Nunca devolve a chave.
export function acharSegredo(texto) {
  const t = String(texto || '');
  if (!t) return null;
  for (const [nome, re] of PADROES) if (re.test(t)) return nome;
  for (const m of t.matchAll(JWT)) {
    try {
      const carga = JSON.parse(Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      // A do "supabase start" (iss supabase-demo) é pública, igual em toda máquina.
      if (carga && /^(service_role|supabase_admin)$/.test(String(carga.role || '')) && carga.iss !== 'supabase-demo') return 'chave service_role do Supabase';
    } catch { /* não é JWT de verdade */ }
  }
  for (const m of t.matchAll(POSTGRES)) {
    const senha = m[1];
    const host = m[2].toLowerCase();
    // Banco local de desenvolvimento (supabase start) e senha de exemplo passam.
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal|db|postgres|mongo|mysql|database)$/.test(host)) continue;
    if (/^(postgres|password|senha|\[?your|<|\$\{|\$[A-Z_]|%)$/i.test(senha) || /^(<|\[|\$\{|\$[A-Z_]|%)/.test(senha)) continue;
    return 'URL de banco com senha';
  }
  return null;
}

function textoDaEdicao(ti) {
  if (typeof ti.content === 'string') return ti.content;
  if (typeof ti.new_string === 'string') return ti.new_string;
  if (Array.isArray(ti.edits)) return ti.edits.map((e) => (e && typeof e.new_string === 'string' ? e.new_string : '')).join('\n');
  if (typeof ti.new_source === 'string') return ti.new_source;
  return '';
}

function git(args, cwd) {
  return execFileSync('git', ['--no-optional-locks', ...args], {
    cwd, encoding: 'utf8', timeout: 6000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function ignorado(arquivo, cwd) {
  // .env é o lugar certo da chave (e fica fora do git pela regra do projeto).
  if (/^\.env(\..+)?$/i.test(path.basename(arquivo))) return true;
  const alvo = path.resolve(cwd || '.', arquivo);
  // A pasta pode ainda não existir: o git roda na primeira que existe acima dela.
  let pasta = path.dirname(alvo);
  while (!fs.existsSync(pasta) && path.dirname(pasta) !== pasta) pasta = path.dirname(pasta);
  try {
    git(['check-ignore', '-q', '--no-index', alvo], pasta);
    return true;
  } catch {
    return false;
  }
}

// Palavras do comando, respeitando aspas.
function palavras(texto) {
  return [...String(texto).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}
const COM_VALOR_COMMIT = /^(-m|-F|-C|-c|-t|--message|--file|--author|--date|--template|--reuse-message|--reedit-message|--fixup|--squash|--cleanup|--trailer)$/;

// O que um comando de terminal vai commitar: pasta, caminhos citados (no git add e no git
// commit) e se é "commit -a". null se não há git commit no comando.
export function planoDoCommit(comando, cwd) {
  let commit = null;
  const caminhos = [];
  for (const parte of String(comando || '').split(/&&|\|\||[;|\r\n]|&(?!&)/)) {
    const t = palavras(parte.trim());
    while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) t.shift();
    if (!t.length || !/^git(\.exe)?$/i.test(path.basename(t[0]))) continue;
    let pasta = cwd;
    let i = 1;
    for (; i < t.length && t[i].startsWith('-'); i++) {
      if (t[i] === '-C' && t[i + 1]) pasta = path.resolve(pasta, t[++i]);
      else if (t[i] === '-c') i++;
    }
    const sub = (t[i] || '').toLowerCase();
    const resto = t.slice(i + 1);
    if (sub === 'add') {
      let depois = false;
      for (const x of resto) {
        if (x === '--') { depois = true; continue; }
        if (depois || !x.startsWith('-')) caminhos.push({ pasta, x });
      }
    } else if (sub === 'commit') {
      commit = { pasta, todos: false };
      let depois = false;
      for (let k = 0; k < resto.length; k++) {
        const x = resto[k];
        if (depois) { caminhos.push({ pasta, x }); continue; }
        if (x === '--') { depois = true; continue; }
        if (x === '--all' || /^-[A-Za-z]*a[A-Za-z]*$/.test(x)) commit.todos = true;
        if (COM_VALOR_COMMIT.test(x) || /^-[A-Za-z]*[mFCct]$/.test(x)) { k++; continue; }
        if (!x.startsWith('-')) caminhos.push({ pasta, x });
      }
    }
  }
  return commit ? { ...commit, caminhos: caminhos.filter((c) => c.pasta === commit.pasta).map((c) => c.x) } : null;
}

// Linhas acrescentadas no que o commit vai gravar: o índice, as mudanças dos arquivos
// citados (ou de tudo, com -a) e o conteúdo dos arquivos novos citados.
function adicionadasNoCommit(plano) {
  const { pasta } = plano;
  let diff = git(['diff', '--cached', '-U0', '--no-color', '--no-ext-diff'], pasta);
  const extra = plano.todos ? [] : plano.caminhos;
  if (plano.todos || extra.length) {
    try { diff += git(['diff', 'HEAD', '-U0', '--no-color', '--no-ext-diff', ...(extra.length ? ['--', ...extra] : [])], pasta); } catch { /* sem HEAD ainda */ }
  }
  const linhas = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  if (extra.length) {
    const novos = git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...extra], pasta).split('\0').filter(Boolean);
    for (const n of novos.slice(0, 200)) {
      try {
        const arq = path.join(pasta, n);
        if (fs.statSync(arq).size <= 2 * 1024 * 1024) linhas.push(fs.readFileSync(arq, 'utf8'));
      } catch { /* segue */ }
    }
  }
  return linhas.join('\n');
}

const negar = (motivo) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: motivo } });
const ORIENTACAO = 'Chave secreta fica só no .env (fora do git) ou no cofre do serviço; no código, leia de variável de ambiente. Se o que precisa é a chave pública (anon ou publishable), use essa. Se o usuário pediu para gravar essa chave aqui, explique o risco e deixe que ele mesmo faça.';

export function decidir(entrada) {
  if (!entrada) return null;
  const ferramenta = String(entrada.tool_name || '');
  const ti = entrada.tool_input || {};
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(ferramenta)) {
    const arquivo = String(ti.file_path || ti.notebook_path || '');
    const achado = acharSegredo(textoDaEdicao(ti));
    if (!achado || (arquivo && ignorado(arquivo, entrada.cwd))) return null;
    return negar(`Barrado pela equipe: o texto para ${path.basename(arquivo) || 'o arquivo'} tem o que parece ser uma ${achado}. ${ORIENTACAO}`);
  }
  if (/^(Bash|PowerShell)$/.test(ferramenta)) {
    const plano = planoDoCommit(ti.command, entrada.cwd || process.cwd());
    if (!plano) return null;
    let adicionadas;
    try { adicionadas = adicionadasNoCommit(plano); } catch { return null; }
    const achado = acharSegredo(adicionadas);
    if (!achado) return null;
    return negar(`Barrado pela equipe: o commit acrescenta o que parece ser uma ${achado}. Tire a chave do arquivo antes de commitar (git diff --cached mostra onde). ${ORIENTACAO}`);
  }
  return null;
}

function principal() {
  try {
    const d = decidir(lerEntrada());
    if (d) process.stdout.write(JSON.stringify(d));
  } catch {
    // Silêncio: segue o fluxo normal.
  }
}

const real = (p) => {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch { /* fica o caminho dado */ }
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) principal();
