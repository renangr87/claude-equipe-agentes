// Trava do briefing do revisor (roda pelo despachante equipe-pre.mjs, na ferramenta Agent do
// mestre, depois da trava do briefing).
//
// A revisão só vale para o que o revisor viu. Antes de criar o revisor da equipe, confere:
//   - o diff está em dia: o conteúdo de cada arquivo no diff (a linha "index" dele) é o de
//     agora; um diff de ontem, ou gravado antes da última edição, não serve;
//   - o diff cobre tudo o que a sessão mudou e que pede revisão; arquivo novo, que o
//     "git diff HEAD" não mostra, precisa estar citado no briefing;
//   - mudança em área sensível vai com model: opus.
// Ao barrar, diz o que falta e como gravar o diff de novo. Válvula: o mesmo briefing mandado
// de novo passa e fica registrado. Trava de retrabalho: erro ou dúvida deixa passar.
import fs from 'node:fs';
import path from 'node:path';
import { caminhos } from './equipe-briefing.mjs';
import { anotacoes, anotar, desligada, git, lerEstado, lerTexto, marcaDoTexto, normalizar, tipoDoAgente } from './equipe-comum.mjs';
import { baseEfetiva, chaveDaSessao, estadoDaRevisao, hashes, raizGit } from './equipe-entrega.mjs';

const posix = (p) => String(p).replace(/\\/g, '/');

// Arquivos de um diff do git com o hash do conteúdo novo (a linha "index a..b").
export function arquivosDoDiff(texto) {
  const r = new Map();
  let atual = null;
  for (const l of String(texto || '').split(/\r?\n/)) {
    const d = l.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (d) { atual = d[2]; r.set(atual, ''); continue; }
    const i = l.match(/^index [0-9a-f]+\.\.([0-9a-f]+)/);
    if (i && atual) r.set(atual, i[1]);
  }
  return r;
}

const existeArquivo = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

export function decidirRevisor(entrada) {
  if (!/^(Agent|Task)$/.test(String(entrada.tool_name || ''))) return null;
  if (tipoDoAgente(entrada) !== 'mestre' || desligada('revisao')) return null;
  const ti = entrada.tool_input || {};
  if (String(ti.subagent_type || '') !== 'revisor') return null;
  const sessao = chaveDaSessao(entrada);
  if (!sessao) return null;
  const prompt = String(ti.prompt || '');
  const cwd = entrada.cwd || process.cwd();
  const e = estadoDaRevisao(entrada);
  const bases = Object.keys(lerEstado(sessao, 'base') || {});
  const proj = process.env.CLAUDE_PROJECT_DIR;
  const pastas = [cwd, raizGit(cwd), ...bases, ...(proj && raizGit(proj) ? [proj] : [])].filter(Boolean);
  const faltas = [];

  // Os diffs citados que existem, cada um com o repositório dele.
  const diffs = [];
  for (const d of caminhos(prompt).filter((c) => /\.(patch|diff)$/i.test(c))) {
    const achado = pastas.map((b) => path.resolve(b, d)).find(existeArquivo);
    if (achado) diffs.push({ arquivo: achado, raiz: raizGit(path.dirname(achado)) || raizGit(cwd) });
  }
  const cobertos = new Map();
  // Sem saber o repositório de um diff (git com erro), não dá para conferir a cobertura.
  let conferirCobertura = diffs.length > 0;
  for (const d of diffs) {
    if (!d.raiz) { conferirCobertura = false; continue; }
    const doDiff = arquivosDoDiff(lerTexto(d.arquivo));
    const ja = cobertos.get(d.raiz) || new Set();
    // Arquivo que não é arquivo comum (submódulo, pasta) não tem hash para comparar.
    const comHash = [...doDiff].filter(([rel, h]) => h && !/^0+$/.test(h) && existeArquivo(path.join(d.raiz, rel))).map(([rel]) => rel);
    const agora = hashes(d.raiz, comHash);
    const velhos = [];
    for (const [rel, h] of doDiff) {
      ja.add(rel);
      // Git com erro ou sem tempo: não dá para saber se o diff está velho.
      if (!h || !agora) continue;
      if (/^0+$/.test(h)) { if (existeArquivo(path.join(d.raiz, rel))) velhos.push(rel); continue; }
      if (!comHash.includes(rel)) continue;
      if (!agora[rel] || !agora[rel].startsWith(h)) velhos.push(rel);
    }
    cobertos.set(d.raiz, ja);
    if (velhos.length) faltas.push(`o diff ${path.basename(d.arquivo)} está velho: ${velhos.slice(0, 5).join(', ')} mudou depois dele`);
  }

  // O que já foi revisado (aprovado) e não mudou desde então não precisa entrar de novo.
  const revisado = (lerEstado(sessao, 'revisado') || {}).conteudo || {};
  const pendentes = e ? e.arquivos.filter((a) => !(revisado[a.chave] && e.conteudo[a.chave] && revisado[a.chave] === e.conteudo[a.chave])) : [];
  if (pendentes.length) {
    // Tudo o que pede revisão está no diff ou citado no briefing (os arquivos novos).
    if (conferirCobertura) {
      const texto = normalizar(posix(prompt));
      const fora = pendentes.filter((a) => {
        const ja = cobertos.get(a.raiz);
        if (ja && ja.has(a.rel)) return false;
        return !texto.includes(normalizar(a.rel)) && !texto.includes(normalizar(path.basename(a.rel)));
      });
      if (fora.length) faltas.push(`o diff não inclui ${fora.slice(0, 5).map((a) => a.rel).join(', ')}${fora.length > 5 ? ' ...' : ''} (arquivo novo: liste em "Arquivos novos"; já commitado: grave o diff a partir da base da sessão)`);
    }
    const sensiveis = pendentes.filter((a) => a.sensivel).map((a) => a.rel);
    if (sensiveis.length && !/opus/i.test(String(ti.model || ''))) faltas.push(`a mudança toca área sensível (${sensiveis.slice(0, 3).join(', ')}): chame o revisor com model: opus`);
  }
  if (!faltas.length) return null;
  const marca = marcaDoTexto(`${ti.model || ''}\n${prompt}`);
  if (anotacoes(sessao, 'revisor-barrado').includes(marca)) return { decisao: null, registro: 'valvula' };
  anotar(sessao, 'revisor-barrado', marca);
  const bruta = pendentes.length ? (lerEstado(sessao, 'base') || {})[pendentes[0].raiz] : null;
  const base = bruta ? baseEfetiva(pendentes[0].raiz, bruta) : null;
  const comando = base && base !== 'HEAD' && git(['rev-parse', 'HEAD'], pendentes[0].raiz) !== base
    ? `git diff ${String(base).slice(0, 12)} --output=.revisao/diff.patch`
    : 'git diff HEAD --output=.revisao/diff.patch';
  return {
    decisao: 'deny',
    motivo: `Revisor barrado pela equipe: ${faltas.join('; ')}. A revisão só vale para o que o revisor vê. Grave o diff de novo (${comando}), liste os arquivos novos e mande de novo. Se a trava errou, mande o mesmo briefing de novo: ele passa e fica registrado.`,
    registro: 'barrou',
  };
}
