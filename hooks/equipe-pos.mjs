#!/usr/bin/env node
// Hook PostToolUse da equipe: o que acontece depois de uma ferramenta que deu certo.
//   - consulta ao mapa do código (Explore e revisor): anota, e a trava "mapa primeiro" libera;
//   - Edit e Write (mestre e implementador): roda o analisador no arquivo e devolve os erros
//     na hora; anota a edição (verificação antes da entrega e revisão obrigatória);
//   - terminal do implementador: anota quando ele rodou uma verificação (também quando o
//     comando falhou: PostToolUseFailure);
//   - Agent do mestre: entrega a lista do escopo do implementador que acabou de terminar.
// Nunca barra; erro vira silêncio.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analisar } from './equipe-analisar.mjs';
import { fatosRapidos, lerEntrada, registrarTrava, tipoDoAgente } from './equipe-comum.mjs';
import { anotarFerramenta, escopoParaMestre } from './equipe-entrega.mjs';
import { anotarConsulta } from './equipe-mapa.mjs';

export function tratar(entrada) {
  if (!entrada || typeof entrada !== 'object') return null;
  const nome = String(entrada.tool_name || '');
  const contexto = [];
  // Comando que falhou (teste vermelho) também é verificação feita: o implementador rodou o
  // teste e vai relatar a falha. Ferramenta de edição que falhou não editou nada.
  if (String(entrada.hook_event_name || '') === 'PostToolUseFailure') {
    if (/^(Bash|PowerShell)$/.test(nome) && tipoDoAgente(entrada) === 'implementador') {
      anotarFerramenta(entrada, (fatosRapidos(entrada.cwd || process.cwd()) || {}).comandos || null);
    }
    return null;
  }
  if (/^mcp__codebase-memory__/.test(nome)) {
    if (anotarConsulta(entrada)) registrarTrava('mapa', 'consultou', 0, entrada);
    return null;
  }
  if (/^(Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell)$/.test(nome)) {
    const tipo = tipoDoAgente(entrada);
    const lista = tipo === 'implementador' && /^(Bash|PowerShell)$/.test(nome) ? ((fatosRapidos(entrada.cwd || process.cwd()) || {}).comandos || null) : null;
    anotarFerramenta(entrada, lista);
    if (/^(Edit|Write|MultiEdit)$/.test(nome)) {
      const inicio = Date.now();
      const erros = analisar(entrada);
      if (erros) {
        registrarTrava('analisar', 'avisou', Date.now() - inicio, entrada);
        contexto.push(erros);
      }
    }
  }
  if (/^(Agent|Task)$/.test(nome)) {
    const escopo = escopoParaMestre(entrada);
    if (escopo) contexto.push(escopo);
  }
  if (!contexto.length) return null;
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: contexto.join('\n\n') } };
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
  registrarTrava('pos', 'passou', process.uptime() * 1000, entrada);
}

const real = (p) => {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch { /* fica o caminho dado */ }
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) principal();
