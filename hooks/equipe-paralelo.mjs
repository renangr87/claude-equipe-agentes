// Trava do paralelo (roda pelo despachante equipe-pre.mjs, na ferramenta Agent do mestre).
//
// "Nunca dois agentes no mesmo arquivo": cada implementador lançado em segundo plano fica
// anotado com o escopo do briefing até terminar. Um implementador novo cujo escopo cruza o de
// um que ainda roda (o mesmo arquivo, ou uma pasta que contém o outro) é barrado uma vez.
// Válvula: o mesmo briefing mandado de novo passa e fica registrado (o outro pode ter
// terminado sem avisar). Anotações com mais de 2 horas caem.
// Trava de retrabalho: erro ou dúvida deixa passar.
import fs from 'node:fs';
import path from 'node:path';
import { anotacoes, anotar, briefingDaTranscricao, desligada, marcaDoTexto, normalizar, pastaDiario, tipoDoAgente } from './equipe-comum.mjs';
import { caminhos, ehCaminhoDeArquivo } from './equipe-briefing.mjs';
import { chaveDaSessao, escopoDoTexto, raizGit } from './equipe-entrega.mjs';

const DUAS_HORAS = 2 * 3600000;
const lerJson = (l) => { try { return JSON.parse(l); } catch { return null; } };

// Caminhos do escopo de um briefing, só os de verdade ("Node.js" e "e/ou" não são). O escopo
// vem sem maiúsculas: a forma original de cada nome decide (App.tsx vale, Node.js não).
function escopoReal(texto) {
  const original = new Map(caminhos(texto).map((c) => { const x = c.replace(/\\/g, '/'); return [normalizar(x), x]; }));
  return escopoDoTexto(texto).filter((c) => ehCaminhoDeArquivo(original.get(c) || c));
}

const limpar = (p, base) => {
  let x = normalizar(String(p).replace(/\\/g, '/')).replace(/^\.\//, '').replace(/\*.*$/, '').replace(/\/+$/, '');
  if (base && x.startsWith(`${base}/`)) x = x.slice(base.length + 1);
  return x;
};

// O primeiro par de caminhos que se cruzam, ou null.
export function cruzam(a, b, raiz = '') {
  const base = normalizar(String(raiz || '').replace(/\\/g, '/')).replace(/\/+$/, '');
  const A = a.map((x) => limpar(x, base)).filter(Boolean);
  const B = b.map((x) => limpar(x, base)).filter(Boolean);
  for (const x of A) {
    for (const y of B) {
      if (x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) return [x, y];
      // Só o nome do arquivo de um lado: o mesmo nome no fim do outro.
      if ((!x.includes('/') && y.endsWith(`/${x}`)) || (!y.includes('/') && x.endsWith(`/${y}`))) return [x, y];
    }
  }
  return null;
}

// Dois Agent na mesma mensagem rodam o PreToolUse ao mesmo tempo: conferir e anotar ficam
// dentro de uma trava de arquivo (criada com 'wx'), para o segundo ver o primeiro. Sem
// conseguir a trava em 3 segundos, segue sem ela.
function comTrava(sessao, fn) {
  const arq = path.join(pastaDiario(), 'estado', `${sessao}.paralelo-trava`);
  try { fs.mkdirSync(path.dirname(arq), { recursive: true }); } catch { /* segue */ }
  const limite = Date.now() + 3000;
  let fd = null;
  while (fd === null) {
    try {
      fd = fs.openSync(arq, 'wx');
    } catch (e) {
      if (!e || e.code !== 'EEXIST') break;
      try { if (Date.now() - fs.statSync(arq).mtimeMs > 10000) { fs.rmSync(arq, { force: true }); continue; } } catch { /* sumiu */ }
      if (Date.now() > limite) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* fechado */ } try { fs.rmSync(arq, { force: true }); } catch { /* segue */ } }
  }
}

