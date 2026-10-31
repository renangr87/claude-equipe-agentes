#!/usr/bin/env node
// Hook Notification da equipe: aviso no celular, pelo ntfy, quando uma sessão para
// esperando você (pedido de aprovação, pergunta ou fim da tarefa).
//
// O endereço fica em <pasta do Claude>/equipe-aviso.json ({"ntfy": "https://ntfy.sh/<tópico>"}),
// criado pelo instalador com um tópico secreto. O aviso leva só o tipo, a pasta do projeto
// e o nome do computador: nada de código nem do pedido. No máximo um aviso por sessão a
// cada 2 minutos. Sem configuração, sem rede ou com erro: silêncio.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lerEntrada, lerJson, pastaClaude, pastaDiario } from './equipe-comum.mjs';

const INTERVALO_MS = 2 * 60000;

export function textoDoAviso(entrada) {
  const tipo = String(entrada.notification_type || '');
  const msg = String(entrada.message || '');
  const motivo = tipo === 'permission_prompt' || /permission/i.test(msg) ? 'pede a sua aprovação'
    : tipo === 'idle_prompt' || /waiting for your input/i.test(msg) ? 'está esperando você'
      : tipo === 'elicitation_dialog' ? 'fez uma pergunta'
        : 'precisa de você';
  const pasta = entrada.cwd ? path.basename(String(entrada.cwd).replace(/[\\/]+$/, '')) : '';
  return { titulo: `Claude Code ${motivo}`, corpo: `${pasta ? `Projeto: ${pasta}. ` : ''}Computador: ${os.hostname()}.` };
}

function jaAvisou(sessao) {
  if (!sessao) return false;
  const arq = path.join(pastaDiario(), 'avisos', `${String(sessao).replace(/[^A-Za-z0-9_-]/g, '')}.txt`);
  try {
    if (Date.now() - fs.statSync(arq).mtimeMs < INTERVALO_MS) return true;
  } catch { /* primeiro aviso */ }
  fs.mkdirSync(path.dirname(arq), { recursive: true });
  fs.writeFileSync(arq, String(Date.now()));
  return false;
}

export async function avisar(entrada) {
  const cfg = lerJson(path.join(pastaClaude(), 'equipe-aviso.json'));
  const url = cfg && typeof cfg.ntfy === 'string' ? cfg.ntfy : '';
  if (!/^https?:\/\/\S+\/[A-Za-z0-9_-]{8,}$/.test(url)) return false;
  if (jaAvisou(entrada.session_id)) return false;
  const { titulo, corpo } = textoDoAviso(entrada);
  // Cabeçalho HTTP só aceita ASCII: o título vai sem acento ali e com acento no corpo.
  const r = await fetch(url, {
    method: 'POST',
    body: `${titulo}. ${corpo}`,
    headers: { Title: titulo.normalize('NFD').replace(/[^\x20-\x7e]/g, ''), Tags: 'robot', Priority: 'high' },
    signal: AbortSignal.timeout(4000),
  });
  return r.ok;
}

async function principal() {
  try {
    await avisar(lerEntrada());
  } catch {
    // Silêncio: o aviso é ajuda, nunca atrapalha a sessão.
  }
}

const real = (p) => {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch { /* fica o caminho dado */ }
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) principal();
