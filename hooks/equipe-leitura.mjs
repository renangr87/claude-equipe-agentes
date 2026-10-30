#!/usr/bin/env node
// Hook PreToolUse do Explore (declarado no arquivo do agente, só vale para ele): leitura
// por trecho e teto de leituras por chamada.
//
// O teto estava só escrito no prompt e foi ignorado: 18 leituras e 1,4 milhão de tokens por
// chamada, em média, numa semana. Aqui ele vira trava:
//   1. arquivo grande não é lido inteiro: o Explore acha o trecho (Grep -n, mapa) e lê com
//      offset e limit;
//   2. passado o teto de leituras, a próxima é barrada e o Explore responde com o que tem.
// Erro ou dúvida vira silêncio: a leitura segue normal. Uma trava de economia nunca pode
// impedir o trabalho por defeito próprio.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lerEntrada, pastaDiario } from './equipe-comum.mjs';

const numero = (v, padrao) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : padrao);
export const TETO = () => numero(process.env.EQUIPE_EXPLORE_LEITURAS, 12);
export const MAX_LINHAS = () => numero(process.env.EQUIPE_EXPLORE_LINHAS, 300);
// Imagem, PDF e notebook não são lidos por linha.
const SEM_LINHAS = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|ipynb)$/i;

// Conta as linhas, parando assim que passar de "ate" (arquivo enorme não é lido todo).
function contarLinhas(arquivo, ate) {
  const fd = fs.openSync(arquivo, 'r');
  const buf = Buffer.alloc(1 << 16);
  let n = 0;
  let ultimo = 10;
  let algum = false;
  try {
    let lidos;
    while ((lidos = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      algum = true;
      for (let i = 0; i < lidos; i++) if (buf[i] === 10) n++;
      ultimo = buf[lidos - 1];
      if (n > ate) break;
    }
  } finally {
    fs.closeSync(fd);
  }
  return !algum ? 0 : ultimo === 10 ? n : n + 1;
}

// Quantas linhas esta leitura traz, ou null se não dá para saber (não é texto, não existe).
function linhasDaLeitura(entrada, max) {
  const ti = entrada.tool_input || {};
  const arquivo = typeof ti.file_path === 'string' ? ti.file_path : '';
  if (!arquivo || SEM_LINHAS.test(arquivo)) return null;
  const limite = Number(ti.limit) > 0 ? Number(ti.limit) : null;
  if (limite !== null && limite <= max) return limite;
  let total;
  try {
    if (!fs.statSync(arquivo).isFile()) return null;
    total = contarLinhas(arquivo, (Number(ti.offset) || 0) + max + 1);
  } catch {
    return null;
  }
  const depois = Math.max(0, total - Math.max(0, (Number(ti.offset) || 1) - 1));
  return limite === null ? depois : Math.min(limite, depois);
}

// Quem é esta chamada do Explore: o id do agente que o Claude Code manda no hook ou, se
// não vier, o arquivo de transcrição do subagente que contém esta chamada de ferramenta.
export function chaveDoAgente(entrada) {
  const sessao = String(entrada.session_id || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (entrada.agent_id) return `${sessao}-${String(entrada.agent_id).replace(/[^A-Za-z0-9_-]/g, '')}`;
  const id = String(entrada.tool_use_id || '');
  const transcricao = String(entrada.transcript_path || '');
  if (!id || !transcricao || !sessao) return null;
  const pasta = path.join(path.dirname(transcricao), sessao, 'subagents');
  let nomes = [];
  try { nomes = fs.readdirSync(pasta).filter((n) => /^agent-[A-Za-z0-9_-]+\.jsonl$/.test(n)); } catch { return null; }
  const agora = Date.now();
  for (const n of nomes) {
    const arq = path.join(pasta, n);
    try {
      if (agora - fs.statSync(arq).mtimeMs > 30 * 60000) continue;
      if (fs.readFileSync(arq, 'utf8').includes(id)) return `${sessao}-${n.replace(/^agent-|\.jsonl$/g, '')}`;
    } catch { /* segue */ }
  }
  return null;
}

// Contagem das leituras liberadas desta chamada: uma linha por leitura, acrescentada no
// fim do arquivo (duas leituras ao mesmo tempo não se perdem).
function pastaContagem() {
  return path.join(pastaDiario(), 'leituras-explore');
}

function leiturasFeitas(chave) {
  try { return fs.readFileSync(path.join(pastaContagem(), `${chave}.txt`), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
}

function registrarLeitura(chave) {
  const pasta = pastaContagem();
  fs.mkdirSync(pasta, { recursive: true });
  fs.appendFileSync(path.join(pasta, `${chave}.txt`), '1\n');
  // Limpeza das contagens velhas, de vez em quando.
  if (Math.random() < 0.05) {
    const limite = Date.now() - 3 * 86400000;
    for (const n of fs.readdirSync(pasta)) {
      const arq = path.join(pasta, n);
      try { if (fs.statSync(arq).mtimeMs < limite) fs.unlinkSync(arq); } catch { /* segue */ }
    }
  }
}

const negar = (motivo) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: motivo } });

// Fim da chamada (Stop no arquivo do agente vira SubagentStop): zera a conta, para que o
// Explore retomado com o mesmo id comece de novo.
function zerar(entrada) {
  const chave = chaveDoAgente(entrada);
  if (chave) fs.rmSync(path.join(pastaContagem(), `${chave}.txt`), { force: true });
}

export function decidir(entrada) {
  if (entrada && /^(SubagentStop|Stop)$/.test(String(entrada.hook_event_name || ''))) {
    zerar(entrada);
    return null;
  }
  if (!entrada || entrada.tool_name !== 'Read') return null;
  const max = MAX_LINHAS();
  const teto = TETO();

  const linhas = linhasDaLeitura(entrada, max);
  if (linhas !== null && linhas > max) {
    const nome = path.basename(String(entrada.tool_input.file_path));
    return negar(`Leitura barrada pela equipe: esta leitura de ${nome} traria mais de ${max} linhas, e o Explore lê por trecho. Ache a linha com Grep (com -n) ou pelo mapa do código (search_code, get_code_snippet) e leia só o trecho, com offset e limit de até ${max} linhas.`);
  }

  const chave = chaveDoAgente(entrada);
  if (!chave) return null;
  if (leiturasFeitas(chave) >= teto) {
    return negar(`Teto de ${teto} leituras desta chamada atingido (trava da equipe). Não leia mais nada: responda agora com o que já achou (caminho:linha) e diga o que faltou. Se faltar muito, o mestre faz outra chamada com uma pergunta menor.`);
  }
  registrarLeitura(chave);
  return null;
}

function principal() {
  try {
    const d = decidir(lerEntrada());
    if (d) process.stdout.write(JSON.stringify(d));
  } catch {
    // Silêncio: a leitura segue normal.
  }
}

const real = (p) => {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch { /* fica o caminho dado */ }
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) principal();