// Implementadores em segundo plano que ainda rodam nesta sessão.
function ativos(sessao) {
  const fim = new Set(anotacoes(sessao, 'ativos-fim'));
  const agora = Date.now();
  return anotacoes(sessao, 'ativos').map(lerJson).filter((x) => x && x.marca && Array.isArray(x.escopo) && agora - x.em < DUAS_HORAS && !fim.has(x.marca));
}

// Antes da ferramenta Agent do mestre (implementador): { decisao, motivo, registro } ou null.
export function decidirParalelo(entrada) {
  if (!/^(Agent|Task)$/.test(String(entrada.tool_name || ''))) return null;
  if (tipoDoAgente(entrada) !== 'mestre' || desligada('paralelo')) return null;
  const ti = entrada.tool_input || {};
  if (String(ti.subagent_type || '') !== 'implementador') return null;
  const prompt = String(ti.prompt || '');
  // Só caminhos de verdade: "Node.js" no escopo não cruza com outro "Node.js".
  const escopo = escopoReal(prompt);
  const sessao = chaveDaSessao(entrada);
  if (!sessao || !escopo.length) return null;
  const marca = marcaDoTexto(prompt);
  const raiz = raizGit(entrada.cwd || process.cwd()) || '';
  return comTrava(sessao, () => conferir(sessao, ti, escopo, marca, raiz));
}

function conferir(sessao, ti, escopo, marca, raiz) {
  let registro = null;
  for (const a of ativos(sessao)) {
    if (a.marca === marca) continue;
    const c = cruzam(escopo, a.escopo, raiz);
    if (!c) continue;
    if (anotacoes(sessao, 'paralelo-barrou').includes(marca)) { registro = 'valvula'; break; }
    anotar(sessao, 'paralelo-barrou', marca);
    return {
      decisao: 'deny',
      motivo: `Barrado pela equipe: outro implementador em segundo plano ainda trabalha em ${c[1]}, e este briefing também toca ${c[0]}. Dois agentes no mesmo arquivo se atropelam. Espere o outro terminar, junte as duas tarefas num só implementador ou separe os escopos. Se o outro já terminou (ou você tem certeza de que não se cruzam), mande este mesmo briefing de novo: ele passa e fica registrado.`,
      registro: 'barrou',
    };
  }
  // Em segundo plano, fica anotado até terminar (em primeiro plano o mestre espera por ele).
  if (ti.run_in_background) anotar(sessao, 'ativos', JSON.stringify({ marca, escopo: escopo.slice(0, 30), em: Date.now() }));
  return registro ? { decisao: null, registro } : null;
}

// A ferramenta Agent falhou (o implementador nem começou): sai da lista.
export function falhaAoLancar(entrada) {
  const ti = entrada.tool_input || {};
  if (String(ti.subagent_type || '') !== 'implementador' || !ti.run_in_background) return false;
  const sessao = chaveDaSessao(entrada);
  if (!sessao) return false;
  anotar(sessao, 'ativos-fim', marcaDoTexto(String(ti.prompt || '')));
  return true;
}

// Fim do implementador: sai da lista dos que rodam (pela marca do briefing; se ela não bater,
// pelo mesmo escopo).
export function fimDoImplementadorParalelo(entrada) {
  const sessao = chaveDaSessao(entrada);
  if (!sessao) return;
  const lista = ativos(sessao);
  if (!lista.length) return;
  const briefing = briefingDaTranscricao(entrada.agent_transcript_path);
  if (!briefing) return;
  const marca = marcaDoTexto(briefing);
  const chaveEscopo = (xs) => xs.map((x) => limpar(x, '')).sort().join('|');
  const meu = chaveEscopo(escopoReal(briefing));
  const achado = lista.find((a) => a.marca === marca) || lista.find((a) => meu && chaveEscopo(a.escopo) === meu);
  if (achado) anotar(sessao, 'ativos-fim', achado.marca);
}
