// Sobras de depuração (roda pelo equipe-pos.mjs e pelo fim do implementador, no
// equipe-entrega.mjs). Só avisa, nunca barra.
//   - Depois de cada edição do mestre ou do implementador: as linhas novas do arquivo (as
//     acrescentadas desde o último commit) com cara de depuração voltam como aviso na hora,
//     uma vez cada: console.log e debugger (JavaScript e TypeScript), print (Dart),
//     breakpoint() e pdb (Python), dbg! (Rust), var_dump e print_r (PHP), binding.pry
//     (Ruby), Wait-Debugger (PowerShell), Debugger.Break (C#) e o comentário que pede para
//     tirar ("// DEBUG", "# TEMP:", "remover depois", "remover antes do commit"). print e
//     console.log em arquivo de teste e em programa de linha de comando (bin/, scripts/,
//     tool/, cli/, arquivo com #!) não contam: ali a saída na tela é de propósito.
//   - Arquivo gravado com cara de temporário (.log, .tmp, .bak, .orig, .rej, nul) também.
//   - No fim do implementador, a lista do escopo diz as que ficaram nos arquivos dele e os
//     arquivos com cara de temporário na pasta, também os criados por comando.
// Erro vira silêncio.
import fs from 'node:fs';
import path from 'node:path';
import { anotacoes, anotar, caminhoReal, desligada, ehCodigo, git, marcaDoTexto, tipoDoAgente } from './equipe-comum.mjs';

