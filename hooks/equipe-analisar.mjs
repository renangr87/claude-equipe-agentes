// Analisador logo depois de cada edição (roda pelo equipe-pos.mjs, depois de Edit e Write
// do mestre e do implementador): roda o analisador só no arquivo alterado e devolve os
// erros na hora para quem editou, em até 15 linhas. Erro achado cedo não vira rodada de
// verificador → implementador.
//
// Por tipo: .dart com "dart analyze <arquivo>"; .ts e .js com o eslint do projeto
// (node_modules/.bin), se existir; .py com "ruff check", se estiver instalado. O arquivo
// .claude/analisar.json do projeto, em commit, pode trocar o comando por extensão:
//   { ".dart": ["dart", "analyze", "{arquivo}"] }
// Como ele roda sozinho, sem pedido de aprovação, o comando do projeto só pode chamar um
// analisador conhecido (lista PROGRAMAS) e nunca por um caminho: um repositório clonado não
// consegue fazer a equipe rodar outro programa. Só erros, não avisos. Até 15 segundos. Sem
// analisador, fica calado.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { desligada, ehCodigo, git, lerJson, tipoDoAgente } from './equipe-comum.mjs';

const LIMITE_MS = 15000;
const MAX_LINHAS = 15;
const JS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte']);
// Analisadores que o .claude/analisar.json pode chamar (pelo nome, achados no PATH).
const PROGRAMAS = new Set(['dart', 'flutter', 'eslint', 'ruff', 'tsc', 'biome', 'oxlint', 'mypy', 'pyright', 'shellcheck', 'golangci-lint']);

// No Windows, .cmd e .bat só rodam pelo shell: os argumentos vão entre aspas, e argumento
// com aspas, % ou ! não roda (o cmd expandiria).
function executar(programa, args, cwd) {
  const win = process.platform === 'win32';
  if (win && [programa, ...args].some((a) => /["%!^]/.test(a))) return null;
  const r = win
    ? spawnSync(`"${programa}"`, args.map((a) => `"${a}"`), { cwd, encoding: 'utf8', timeout: LIMITE_MS, shell: true, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    : spawnSync(programa, args, { cwd, encoding: 'utf8', timeout: LIMITE_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (r.error || r.status === null) return null;
  return { status: r.status, saida: `${r.stdout || ''}\n${r.stderr || ''}` };
}

// Programa no PATH (ou null). No Windows prefere .exe, depois .cmd e .bat.
export function acharPrograma(nome) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const pasta of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const e of exts) {
      const c = path.join(pasta, nome + e);
      try { if (fs.statSync(c).isFile()) return c; } catch { /* segue */ }
    }
  }
  return null;
}

// Comando do projeto (.claude/analisar.json em commit) para esta extensão, ou null.
function comandoDoProjeto(raiz, ext) {
  const rel = '.claude/analisar.json';
  const cfg = lerJson(path.join(raiz, rel));
  if (!cfg || !Array.isArray(cfg[ext]) || !cfg[ext].length || !cfg[ext].every((a) => typeof a === 'string')) return null;
  const [programa, ...args] = cfg[ext];
  // Só um analisador conhecido, pelo nome; "node --check {arquivo}" só confere a sintaxe.
  const conhecido = PROGRAMAS.has(programa) || (programa === 'node' && args.length === 2 && args[0] === '--check' && args[1] === '{arquivo}');
  if (!conhecido) return null;
  // Como a lista do verificador: só vale em commit, sem mudança fora dele.
  if (git(['ls-files', '--error-unmatch', '--', rel], raiz) === null) return null;
  if (git(['status', '--porcelain', '--', rel], raiz) !== '') return null;
  return cfg[ext];
}

// { nome, programa, args, filtro } para o arquivo, ou null.
export function analisadorPara(arquivo, raiz) {
  const ext = path.extname(arquivo).toLowerCase();
  const doProjeto = comandoDoProjeto(raiz, ext);
  if (doProjeto) {
    const programa = acharPrograma(doProjeto[0]);
    if (!programa) return null;
    return { nome: doProjeto.join(' '), programa, args: doProjeto.slice(1).map((a) => a.replace('{arquivo}', arquivo)), filtro: null };
  }
  if (ext === '.dart') {
    const dart = acharPrograma('dart');
    return dart ? { nome: 'dart analyze', programa: dart, args: ['analyze', arquivo], filtro: /^\s*error\s+-\s/i } : null;
  }
  if (JS.has(ext)) {
    const bin = path.join(raiz, 'node_modules', '.bin', process.platform === 'win32' ? 'eslint.cmd' : 'eslint');
    return fs.existsSync(bin) ? { nome: 'eslint', programa: bin, args: ['--quiet', arquivo], filtro: /\berror\b/i, so: 1 } : null;
  }
  if (ext === '.py') {
    const ruff = acharPrograma('ruff');
    return ruff ? { nome: 'ruff check', programa: ruff, args: ['check', '--quiet', '--output-format', 'concise', arquivo], filtro: /:\d+:\d+:/, so: 1 } : null;
  }
  return null;
}

// Texto para quem editou, ou null (sem erro, sem analisador, ou não se aplica).
export function analisar(entrada) {
  if (!/^(Edit|Write|MultiEdit)$/.test(String(entrada.tool_name || ''))) return null;
  const tipo = tipoDoAgente(entrada);
  if ((tipo !== 'mestre' && tipo !== 'implementador') || desligada('analisar')) return null;
  const arquivo = String((entrada.tool_input || {}).file_path || '');
  if (!arquivo || !ehCodigo(arquivo) || /[\\/](node_modules|build|dist|\.dart_tool)[\\/]/.test(arquivo)) return null;
  try { if (!fs.statSync(arquivo).isFile()) return null; } catch { return null; }
  const cwd = entrada.cwd || process.cwd();
  const raiz = git(['rev-parse', '--show-toplevel'], path.dirname(arquivo)) || cwd;
  const a = analisadorPara(arquivo, raiz);
  if (!a) return null;
  const r = executar(a.programa, a.args, raiz);
  // Sem resposta, estouro do tempo ou erro do próprio analisador (eslint e ruff saem com 2
  // quando a configuração quebra): calado.
  if (!r || r.status === 0 || (a.so && r.status !== a.so)) return null;
  const linhas = r.saida.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() && (a.filtro ? a.filtro.test(l) : true));
  if (!linhas.length) return null;
  const mais = linhas.length > MAX_LINHAS ? `\n(e mais ${linhas.length - MAX_LINHAS} linha(s))` : '';
  return `Analisador da equipe (${a.nome}) logo depois da edição de ${path.basename(arquivo)}: há erro. Corrija antes de seguir:\n${linhas.slice(0, MAX_LINHAS).join('\n')}${mais}`;
}
