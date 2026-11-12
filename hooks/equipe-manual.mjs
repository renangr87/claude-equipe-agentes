// Manual do mestre (hook de início de sessão).
//
// As regras de orquestração (a equipe, quando delegar, a ordem, o plano, os portões, o commit e
// o briefing) só servem à sessão principal. Na regra global, elas eram carregadas também em
// cada subagente, que nunca as usa. Este hook entrega o manual só ao mestre, no começo da
// sessão e de novo depois de um resumo automático (o resumo o tira do contexto). O hook de
// início de sessão não roda em subagente.
//
// O texto vai sozinho, num hook separado do boletim: a saída de um hook que entra no contexto
// tem teto de tamanho, e os dois juntos passariam dele. Sem o arquivo, ou com erro, silêncio:
// a regra global manda o mestre ler o arquivo se o manual não estiver no contexto.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lerEntrada, lerTexto, saidaContexto } from './equipe-comum.mjs';

export const ARQUIVO = 'equipe-manual-mestre.md';
// Teto do texto que um hook põe no contexto (acima disso, vira arquivo com prévia).
export const TETO = 9500;

export function manual(entrada, pasta = path.dirname(fileURLToPath(import.meta.url))) {
  // Só a sessão principal: uma entrada com agente é de subagente.
  if (entrada && (entrada.agent_id || entrada.agent_type)) return '';
  const texto = (lerTexto(path.join(pasta, ARQUIVO)) || '').trim();
  if (!texto) return '';
  // Sessão retomada: a conversa já traz o manual da primeira vez; outra cópia só pesaria.
  if (entrada && entrada.source === 'resume') return `Manual do mestre: já veio no começo desta conversa. Se não estiver no contexto, leia ${path.join(pasta, ARQUIVO)} antes de delegar.`;
  const origem = entrada && entrada.source === 'compact' ? ' A conversa acabou de ser resumida: este é o manual de novo.' : '';
  const saida = `Manual do mestre (hook de início de sessão; regras da equipe para esta sessão principal).${origem}\n\n${texto}`;
  // Grande demais para caber: melhor mandar ler o arquivo do que entregar pela metade.
  if (saida.length > TETO) return `Manual do mestre: leia ${path.join(pasta, ARQUIVO)} antes de delegar (o texto não coube no aviso de início).`;
  return saida;
}

// O mesmo arquivo, também quando a pasta do Claude é um link (o Node resolve o link no módulo).
const real = (p) => {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch { /* fica o caminho dado */ }
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  try { saidaContexto('SessionStart', manual(lerEntrada())); } catch { /* silêncio */ }
}
