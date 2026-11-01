// Trava do briefing (roda pelo despachante equipe-pre.mjs, na ferramenta Agent do mestre).
//
// O retrabalho quase sempre nasce de briefing vago. Antes de criar o agente, confere:
// - implementador: Objetivo, Escopo (com ao menos um caminho), Critério de aceite e Como
//   verificar (uma linha de .claude/verificador-comandos.txt, ou "nenhum" com o motivo);
// - verificador: ao menos uma linha exata da lista do verificador;
// - revisor: o caminho do diff, e o arquivo precisa existir;
// - Explore: um tamanho mínimo, para evitar "procure X" sem contexto.
// Ao barrar, devolve o modelo pronto para copiar. Rótulos tolerantes (maiúsculas, acento,
// plural, negrito). Válvula: o mesmo briefing mandado de novo passa e fica registrado.
// Trava de economia: erro ou dúvida deixa passar.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { anotacoes, anotar, chaveDaChamada, desligada, fatosRapidos, normalizar, tipoDoAgente } from './equipe-comum.mjs';

const MIN_EXPLORE = 60;

// Rótulos conhecidos (texto já sem acento e em minúsculas).
const ROTULOS = {
  objetivo: 'objetivos?',
  contexto: 'contexto(?: minimo)?',
  escopo: 'escopos?',
  criterio: 'criterios? de aceit(?:e|acao)',
  verificar: 'como verificar|verificacao',
  formato: 'formato(?: do retorno)?',
  ferramentas: 'ferramentas(?: a usar primeiro)?',
  jaTentado: 'ja tentad[oa]s?|tentativas? anteriores|o que ja foi tentado',
};
const rotulo = (padrao) => new RegExp(`(?:^|\\n)[ \\t>*#\\-\\d.)]*\\**\\s*(?:${padrao})\\s*\\**\\s*(?:\\([^)\\n]*\\))?\\s*\\**\\s*[:\\-–—]`, 'g');

// Texto de cada seção rotulada do briefing (sem acento, minúsculo).
export function secoes(texto) {
  const t = `\n${normalizar(texto)}`;
  const achados = [];
  for (const [nome, padrao] of Object.entries(ROTULOS)) {
    for (const m of t.matchAll(rotulo(padrao))) achados.push({ nome, inicio: m.index, fim: m.index + m[0].length });
  }
  achados.sort((a, b) => a.inicio - b.inicio);
  const r = {};
  achados.forEach((a, i) => {
    const corpo = t.slice(a.fim, i + 1 < achados.length ? achados[i + 1].inicio : t.length).trim();
    r[a.nome] = r[a.nome] ? `${r[a.nome]}\n${corpo}` : corpo;
  });
  return r;
}

// Caminhos citados num texto: algo com barra (com a letra do drive, se houver) ou um nome
// de arquivo com extensão. Entre crases ou aspas, o caminho vale inteiro, mesmo com espaço.
export function caminhos(texto) {
  const t = String(texto || '');
  const r = [];
  const limpar = (c) => c.trim().replace(/[\\]+/g, '/').replace(/[.,;:]+$/, '');
  for (const m of t.matchAll(/`([^`\n]+)`|"([^"\n]+)"/g)) {
    const c = limpar(m[1] ?? m[2]);
    if (/[\\/]/.test(m[1] ?? m[2]) && !/\s{2,}|^https?:/.test(c) && c.length < 300) r.push(c);
  }
  for (const m of t.matchAll(/[`'"]?((?:[A-Za-z]:)?[A-Za-z0-9_.~$@-]*[\\/][A-Za-z0-9_.\\/*@-]+|[A-Za-z0-9_-][A-Za-z0-9_.-]*\.[A-Za-z][A-Za-z0-9]{0,5})\b[`'"]?/g)) {
    const c = limpar(m[1]);
    if (c && !/^\d+(\.\d+)*$/.test(c) && !/^https?:/.test(c)) r.push(c);
  }
  return [...new Set(r)];
}

const espaco = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const contemLinha = (texto, comandos) => {
  const t = espaco(texto);
  return (comandos || []).some((c) => c && t.includes(espaco(c)));
};

