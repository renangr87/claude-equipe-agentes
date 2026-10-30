#!/usr/bin/env node
// Hook PreToolUse da equipe (Bash e PowerShell): comando de terminal que altera o banco
// remoto ou apaga dados.
//   - no implementador: barra (ele escreve a migração; quem aplica é o mestre);
//   - no mestre e nos outros agentes: pede aprovação, sempre, até no modo Auto;
//   - no Explore e no verificador: calado (a guarda deles já só deixa passar a lista).
// Lê o comando como o terminal: ignora o que só cita o comando (echo, git commit -m, grep),
// entra em "bash -c '...'", tira versão do nome (npx supabase@latest) e acha scripts do
// package.json com nome de banco (npm run db:push). Erro vira silêncio: segue o fluxo normal.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lerEntrada } from './equipe-comum.mjs';

// Comandos cujo texto é dado, não execução.
const TEXTO = /^(git|grep|egrep|fgrep|rg|ag|findstr|select-string|sls|echo|printf|write-output|write-host|cat|type|get-content|gc|head|tail|less|more|wc|ls|dir|gci|get-childitem|which|where|where\.exe|get-command|gcm|man|mkdir|md|new-item|ni|cd|set-location)$/i;
// Opções que levam um valor no token seguinte (para achar o subcomando depois delas).
const COM_VALOR = /^(--workdir|--profile|--project-ref|--db-url|--schema|-s|--output|-o|--env-file|--password|-p|--file|-f|--config|-c|--network-id|--dns-resolver)$/;
const AJUDA = /^(--help|--version|-V|help)$/; // -h é host no psql: não conta como ajuda
const REMOTO = /^--(linked|db-url|project-ref)(=|$)/i;

const SUPABASE_SEMPRE = new Set([
  'db push', 'db remote', 'migration repair', 'migration squash', 'functions deploy', 'functions delete',
  'secrets set', 'secrets unset', 'projects create', 'projects delete', 'branches create', 'branches delete',
  'branches update', 'branches pause', 'storage rm', 'storage mv', 'storage cp', 'backups restore',
  'config push', 'postgres-config update', 'postgres-config delete', 'network-restrictions update',
  'ssl-enforcement update',
]);
const SUPABASE_REMOTO = new Set(['db reset', 'migration up', 'migration down', 'seed buckets', 'test db']);
const PRISMA = new Set(['migrate reset', 'migrate deploy', 'migrate resolve', 'db push', 'db execute']);
const DRIZZLE = new Set(['push', 'drop', 'migrate']);
const POSTGRES = new Set(['psql', 'dropdb', 'pg_restore']);
const SCRIPT_BANCO = /^(npm|pnpm|yarn|bun)$/i;
const NOME_SCRIPT = /(^|[:_-])(db|database|banco|supabase|prisma|drizzle|migrate|migration)s?[:_-]?(push|reset|drop|deploy|repair|seed|execute|resolve)\b|^(push|reset|deploy)[:_-](db|database|banco|supabase)\b/i;

// Separa em palavras, respeitando aspas: o caminho com espaço vira uma palavra só.
export function palavras(texto) {
  const lista = [];
  for (const m of String(texto).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) lista.push(m[1] ?? m[2] ?? m[3]);
  return lista;
}

function nomePrograma(t) {
  return t.split(/[\\/]/).pop().toLowerCase().replace(/(?<=.)@[^@]*$/, '').replace(/\.(exe|cmd|bat|ps1)$/, '');
}

// Primeiras palavras de subcomando, pulando opções e os valores delas.
function subcomando(resto, n) {
  const sub = [];
  for (let i = 0; i < resto.length && sub.length < n; i++) {
    const t = resto[i];
    if (t.startsWith('-')) {
      if (COM_VALOR.test(t) && i + 1 < resto.length) i++;
      continue;
    }
    sub.push(t.toLowerCase());
  }
  return sub.join(' ');
}

// O que o comando faz com o banco: null (nada) ou uma descrição curta.
export function comandoDeBanco(comando) {
  for (const parte of String(comando || '').split(/&&|\|\||[;|\r\n]|&(?!&)/)) {
    const t = palavras(parte.trim());
    if (!t.length) continue;
    // VAR=valor na frente (Bash) não muda o comando.
    while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) t.shift();
    if (!t.length || TEXTO.test(nomePrograma(t[0]))) continue;
    for (const x of t) {
      if (/\s/.test(x)) {
        const dentro = comandoDeBanco(x);
        if (dentro) return dentro;
      }
    }
    if (SCRIPT_BANCO.test(nomePrograma(t[0]))) {
      const i = t[1] && /^(run|run-script)$/i.test(t[1]) ? 2 : 1;
      if (t[i] && NOME_SCRIPT.test(t[i])) return `script ${t[i]}`;
    }
    for (let i = 0; i < t.length; i++) {
      const nome = nomePrograma(t[i]);
      const resto = t.slice(i + 1);
      if (!['supabase', 'prisma', 'drizzle-kit', ...POSTGRES].includes(nome)) continue;
      if (resto.some((x) => AJUDA.test(x))) return null;
      if (POSTGRES.has(nome)) {
        if (nome === 'pg_restore' && resto.some((x) => /^(-l|--list)$/.test(x))) return null;
        return nome;
      }
      const dois = subcomando(resto, 2);
      if (nome === 'supabase') {
        if (SUPABASE_SEMPRE.has(dois)) return `supabase ${dois}`;
        if (SUPABASE_REMOTO.has(dois) && resto.some((x) => REMOTO.test(x))) return `supabase ${dois} no banco remoto`;
        return null;
      }
      if (nome === 'prisma') return PRISMA.has(dois) ? `prisma ${dois}` : null;
      if (nome === 'drizzle-kit') {
        const um = subcomando(resto, 1);
        return DRIZZLE.has(um) ? `drizzle-kit ${um}` : null;
      }
    }
  }
  return null;
}

export function decidir(entrada) {
  if (!entrada || !/^(Bash|PowerShell)$/.test(String(entrada.tool_name || ''))) return null;
  const tipo = String(entrada.agent_type || '');
  if (tipo === 'Explore' || tipo === 'verificador') return null;
  const achado = comandoDeBanco(entrada.tool_input && entrada.tool_input.command);
  if (!achado) return null;
  if (tipo === 'implementador') {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: `Barrado pela equipe: comando que altera o banco ou aponta para o banco remoto (${achado}). Escreva a migração ou o script e relate ao mestre: quem aplica é ele, com o OK do usuário.` } };
  }
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask',
    permissionDecisionReason: `Comando que altera o banco (${achado}): a equipe pede a sua aprovação.` } };
}

function principal() {
  try {
    const d = decidir(lerEntrada());
    if (d) process.stdout.write(JSON.stringify(d));
  } catch {
    // Silêncio: segue o fluxo normal de permissões.
  }
}

const real = (p) => {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch { /* fica o caminho dado */ }
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) principal();
