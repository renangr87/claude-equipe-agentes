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
  ['chave da OpenAI', /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/],
  ['token do GitHub', /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ['chave da AWS', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['chave secreta do Stripe', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/],
  ['token do Slack', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['token de bot do Telegram', /\b\d{8,10}:AA[0-9A-Za-z_-]{33}\b/],
  ['chave privada', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/],
];
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g;
const POSTGRES = /\bpostgres(?:ql)?:\/\/[^:\s/@]+:([^@\s]+)@([^\s/:?'"]+)/gi;

// Nome do tipo de chave achado, ou null. Nunca devolve a chave.
export function acharSegredo(texto) {
  const t = String(texto || '');
  if (!t) return null;
  for (const [nome, re] of PADROES) if (re.test(t)) return nome;
  for (const m of t.matchAll(JWT)) {
    try {
      const carga = JSON.parse(Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      if (carga && /^(service_role|supabase_admin)$/.test(String(carga.role || ''))) return 'chave service_role do Supabase';
    } catch { /* não é JWT de verdade */ }
  }
  for (const m of t.matchAll(POSTGRES)) {
    const senha = m[1];
    const host = m[2].toLowerCase();
    // Banco local de desenvolvimento (supabase start) e senha de exemplo passam.
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal|db)$/.test(host)) continue;
    if (/^(postgres|password|senha|\[?your|<|\$\{|\$[A-Z_]|%)/i.test(senha)) continue;
    return 'URL do Postgres com senha';
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
    cwd, encoding: 'utf8', timeout: 6000, maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function ignorado(arquivo, cwd) {
  try {
    git(['check-ignore', '-q', arquivo], path.dirname(path.resolve(cwd || '.', arquivo)));
    return true;
  } catch {
    return false;
  }
}

// Linhas acrescentadas no que o "git commit" vai gravar: o que está no índice e, com
// caminhos depois de "--", esses arquivos como estão na pasta.
function adicionadasNoCommit(comando, cwd) {
  let diff = git(['diff', '--cached', '-U0', '--no-color', '--no-ext-diff'], cwd);
  const i = comando.indexOf(' -- ');
  if (i >= 0) {
    const caminhos = comando.slice(i + 4).match(/"[^"]*"|'[^']*'|[^\s;&|]+/g) || [];
    const limpos = caminhos.map((c) => c.replace(/^["']|["']$/g, '')).filter(Boolean);
    if (limpos.length) {
      try { diff += git(['diff', 'HEAD', '-U0', '--no-color', '--no-ext-diff', '--', ...limpos], cwd); } catch { /* sem HEAD ainda */ }
    }
  }
  return diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
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
    const comando = String(ti.command || '');
    if (!/\bgit\b(?:\s+-[Cc]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+commit\b/.test(comando)) return null;
    let adicionadas;
    try { adicionadas = adicionadasNoCommit(comando, entrada.cwd || process.cwd()); } catch { return null; }
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