const posix = (p) => String(p).replace(/\\/g, '/');
const TESTE = /(^|\/)(test|tests|spec|specs|__tests__|testes|integration_test|e2e|cypress|playwright)\/|[._-](test|spec|cy|e2e)\.[a-z0-9]+$|(^|\/)test_[^/]*$/i;
// Programa de linha de comando: escrever na tela é o trabalho dele. bin/ e tool/ (a pasta dos
// scripts de um pacote Dart) em qualquer lugar; cli/, scripts/, tools/ e ferramentas/ na raiz
// ou na raiz de um pacote de monorepo (packages/x/, apps/x/). lib/src/tools/ e src/scripts/
// costumam ser código do app.
const CLI = /(^|\/)(bin|tool)\/|^((packages|apps|libs|modules)\/[^/]+\/)?(cli|scripts?|tools|ferramentas)\//i;
const JS = /\.(m?[jt]sx?|cjs|vue|svelte|astro)$/i;
// O que quase sempre é sobra, por linguagem. saida: escrever na tela, que é de propósito em
// teste e em programa de linha de comando.
const PADROES = [
  { ext: JS, re: /\bconsole\.(log|debug|trace|dir)\s*\(/, saida: true },
  { ext: JS, re: /^\s*debugger\s*;?\s*$/ },
  { ext: /\.dart$/i, re: /^\s*print\s*\(/, saida: true },
  { ext: /\.py$/i, re: /\bbreakpoint\s*\(\s*\)|\b[ip]?pdb\.set_trace\s*\(|^\s*import\s+i?pdb\b/ },
  { ext: /\.rs$/i, re: /\bdbg!\s*\(/ },
  { ext: /\.php$/i, re: /\b(var_dump|print_r)\s*\(/ },
  { ext: /\.rb$/i, re: /\bbinding\.(pry|irb)\b|^\s*byebug\b/ },
  { ext: /\.(ps1|psm1)$/i, re: /\b(Wait-Debugger|Set-PSBreakpoint)\b/i },
  { ext: /\.cs$/i, re: /\bDebugger\.(Break|Launch)\s*\(/ },
];
// Comentário que pede para tirar, em qualquer linguagem: a marca em maiúsculas logo depois do
// sinal do comentário ("// DEBUG", "# TEMP:", "/* DEBUG */") ou o pedido com prazo ("remover
// depois", "tirar antes do commit", "remove before commit"). Palavra comum num comentário que
// explica o código ("// Remover itens duplicados", "-- temp table", "# Debug mode:",
// "TODO: remover quando a API v2 sair") não conta.
const MARCA = /(?:^|\s)(?:\/\/|#|--|\/\*|<!--)\s*(?:DEBUG|TEMP|TEMPORARIO|TEMPORÁRIO)\b(?=\s*(?::|-\s|\*\/|-->|$))/;
const PEDIDO_DE_TIRAR = /(?:^|\s)(?:\/\/|#|--|\/\*|<!--).*\b(?:remov(?:er|a|e)|tirar|tire|apagar|apague|delete)\s+(?:isto\s+|isso\s+|this\s+|me\s+)?(?:depois|antes\s+d[eo]\s+(?:commit|entregar|subir|merge)|before\s+(?:commit|merge)|later)\b/i;
// O sinal do comentário não pode estar dentro de um texto entre aspas ("use -- para tirar
// depois"): antes dele, cada tipo de aspas fecha.
function emComentario(t, re) {
  const m = re.exec(t);
  if (!m) return false;
  const antes = t.slice(0, m.index);
  return ['"', "'", '`'].every((q) => antes.split(q).length % 2 === 1);
}
// Arquivo com cara de temporário.
export const TEMPORARIO = /(^|\/)(nul|[^/]*\.(log|tmp|temp|bak|orig|rej|swp)|[^/]*~)$/i;
const MAX_LINHAS = 5000;

// As linhas acrescentadas desde o último commit: [{ n, texto }]. Arquivo fora do git: todas.
// Git com erro ou sem tempo: nenhuma (não dá para saber o que é novo).
export function linhasNovas(raiz, rel) {
  const noIndice = git(['--literal-pathspecs', 'ls-files', '--', rel], raiz);
  if (noIndice === null) return [];
  if (noIndice === '') {
    try {
      const abs = path.join(raiz, rel);
      if (fs.statSync(abs).size > 512 * 1024) return [];
      return fs.readFileSync(abs, 'utf8').split(/\r?\n/).slice(0, MAX_LINHAS).map((texto, i) => ({ n: i + 1, texto }));
    } catch { return []; }
  }
  const d = git(['--literal-pathspecs', 'diff', '-U0', '--no-color', '--no-ext-diff', 'HEAD', '--', rel], raiz, 3000);
  if (!d) return [];
  const r = [];
  let n = 0;
  let noBloco = false;
  for (const l of d.split(/\r?\n/)) {
    const m = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) { n = Number(m[1]); noBloco = true; continue; }
    // Antes do primeiro bloco vem o cabeçalho (diff --git, index, ---, +++). Depois, uma linha
    // nova que começa com "++" ("++i;") é linha nova como as outras.
    if (!noBloco) continue;
    if (l.startsWith('+')) { r.push({ n, texto: l.slice(1) }); n++; }
    if (r.length >= MAX_LINHAS) break;
  }
  return r;
}

// Programa de linha de comando: pela pasta, ou pelo #! na primeira linha.
function ehCli(raiz, rel) {
  if (CLI.test(posix(rel))) return true;
  try {
    const fd = fs.openSync(path.join(raiz, rel), 'r');
    try {
      const b = Buffer.alloc(2);
      return fs.readSync(fd, b, 0, 2, 0) === 2 && b.toString('latin1') === '#!';
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

// As sobras entre as linhas dadas de um arquivo: [{ rel, n, texto }]. saidaLivre: o arquivo
// é teste ou programa de linha de comando (escrever na tela é de propósito).
export function sobrasDasLinhas(rel, linhas, saidaLivre = TESTE.test(posix(rel)) || CLI.test(posix(rel))) {
  const r = [];
  for (const { n, texto } of linhas) {
    const t = String(texto || '');
    if (!t.trim() || t.length > 400) continue;
    if (PADROES.some((p) => p.ext.test(rel) && !(p.saida && saidaLivre) && p.re.test(t)) || emComentario(t, MARCA) || emComentario(t, PEDIDO_DE_TIRAR)) {
      r.push({ rel, n, texto: t.trim().slice(0, 80) });
    }
  }
  return r;
}

// As sobras de uma lista de arquivos (caminhos relativos à raiz).
export function sobrasDosArquivos(raiz, rels) {
  const r = [];
  for (const rel of rels.slice(0, 60)) {
    const p = posix(rel);
    if (/^\.revisao\//.test(p)) continue;
    if (TEMPORARIO.test(p)) { if (fs.existsSync(path.join(raiz, rel))) r.push({ rel: p, n: 0, texto: '' }); continue; }
    if (ehCodigo(p)) r.push(...sobrasDasLinhas(p, linhasNovas(raiz, rel), TESTE.test(p) || ehCli(raiz, rel)));
  }
  return r;
}

export function descrever(s) {
  return s.n ? `${s.rel}:${s.n} \`${s.texto}\`` : `${s.rel} (arquivo com cara de temporário)`;
}

// Depois de Edit, Write ou MultiEdit do mestre ou do implementador: o aviso (texto) ou null.
export function avisoDaEdicao(entrada) {
  if (desligada('sobras')) return null;
  const tipo = tipoDoAgente(entrada);
  if (tipo !== 'mestre' && tipo !== 'implementador') return null;
  if (!/^(Edit|Write|MultiEdit)$/.test(String(entrada.tool_name || ''))) return null;
  const arq = String((entrada.tool_input || {}).file_path || '');
  const s = String((entrada && entrada.session_id) || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!arq || !s || !fs.existsSync(arq)) return null;
  const raiz = git(['rev-parse', '--show-toplevel'], path.dirname(arq));
  if (!raiz) return null;
  const rel = posix(path.relative(caminhoReal(raiz), caminhoReal(arq)));
  if (!rel || rel.startsWith('..')) return null;
  const sessao = `${s}-sessao`;
  const avisadas = new Set(anotacoes(sessao, 'sobras-avisadas'));
  const novas = sobrasDosArquivos(raiz, [rel]).filter((x) => !avisadas.has(`${x.rel}|${marcaDoTexto(x.texto)}`));
  if (!novas.length) return null;
  for (const x of novas) anotar(sessao, 'sobras-avisadas', `${x.rel}|${marcaDoTexto(x.texto)}`);
  const quem = tipo === 'implementador' ? 'antes de entregar, ou diga no relatório por que ficam' : 'antes do commit, ou diga ao usuário por que ficam';
  return `Aviso da equipe (sobras de depuração): ${novas.slice(0, 6).map(descrever).join('; ')}${novas.length > 6 ? ` e mais ${novas.length - 6}` : ''}. Tire ${quem}. Se é de propósito, siga: o aviso não volta para estas linhas.`;
}
