#!/usr/bin/env node
// Hook PostToolUse da equipe: o que acontece depois de uma ferramenta que deu certo (e, no
// terminal, também depois da que falhou: PostToolUseFailure).
//   - consulta ao mapa do código (Explore e revisor): anota, e a trava "mapa primeiro" libera;
//   - Edit e Write (mestre e implementador): roda o analisador no arquivo e devolve os erros
//     na hora; anota a edição (verificação antes da entrega e revisão obrigatória);
//   - terminal: anota quando o implementador rodou uma verificação (também quando o comando
//     falhou) e, de qualquer agente, o resultado das linhas da lista do verificador (a prova);
//   - Read do mestre que falhou: devolve a conta do orçamento de leitura;
//   - pergunta de múltipla escolha do mestre: a resposta que autoriza o push;
//   - qualquer ferramenta do mestre: entrega as listas de escopo dos implementadores que
//     terminaram (os de segundo plano também) e o aviso de quando a mesma falha voltou.
// Nunca barra; erro vira silêncio.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { carregarModulo, fatosRapidos, lerEntrada, registrarTrava, tipoDoAgente } from './equipe-comum.mjs';

// Cada módulo à parte: um quebrado não leva os outros junto, e a falha vai para o registro.
const carregar = (arquivo) => carregarModulo(import.meta.url, arquivo);
const [analisador, entrega, mapa, convergencia, prova, push, paralelo] = await Promise.all([
  carregar('./equipe-analisar.mjs'), carregar('./equipe-entrega.mjs'), carregar('./equipe-mapa.mjs'),
  carregar('./equipe-convergencia.mjs'), carregar('./equipe-prova.mjs'), carregar('./equipe-push.mjs'),
  carregar('./equipe-paralelo.mjs'),
]);

const tentar = (f) => { try { return f(); } catch { return null; } };
const listaDoVerificador = (entrada) => (fatosRapidos(entrada.cwd || process.cwd()) || {}).comandos || null;

export function tratar(entrada) {
  if (!entrada || typeof entrada !== 'object') return null;
  const nome = String(entrada.tool_name || '');
  const tipo = tipoDoAgente(entrada);
  const terminal = /^(Bash|PowerShell)$/.test(nome);
  const contexto = [];
  // Comando que falhou (teste vermelho) também é verificação feita: o implementador rodou o
  // teste e vai relatar a falha. Ferramenta de edição que falhou não editou nada.
  if (String(entrada.hook_event_name || '') === 'PostToolUseFailure') {
    if (terminal && tipo === 'implementador' && entrega) tentar(() => entrega.anotarFerramenta(entrada, listaDoVerificador(entrada)));
    if (terminal && prova) tentar(() => prova.anotarExecucao(entrada));
    if (/^(Agent|Task)$/.test(nome) && paralelo) tentar(() => paralelo.falhaAoLancar(entrada));
    // Consulta ao mapa que deu erro: a trava do mapa deixa a leitura seguinte passar.
    if (/^mcp__codebase-memory__/.test(nome) && mapa && tentar(() => mapa.anotarFalhaDoMapa(entrada))) registrarTrava('mapa', 'falhou', 0, entrada);
    // Read do mestre que falhou (arquivo grande demais, por exemplo): a conta da leitura volta.
    if (nome === 'Read' && mapa && tentar(() => mapa.devolverLeitura(entrada))) registrarTrava('orcamento', 'devolveu', 0, entrada);
    return null;
  }
  if (/^mcp__codebase-memory__/.test(nome)) {
    if (mapa && tentar(() => mapa.anotarConsulta(entrada))) registrarTrava('mapa', 'consultou', 0, entrada);
    return null;
  }
  if (nome === 'AskUserQuestion') {
    if (push && tentar(() => push.anotarRespostaDePush(entrada))) registrarTrava('push', 'autorizado', 0, entrada);
  }
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(nome) || terminal) {
    const lista = tipo === 'implementador' && terminal ? listaDoVerificador(entrada) : null;
    if (entrega) tentar(() => entrega.anotarFerramenta(entrada, lista));
    if (terminal && prova) tentar(() => prova.anotarExecucao(entrada));
    if (terminal && push) tentar(() => push.anotarPushFeito(entrada));
    if (/^(Edit|Write|MultiEdit)$/.test(nome) && analisador) {
      const inicio = Date.now();
      const erros = tentar(() => analisador.analisar(entrada));
      if (erros) {
        registrarTrava('analisar', 'avisou', Date.now() - inicio, entrada);
        contexto.push(erros);
      }
    }
  }
  if (tipo === 'mestre') {
    const escopo = entrega ? tentar(() => entrega.escopoParaMestre(entrada)) : null;
    if (escopo) contexto.push(escopo);
    const aviso = convergencia ? tentar(() => convergencia.avisoParaMestre(entrada)) : null;
    if (aviso) {
      registrarTrava('convergencia', 'avisou', 0, entrada);
      contexto.push(aviso);
    }
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