function modelo(tipo, comandos) {
  if (tipo === 'implementador') {
    const verif = comandos && comandos.length ? `<uma linha de .claude/verificador-comandos.txt, como: ${comandos[0]}>` : '<comando que prova o critério, ou "nenhum: motivo">';
    return [
      'Objetivo: <uma frase e para que serve>',
      'Contexto: <caminhos:linhas, decisões já tomadas, nota de área>',
      'Escopo: <arquivos ou pastas que pode tocar>; fora do escopo: <o que não pode>',
      'Critério de aceite: <teste, comando ou comportamento verificável>',
      `Como verificar: ${verif}`,
    ].join('\n');
  }
  if (tipo === 'verificador') return `Rode: <linha exata de .claude/verificador-comandos.txt${comandos && comandos.length ? `, como: ${comandos[0]}` : ''}>\nDevolva: passou ou falhou, com contagem e as falhas.`;
  if (tipo === 'revisor') return 'Diff: .revisao/diff.patch (grave antes com git diff HEAD --output=.revisao/diff.patch)\nArquivos novos: <lista>\nObjetivo e critério de aceite: <...>\nRegras do projeto que a mudança toca: <...>';
  return 'Pergunta: <o que achar, em uma frase>\nPor onde começar: <pasta, arquivo ou símbolo>\nFerramentas a usar primeiro: o mapa do código (se o projeto tiver)\nResposta esperada: <caminho:linha de cada ponto>';
}

// O que falta no briefing deste tipo de agente.
export function faltas(tipo, texto, { comandos = null, cwd = process.cwd(), raiz = null } = {}) {
  const f = [];
  if (tipo === 'implementador') {
    const s = secoes(texto);
    if (!s.objetivo) f.push('"Objetivo"');
    if (!s.escopo) f.push('"Escopo"');
    else if (!caminhos(s.escopo).length) f.push('ao menos um caminho de arquivo ou pasta no "Escopo"');
    if (!s.criterio) f.push('"Critério de aceite"');
    if (!s.verificar) f.push('"Como verificar"');
    else if (!/\bnenhum\b\W+\w+/.test(s.verificar) && comandos && comandos.length && !contemLinha(s.verificar, comandos.map(normalizar))) {
      f.push('em "Como verificar", uma linha de .claude/verificador-comandos.txt (ou "nenhum" com o motivo)');
    }
  } else if (tipo === 'verificador') {
    if (comandos && comandos.length && !contemLinha(texto, comandos)) f.push('ao menos uma linha exata de .claude/verificador-comandos.txt, copiada caractere por caractere');
  } else if (tipo === 'revisor') {
    const diffs = caminhos(texto).filter((c) => /\.(patch|diff)$/i.test(c));
    if (!diffs.length) f.push('o caminho do diff (normalmente .revisao/diff.patch)');
    else {
      const existe = diffs.some((d) => [cwd, raiz].filter(Boolean).some((base) => {
        try { return fs.statSync(path.resolve(base, d)).isFile(); } catch { return false; }
      }));
      if (!existe) f.push(`um diff que exista: ${diffs[0]} não foi encontrado (grave com git diff HEAD --output=.revisao/diff.patch)`);
    }
  } else if (tipo === 'Explore') {
    if (espaco(texto).length < MIN_EXPLORE) f.push('contexto: o que achar, por onde começar e para que serve (o Explore não vê a conversa)');
  }
  return f;
}

export function decidirBriefing(entrada) {
  if (!/^(Agent|Task)$/.test(String(entrada.tool_name || ''))) return null;
  if (tipoDoAgente(entrada) !== 'mestre' || desligada('briefing')) return null;
  const ti = entrada.tool_input || {};
  const tipo = String(ti.subagent_type || '');
  if (!['implementador', 'verificador', 'revisor', 'Explore'].includes(tipo)) return null;
  const texto = String(ti.prompt || '');
  const cwd = entrada.cwd || process.cwd();
  const fatos = tipo === 'Explore' ? null : fatosRapidos(cwd);
  const falta = faltas(tipo, texto, { comandos: fatos ? fatos.comandos : null, cwd, raiz: fatos ? fatos.raiz : null });
  if (!falta.length) return null;
  const chave = chaveDaChamada(entrada);
  const marca = crypto.createHash('sha1').update(`${tipo}\n${texto}`).digest('hex').slice(0, 16);
  if (chave && anotacoes(chave, 'briefing-barrado').includes(marca)) {
    return { decisao: null, registro: 'valvula' };
  }
  anotar(chave, 'briefing-barrado', marca);
  return {
    decisao: 'deny',
    motivo: `Briefing barrado pela equipe (${tipo}): falta ${falta.join('; ')}. O agente começa sem nada da conversa. Refaça o briefing com este modelo e mande de novo:\n${modelo(tipo, fatos ? fatos.comandos : null)}\nSe o briefing está certo e a trava errou, mande o mesmo texto de novo: ele passa e fica registrado.`,
    registro: 'barrou',
  };
}
