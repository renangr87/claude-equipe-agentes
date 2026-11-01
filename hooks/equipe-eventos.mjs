#!/usr/bin/env node
// Hooks de evento da equipe (um script para todos):
//   - UserPromptSubmit: começa um pedido novo do mestre (zera o orçamento de leitura e lê
//     "leia você mesmo", "sem delegar" e "sem revisão" no texto do pedido);
//   - SubagentStart do implementador: tira a foto do git status (escopo);
//   - SubagentStop: zera as contas da chamada (leituras, mapa); no implementador, barra uma
//     vez a entrega sem verificação e grava a lista do escopo; no revisor, anota a revisão;
//   - Stop do mestre: revisão obrigatória em mudança grande ou sensível.
// Erro vira silêncio: nunca impede a sessão por defeito próprio.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  apagarEstado, chaveDaChamada, gravarEstado, lerEntrada, limparChamada, normalizar, registrarTrava, tipoDoAgente,
} from './equipe-comum.mjs';
import { anotarRevisao, fimDoImplementador, fotoInicial, revisaoNoFim } from './equipe-entrega.mjs';
import * as leitura from './equipe-leitura.mjs';

const LIVRE = /\b(leia (voce|vc|tu) mesmo|le (voce|vc) mesmo|sem delegar|nao delegue|nao precisa delegar)\b/;
const SEM_REVISAO = /\b(sem revisao|nao precisa (de )?revis(ao|ar)|dispensa (a )?revisao)\b/;

export function flagsDoPedido(texto) {
  const t = normalizar(texto);
  return { livre: LIVRE.test(t), semRevisao: SEM_REVISAO.test(t) };
}

// Devolve a saída do hook (objeto) ou null.
export function tratar(entrada) {
  if (!entrada || typeof entrada !== 'object') return null;
  const evento = String(entrada.hook_event_name || '');
  const tipo = tipoDoAgente(entrada);
  const chave = chaveDaChamada(entrada);

  if (evento === 'UserPromptSubmit') {
    if (tipo !== 'mestre' || !chave) return null;
    apagarEstado(chave, 'lidos');
    gravarEstado(chave, 'pedido', { em: Date.now(), ...flagsDoPedido(entrada.prompt) });
    return null;
  }

  if (evento === 'SubagentStart') {
    if (tipo === 'implementador') fotoInicial(entrada);
    return null;
  }

  if (evento === 'SubagentStop') {
    // Sem o tipo do agente (versão antiga do Claude Code), a chave seria a do mestre: não mexe.
    if (tipo === 'mestre') return null;
    const inicio = Date.now();
    if (tipo === 'implementador') {
      const r = fimDoImplementador(entrada);
      if (r && r.registro) registrarTrava(r.registro === 'barrou' || r.registro === 'entregou-sem-verificar' ? 'verificar' : 'escopo', r.registro, Date.now() - inicio, entrada);
      if (r && r.bloquear) return { decision: 'block', reason: r.motivo };
      return null;
    }
    if (tipo === 'revisor') anotarRevisao(entrada);
    // Explore e revisor: as contas da chamada zeram (um agente retomado começa de novo).
    if (tipo === 'Explore') { try { leitura.decidir({ ...entrada, hook_event_name: 'SubagentStop' }); } catch { /* segue */ } }
    limparChamada(chave);
    return null;
  }

  if (evento === 'Stop') {
    const inicio = Date.now();
    const r = revisaoNoFim(entrada);
    if (r && r.registro) registrarTrava('revisao', r.registro, Date.now() - inicio, entrada);
    if (r && r.bloquear) return { decision: 'block', reason: r.motivo };
    return null;
  }
  return null;
}

function principal() {
  let entrada = {};
  try {
    entrada = lerEntrada();
    const s = tratar(entrada);
    if (s) process.stdout.write(JSON.stringify(s));
  } catch {
    // Silêncio.
  }
  registrarTrava('eventos', String(entrada.hook_event_name || '?'), process.uptime() * 1000, entrada);
}

const real = (p) => {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch { /* fica o caminho dado */ }
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) principal();
