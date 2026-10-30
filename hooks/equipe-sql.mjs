#!/usr/bin/env node
// Hook PreToolUse da equipe: consulta só de leitura não vai pela conexão do banco que escreve.
//
// O execute_sql da conexão normal do Supabase é o mesmo para ler e para escrever, então
// pede aprovação até para um select: numa semana, isso parou as sessões centenas de vezes.
// Este hook barra (deny, sem perguntar nada ao usuário) a consulta que só lê e manda o
// agente para a conexão só de leitura (supabase-leitura). Escrita continua pela conexão
// normal, com aprovação. Erro ou dúvida vira silêncio: segue o fluxo normal (pedir aprovação).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, lerEntrada } from './equipe-comum.mjs';

export const CONEXAO_LEITURA = 'supabase-leitura';

// Comando que só lê começa assim. EXPLAIN ANALYZE executa a consulta: não conta.
const INICIO_LEITURA = /^(select|with|explain|show|table|values)\b/i;
// Dentro de uma consulta que começa como leitura, o que ainda pode escrever ou mexer no
// servidor: CTE que altera dados, SELECT INTO, trava de linha, sequência e funções com efeito.
// Função com schema na frente (public.criar_pedido(), cron.schedule(), net.http_post())
// pode escrever: só as do catálogo do Postgres contam como leitura.
const ESCRITA = /\b(insert|update|delete|merge|upsert|into|create|alter|drop|truncate|grant|revoke|nextval|setval|set_config|pg_notify|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_advisory\w*|lo_\w+|dblink\w*)\b|\bfor\s+(no\s+key\s+|key\s+)?(update|share)\b/i;

const FUNCAO_COM_SCHEMA = /\b(?!pg_catalog\.|information_schema\.)[a-z_][a-z0-9_$]*\s*\.\s*[a-z_][a-z0-9_$]*\s*\(/i;
// Saída explícita: SQL que começa com /* escrita */ é escrita declarada (função que grava, por
// exemplo) e segue o fluxo normal, com aprovação.
const ESCRITA_DECLARADA = /^\s*\/\*\s*escrita\s*\*\//i;

// true só quando a consulta inteira (todos os comandos) só lê. Errar para os dois lados é
// seguro: leitura tida como escrita só pede aprovação, como antes; escrita tida como
// leitura é barrada aqui e falharia na conexão só de leitura.
export function somenteLeitura(sql) {
  if (typeof sql !== 'string' || ESCRITA_DECLARADA.test(sql)) return false;
  const limpo = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
  const comandos = limpo.split(';').map((c) => c.trim()).filter(Boolean);
  if (!comandos.length) return false;
  return comandos.every((c) => INICIO_LEITURA.test(c) && !(/^explain\b/i.test(c) && /\banalyze\b/i.test(c)) && !ESCRITA.test(c) && !FUNCAO_COM_SCHEMA.test(c));
}

// A conexão só de leitura está declarada para este projeto? No .mcp.json da raiz ou no
// .claude.json do usuário (geral ou do projeto).
export function leituraDeclarada(raiz) {
  const tem = (servidores) => Boolean(servidores && typeof servidores === 'object' && servidores[CONEXAO_LEITURA]);
  const ler = (arq) => {
    try { return JSON.parse(fs.readFileSync(arq, 'utf8').replace(/^﻿/, '')); } catch { return null; }
  };
  if (raiz) {
    const mcp = ler(path.join(raiz, '.mcp.json'));
    if (mcp && tem(mcp.mcpServers)) return true;
  }
  const base = process.env.CLAUDE_CONFIG_DIR || os.homedir();
  const usuario = ler(path.join(base, '.claude.json'));
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

export function decidir(entrada) {
  const nome = String((entrada && entrada.tool_name) || '');
  const m = nome.match(/^mcp__(.+)__execute_sql$/);
  // Só a conexão do Supabase que escreve: outro banco (postgres, sqlite) não tem a supabase-leitura.
  if (!m || m[1] === CONEXAO_LEITURA || !/supabase/i.test(m[1])) return null;
  const ti = (entrada && entrada.tool_input) || {};
  const sql = typeof ti.query === 'string' ? ti.query : ti.sql;
  if (!somenteLeitura(sql)) return null;

  const cwd = entrada.cwd || process.cwd();
  const raiz = process.env.CLAUDE_PROJECT_DIR || git(['rev-parse', '--show-toplevel'], cwd) || cwd;
  const falta = leituraDeclarada(raiz)
    ? `A conexão ${CONEXAO_LEITURA} está configurada; se a ferramenta mcp__${CONEXAO_LEITURA}__execute_sql não aparece nesta sessão, falta autenticar. No fim da tarefa, peça ao usuário uma vez: "/mcp, ${CONEXAO_LEITURA}, Authenticate".`
    : `Este projeto ainda não tem a conexão ${CONEXAO_LEITURA}. No fim da tarefa, peça ao usuário uma vez para configurá-la (README da equipe, "Consultas ao banco sem pedir aprovação"): leva 2 minutos e acaba com os pedidos de aprovação.`;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: [
        `Barrado pela equipe: consulta só de leitura não vai pela conexão que escreve (${m[1]}), porque cada chamada dela pede aprovação e para a sessão.`,
        `Rode o mesmo SQL em mcp__${CONEXAO_LEITURA}__execute_sql, que só lê e não pede aprovação.`,
        falta,
        'Até lá, faça o que não depende do banco e não tente de novo pela conexão de escrita. Escrita (insert, update, migração) continua pela conexão normal, com aprovação; se a consulta escreve por meio de uma função, comece o SQL com /* escrita */ e ela segue para a aprovação.',
      ].join(' '),
    },
  };
}

function principal() {
  try {
    const d = decidir(lerEntrada());
    if (d) process.stdout.write(JSON.stringify(d));
  } catch {
    // Silêncio: sem decisão, segue o fluxo normal (pedir aprovação).
  }
}

const real = (p) => {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch { /* fica o caminho dado */ }
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) principal();
