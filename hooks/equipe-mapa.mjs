// Travas de leitura de código da equipe (rodam pelo despachante equipe-pre.mjs):
//
// 1. "Mapa primeiro" no Explore e no revisor: em projeto médio ou grande com o mapa do
//    código instalado, a primeira leitura de código (Read, Grep ou Glob) de cada chamada só
//    passa depois de uma consulta ao mapa. A consulta é anotada pelo equipe-pos.mjs, depois
//    que a ferramenta do mapa deu certo. O revisor lendo um arquivo da própria mudança não
//    precisa do mapa (o mapa serve para achar quem depende dela). Válvula: se o mapa falhou
//    (a consulta deu erro), a segunda tentativa passa e fica registrada como fuga; sem ter
//    tentado o mapa, a leitura é barrada mais uma vez e só passa na terceira ("fuga sem
//    tentar"), para a sessão nunca ficar presa quando as ferramentas do mapa nem existem.
// 2. Orçamento de leitura do mestre, por volume: em projeto médio ou grande, cada leitura de
//    código conta pelas linhas que mostra (Read com ou sem offset e limit, cat, sed -n, head,
//    tail, Get-Content, awk, busca com muito contexto, git show de um arquivo). Passando de
//    500 linhas no mesmo pedido, a próxima leitura é barrada e o mestre delega ao Explore.
//    A primeira leitura do pedido sempre passa, e reler o mesmo trecho não conta de novo.
//    Read sem limit conta até 2000 linhas (o que ele mostra); Read que falhou devolve a
//    conta; saída gravada em arquivo (cat a > b) e sed -i não contam.
//    Trecho pequeno quase não gasta: ler 40 linhas direto custa menos que chamar o Explore;
//    arquivo inteiro custa várias vezes mais no mestre. O pedido com "leia você mesmo" ou
//    "sem delegar" fica livre.
// Trava de economia: erro ou dúvida deixa passar.
import fs from 'node:fs';
import path from 'node:path';
import {
  anotacoes, anotar, caminhoReal, chaveDaChamada, desligada, EXTENSOES_CODIGO, ehCodigo, fatosRapidos, lerEstado, tipoDoAgente,
} from './equipe-comum.mjs';
import { arquivosDaSessao, chaveDaSessao } from './equipe-entrega.mjs';

export const CONSULTAS = /^mcp__codebase-memory__(search_graph|search_code|trace_path|query_graph|get_code_snippet|detect_changes)$/;
// Tipos do ripgrep que não são código: busca restrita a eles passa.
const TIPOS_TEXTO = new Set(['md', 'markdown', 'json', 'yaml', 'toml', 'txt', 'html', 'css', 'xml', 'csv', 'log', 'ini', 'config', 'license', 'readme']);

const numero = (v, padrao) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : padrao);
export const LIMITE_MESTRE = () => numero(process.env.EQUIPE_MESTRE_LINHAS, 500);

const existeArquivo = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const naRevisao = (f) => /(^|[\\/])\.revisao[\\/]/.test(String(f));

// Um padrão de arquivo (glob) cita extensão de código? "**/*.dart", "*.{ts,tsx}".
function padraoDeCodigo(padrao) {
  const p = String(padrao || '');
  const exts = [];
  for (const m of p.matchAll(/\.\{([A-Za-z0-9,]+)\}/g)) exts.push(...m[1].split(','));
  for (const m of p.matchAll(/\.([A-Za-z0-9]+)(?=$|[\s,}/])/g)) exts.push(m[1]);
  return exts.some((e) => EXTENSOES_CODIGO.has(e.toLowerCase()));
}

// O que uma Read, Grep ou Glob vai ler de código; null se não é código (ou não dá para saber).
export function alvoDeCodigo(entrada) {
  const nome = String(entrada.tool_name || '');
  const ti = entrada.tool_input || {};
  if (nome === 'Read') {
    const f = String(ti.file_path || '');
    return f && ehCodigo(f) && !naRevisao(f) && existeArquivo(f) ? f : null;
  }
  if (nome === 'Grep') {
    const p = String(ti.path || '');
    if (naRevisao(p)) return null;
    if (ti.type) return TIPOS_TEXTO.has(String(ti.type).toLowerCase()) ? null : (p || '.');
    if (ti.glob) return padraoDeCodigo(ti.glob) ? (p || '.') : null;
    if (p && ehCodigo(p)) return p;
    // Um arquivo que não é código: passa. Pasta (ou nenhuma): a busca varre o código.
    if (p && existeArquivo(p)) return null;
    return p || '.';
  }
  if (nome === 'Glob') return padraoDeCodigo(ti.pattern) && !naRevisao(ti.path) ? String(ti.pattern) : null;
  return null;
}

const negar = (motivo) => ({ decisao: 'deny', motivo });

// Mapa primeiro (Explore e revisor). Devolve { decisao, motivo, registro } ou null.
export function decidirMapa(entrada) {
  const tipo = tipoDoAgente(entrada);
  if ((tipo !== 'Explore' && tipo !== 'revisor') || desligada('mapa')) return null;
  if (!/^(Read|Grep|Glob)$/.test(String(entrada.tool_name || ''))) return null;
  const chave = chaveDaChamada(entrada);
  if (!chave || anotacoes(chave, 'mapa').length) return null;
  if (!alvoDeCodigo(entrada)) return null;
  const f = fatosRapidos(entrada.cwd || process.cwd());
  if (!f || !f.mapaObrigatorio || !f.mapaDeclarado) return null;
  // O revisor lendo um arquivo que a sessão mudou: o diff já diz onde olhar.
  if (tipo === 'revisor' && String(entrada.tool_name) === 'Read' && daMudanca(entrada)) return null;
  const barradas = anotacoes(chave, 'mapa-barrou').length;
  if (barradas) {
    // O mapa foi tentado e falhou: a segunda tentativa passa e fica à vista.
    if (anotacoes(chave, 'mapa-falhou').length) {
      anotar(chave, 'mapa', 'fuga');
      return { decisao: null, registro: 'fuga' };
    }
    // Nem tentou: barra mais uma vez; na terceira passa (as ferramentas do mapa podem não
    // existir nesta sessão), registrada à parte.
    if (barradas >= 2) {
      anotar(chave, 'mapa', 'fuga-sem-tentar');
      return { decisao: null, registro: 'fuga-sem-tentar' };
    }
    anotar(chave, 'mapa-barrou');
    return {
      ...negar(`Trava da equipe: o mapa ainda não foi consultado nesta chamada. Rode index_status e depois ${tipo === 'revisor' ? 'detect_changes ou trace_path' : 'search_graph ou search_code'} antes de ler código. Se as ferramentas do mapa não existirem nesta sessão, repita esta leitura: ela passa e fica registrada; diga isso no relatório.`),
      registro: 'barrou',
    };
  }
  anotar(chave, 'mapa-barrou');
  const revisor = tipo === 'revisor';
  return {
    ...negar([
      `Trava da equipe: neste projeto (${f.codigo} arquivos de código${f.modulos.length > 1 ? `, ${f.modulos.length} módulos` : ''}) a busca no código começa pelo mapa.`,
      `Ordem: index_status; se o índice faltar ou estiver velho, index_repository em ${f.raiz};`,
      revisor ? 'depois detect_changes e trace_path para achar quem depende do que mudou;' : 'depois search_graph ou search_code para achar o ponto;',
      'e só então leia o trecho que o mapa apontou (Read com offset e limit).',
      revisor ? 'O diff em .revisao/, os arquivos da própria mudança e o que não é código (md, json, yaml) não passam por esta trava.' : 'O diff em .revisao/ e arquivos que não são código (md, json, yaml) não passam por esta trava.',
      'Se a consulta ao mapa der erro, repita esta leitura: ela passa e fica registrada como fuga do mapa; diga isso no relatório.',
    ].join(' ')),
    registro: 'barrou',
  };
}

// O arquivo lido é um dos que a sessão mudou?
function daMudanca(entrada) {
  const arq = String((entrada.tool_input || {}).file_path || '');
  const sessao = chaveDaSessao(entrada);
  if (!arq || !sessao) return false;
  const abs = caminhoReal(path.resolve(entrada.cwd || process.cwd(), arq));
  for (const [raiz, rels] of arquivosDaSessao(sessao)) {
    const rel = path.relative(caminhoReal(raiz), abs).replace(/\\/g, '/');
    if (rels.has(rel)) return true;
  }
  return false;
}

// A consulta ao mapa deu erro (PostToolUseFailure, pelo equipe-pos.mjs).
export function anotarFalhaDoMapa(entrada) {
  const tipo = tipoDoAgente(entrada);
  if ((tipo !== 'Explore' && tipo !== 'revisor') || !/^mcp__codebase-memory__/.test(String(entrada.tool_name || ''))) return false;
  const chave = chaveDaChamada(entrada);
  if (!chave) return false;
  anotar(chave, 'mapa-falhou');
  return true;
}

// Pedido atual do mestre (gravado pelo hook do envio do pedido).
function pedidoAtual(chave) {
  const p = lerEstado(chave, 'pedido');
  return p && typeof p.em === 'number' ? p : null;
}

const chaveArquivo = (f) => {
  const r = path.resolve(String(f));
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

// Linhas de um arquivo (até 2 MB lidos; acima disso, uma estimativa pelo tamanho).
function linhasDoArquivo(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return 0;
    if (st.size > 2 * 1024 * 1024) return Math.round(st.size / 40);
    const t = fs.readFileSync(abs, 'utf8');
    if (!t) return 0;
    return t.split('\n').length - (t.endsWith('\n') ? 1 : 0);
  } catch { return 0; }
}

const inteiro = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);
const limpo = (t) => String(t).replace(/^["']|["']$/g, '');
// Sem limit, o Read mostra até 2000 linhas; o Grep mostra até 250 (o head_limit padrão).
const LEITURA_PADRAO = 2000;
const GREP_PADRAO = 250;
// Busca com contexto: não se sabe quantos trechos vêm; conta 3 trechos do tamanho pedido.
const estimativaDeBusca = (ctx, total, teto = Infinity) => Math.min(total || Infinity, (2 * ctx + 1) * 3, teto);
// Anotação de uma leitura que falhou (equipe-pos.mjs): a conta dela volta.
const FALHOU = '!falhou';

// Programas que mostram o arquivo inteiro no terminal (o mesmo que um Read).
const MOSTRA_ARQUIVO = /^(cat|type|less|more|bat|nl|get-content|gc)$/i;
const BUSCA = /^(grep|egrep|rg|select-string|sls|findstr)$/i;

// Opções que levam um valor separado, por programa (o valor não é arquivo lido). As que não
// estão aqui não levam valor: "cat -n arquivo" mostra o arquivo.
const VALOR_GC = /^-(totalcount|head|first|tail|last|readcount|encoding|delimiter|filter|include|exclude|stream)$/i;
const VALOR_GREP = /^(-[efmdDABC]|--(regexp|file|max-count|after-context|before-context|context|include|exclude|exclude-dir|label))$/;
const VALOR_SLS = /^-(pattern|context|encoding|include|exclude|culture)$/i;
const OPCOES_COM_VALOR = {
  nl: /^-[bdfhilnsvw]$/,
  bat: /^(-[lHrm]|--(language|highlight-line|line-range|style|theme|tabs|wrap|terminal-width|color|decorations|paging|pager|map-syntax|file-name))$/,
  type: VALOR_GC,
  'get-content': VALOR_GC,
  gc: VALOR_GC,
  head: /^(-[nc]|--(lines|bytes))$/,
  tail: /^(-[ncs]|--(lines|bytes|pid|sleep-interval))$/,
  sed: /^(-[efl]|--(expression|file|line-length))$/,
  awk: /^-[Ffv]$/,
  grep: VALOR_GREP,
  egrep: VALOR_GREP,
  rg: /^(-[efgtTmABCMjdrE]|--(regexp|file|glob|iglob|type|type-not|max-count|after-context|before-context|context|max-columns|threads|max-depth|sort|sortr|engine|encoding|replace|pre|pre-glob|colors|path-separator|max-filesize|ignore-file|type-add))$/,
  'select-string': VALOR_SLS,
  sls: VALOR_SLS,
};

// Um arquivo de código citado no comando: o caminho absoluto, ou null.
function arquivoDeCodigo(t, cwd) {
  const arq = limpo(t);
  if (!arq || arq.startsWith('-') || naRevisao(arq) || !ehCodigo(arq)) return null;
  const abs = path.resolve(cwd, arq);
  return existeArquivo(abs) ? abs : null;
}

// Os arquivos de código de um argumento. Curinga só no nome vale (lib/*.dart); curinga na
// pasta não dá para saber e não conta.
function arquivosDoArgumento(t, cwd) {
  const arq = limpo(t);
  if (!/[*?]/.test(arq)) {
    const abs = arquivoDeCodigo(arq, cwd);
    return abs ? [abs] : [];
  }
  if (arq.startsWith('-') || naRevisao(arq) || /[*?[\]]/.test(path.dirname(arq))) return [];
  const molde = path.basename(arq).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  const re = new RegExp(`^${molde}$`, process.platform === 'win32' ? 'i' : '');
  try {
    const pasta = path.resolve(cwd, path.dirname(arq));
    return fs.readdirSync(pasta).filter((n) => re.test(n)).slice(0, 200)
      .map((n) => path.join(pasta, n)).filter((abs) => ehCodigo(abs) && existeArquivo(abs));
  } catch { return []; }
}

// Os arquivos de código que o comando recebe (fora os valores das opções).
function arquivosDosArgumentos(prog, args, cwd) {
  const comValor = OPCOES_COM_VALOR[prog];
  const r = [];
  for (let i = 0; i < args.length; i++) {
    if (comValor && comValor.test(args[i])) { i++; continue; }
    for (const abs of arquivosDoArgumento(args[i], cwd)) if (!r.includes(abs)) r.push(abs);
  }
  return r;
}

// A saída vai para um arquivo (> copia, >> log, &> x, *> x, | Out-File, | Set-Content,
// | Out-Null): não chega ao contexto. 2> e >&2 não contam (o erro aparece no terminal).
function saidaParaArquivo(estagios) {
  const ultimo = String(estagios[estagios.length - 1] || '').replace(/"[^"]*"|'[^']*'/g, '""');
  if (/^\s*(out-file|set-content|add-content|out-null)\b/i.test(ultimo)) return true;
  for (const m of ultimo.matchAll(/(\d*|&|\*)>>?\|?(&\d+)?/g)) {
    if (m[2]) continue;
    if (m[1] === '' || m[1] === '1' || m[1] === '&' || m[1] === '*') return true;
  }
  return false;
}

// Quantas linhas um head ou tail mostram: { n, sinal }. "tail -n +N" começa na linha N;
// "head -n -N" mostra tudo menos as N últimas. Sem número: 10.
function linhasDeHeadTail(args) {
  for (let i = 0; i < args.length; i++) {
    const x = limpo(args[i]);
    let v = null;
    let m;
    if ((x === '-n' || x === '--lines') && i + 1 < args.length) v = limpo(args[i + 1]);
    else if ((m = x.match(/^(?:-n|--lines=)([+-]?\d+)$/))) v = m[1];
    else if ((m = x.match(/^-(\d+)$/))) v = m[1];
    else if (/^\+\d+$/.test(x)) v = x;
    const mm = v === null ? null : String(v).match(/^([+-]?)(\d+)$/);
    if (mm) return { n: Number(mm[2]), sinal: mm[1] };
  }
  return { n: 10, sinal: '' };
}

// O trecho que um script de sed (-n 'a,bp', 'Nq') ou de awk (NR>=a && NR<=b, NR==a)
// mostra: { a, b } (b pode ser Infinity), ou null quando o script não diz.
function trechoDoScript(prog, args) {
  const comValor = OPCOES_COM_VALOR[prog];
  let script = '';
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    if (prog === 'sed' && /^(-e|--expression)$/.test(x)) { script = limpo(args[i + 1] || ''); break; }
    if (comValor && comValor.test(x)) { i++; continue; }
    if (x.startsWith('-')) continue;
    script = limpo(x);
    break;
  }
  let m;
  if (prog === 'sed') {
    const soOPedido = args.some((x) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(x) || x === '--quiet' || x === '--silent');
    if (soOPedido && (m = script.match(/^(\d+)(?:,(\d+|\$))?p$/))) return { a: Number(m[1]), b: m[2] === '$' ? Infinity : Number(m[2] || m[1]) };
    if ((m = script.match(/^(\d+)q$/))) return { a: 1, b: Number(m[1]) };
    return null;
  }
  if ((m = script.match(/NR\s*>=?\s*(\d+)\s*&&\s*NR\s*<=?\s*(\d+)/))) return { a: Number(m[1]), b: Number(m[2]) };
  if ((m = script.match(/NR\s*==\s*(\d+)/))) return { a: Number(m[1]), b: Number(m[1]) };
  return null;
}

// O trecho [a, b] que head, tail, sed ou awk deixam passar das linhas [ini, fim] que entram.
function trechoDoFiltro(prog, args, ini, fim) {
  if (prog === 'head' || prog === 'tail') {
    const { n, sinal } = linhasDeHeadTail(args);
    if (prog === 'head') return sinal === '-' ? [ini, fim - n] : [ini, Math.min(fim, ini + n - 1)];
    return sinal === '+' ? [ini + Math.max(1, n) - 1, fim] : [Math.max(ini, fim - n + 1), fim];
  }
  const t = trechoDoScript(prog, args);
  return t ? [ini + t.a - 1, Math.min(fim, ini + t.b - 1)] : [ini, fim];
}

// Divide o comando nos operadores dados, fora de aspas ("awk 'NR>=1 && NR<=9'" fica inteiro).
function dividirForaDeAspas(texto, operadores) {
  const partes = [];
  let atual = '';
  let aspas = null;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === aspas) aspas = null;
      atual += c;
      continue;
    }
    if (c === '"' || c === "'") { aspas = c; atual += c; continue; }
    const op = operadores.find((o) => texto.startsWith(o, i));
    if (op) { partes.push(atual); atual = ''; i += op.length - 1; continue; }
    atual += c;
  }
  partes.push(atual);
  return partes;
}

// Intervalo [ini, fim] que um estágio seguinte do pipe deixa passar (Select-Object no
// PowerShell; head, tail, sed -n e awk no bash), dado o intervalo que entrou.
function cortePorPipe(estagio, ini, fim) {
  const t = estagio.trim().match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const prog = path.basename(limpo(String(t[0] || ''))).toLowerCase().replace(/\.exe$/, '');
  if (/^(head|tail|sed|awk)$/.test(prog)) return trechoDoFiltro(prog, t.slice(1), ini, fim);
  const valor = (re) => { const i = t.findIndex((x) => re.test(x)); return i >= 0 ? inteiro(t[i + 1]) : null; };
  if (prog === 'select-object' || prog === 'select') {
    const pular = valor(/^-skip$/i) || 0;
    const primeiras = valor(/^-first$/i);
    const ultimas = valor(/^-last$/i);
    const indice = t.findIndex((x) => /^-index$/i.test(x));
    if (indice >= 0) {
      const m = String(t[indice + 1] || '').match(/^\(?(\d+)\.\.(\d+)\)?$/);
      if (m) return [ini + Number(m[1]), Math.min(fim, ini + Number(m[2]))];
    }
    const a = ini + pular;
    if (primeiras) return [a, Math.min(fim, a + primeiras - 1)];
    if (ultimas) return [Math.max(a, fim - ultimas + 1), fim];
    return [a, fim];
  }
  return [ini, fim];
}

// O que esta ferramenta do mestre lê de código. Cada item: { chave, ini, fim } (as linhas
// de um arquivo) ou { chave, n } (uma estimativa, para busca com contexto). [] se não lê.
export function leiturasDoMestre(entrada) {
  const nome = String(entrada.tool_name || '');
  const ti = entrada.tool_input || {};
  let cwd = entrada.cwd || process.cwd();
  if (nome === 'Read') {
    const arq = String(ti.file_path || '');
    if (!arq || !ehCodigo(arq) || naRevisao(arq) || !existeArquivo(arq)) return [];
    const total = linhasDoArquivo(arq);
    if (!total) return [];
    const ini = Math.max(1, Number(ti.offset) || 1);
    // Sem limit, o Read mostra até 2000 linhas (com allow_large, o arquivo todo).
    const quantas = Number(ti.limit) > 0 ? Number(ti.limit) : ti.allow_large ? total : LEITURA_PADRAO;
    const fim = Math.min(total, ini + quantas - 1);
    return fim >= ini ? [{ chave: chaveArquivo(arq), ini, fim }] : [];
  }
  if (nome === 'Grep') {
    // Busca que devolve trechos grandes (-C 20, por exemplo) é leitura de arquivo.
    const ctx = Math.max(...['-C', 'context', '-A', '-B'].map((k) => Number(ti[k]) || 0));
    if (ti.output_mode !== 'content' || ctx < 10) return [];
    const alvo = alvoDeCodigo(entrada);
    if (!alvo) return [];
    const abs = path.resolve(cwd, alvo);
    // O Grep mostra no máximo head_limit linhas (250 sem ele; 0 é sem limite).
    const teto = Number(ti.head_limit) > 0 ? Number(ti.head_limit) : ti.head_limit === 0 ? Infinity : GREP_PADRAO;
    return [{ chave: `grep:${chaveArquivo(abs)}|${ti.pattern || ''}`, n: estimativaDeBusca(ctx, existeArquivo(abs) ? linhasDoArquivo(abs) : 0, teto) }];
  }
  if (nome !== 'Bash' && nome !== 'PowerShell') return [];
  const r = [];
  for (const sequencia of dividirForaDeAspas(String(ti.command || ''), ['&&', '||', ';', '\r', '\n'])) {
    const estagios = dividirForaDeAspas(sequencia, ['|']);
    const primeiro = estagios[0].trim();
    const t = primeiro.match(/"[^"]*"|'[^']*'|\S+/g) || [];
    if (!t.length) continue;
    const prog = path.basename(limpo(t[0])).toLowerCase().replace(/\.exe$/, '');
    const args = t.slice(1);
    // "cd pasta && cat arquivo": o arquivo é relativo à pasta nova.
    if (/^(cd|set-location|sl|pushd|chdir)$/.test(prog)) {
      const destino = limpo(args.find((x) => !x.startsWith('-')) || '');
      if (destino) cwd = path.resolve(cwd, destino);
      continue;
    }
    // Saída gravada num arquivo (cat a > copia) não chega ao contexto.
    if (saidaParaArquivo(estagios)) continue;
    const corte = (ini, fim) => estagios.slice(1).reduce(([a, b], e) => cortePorPipe(e, a, b), [ini, fim]);
    // O que cada arquivo manda para a saída, um depois do outro. O filtro (sed e awk contam as
    // linhas seguidas, de todos os arquivos) e os estágios do pipe cortam a saída inteira, não
    // cada arquivo: "cat a b | head -40" mostra 40 linhas.
    const emSequencia = (pedacos, filtro = null) => {
      const validos = pedacos.map((p) => ({ ...p, ini: Math.max(1, p.ini) })).filter((p) => p.fim >= p.ini);
      const total = validos.reduce((s, p) => s + p.fim - p.ini + 1, 0);
      if (!total) return;
      let [a, b] = filtro ? filtro(1, total) : [1, total];
      [a, b] = corte(a, b);
      let inicio = 1;
      for (const p of validos) {
        const n = p.fim - p.ini + 1;
        const x = Math.max(a, inicio);
        const y = Math.min(b, inicio + n - 1);
        if (y >= x) r.push({ chave: chaveArquivo(p.abs), ini: p.ini + x - inicio, fim: p.ini + y - inicio });
        inicio += n;
      }
    };
    // PowerShell: (Get-Content arquivo)[10..60]
    const idx = primeiro.match(/^\(\s*(?:get-content|gc|cat|type)\s+(?:-(?:literal)?path\s+)?("[^"]+"|'[^']+'|\S+?)\s*\)\s*\[\s*(\d+)\s*\.\.\s*(\d+)\s*\]/i);
    if (idx) {
      const abs = arquivoDeCodigo(idx[1], cwd);
      if (abs) emSequencia([{ abs, ini: Number(idx[2]) + 1, fim: Math.min(linhasDoArquivo(abs), Number(idx[3]) + 1) }]);
      continue;
    }
    const valorDe = (re) => { const i = args.findIndex((x) => re.test(x)); return i >= 0 ? inteiro(limpo(args[i + 1])) : null; };
    const arquivos = () => arquivosDosArgumentos(prog, args, cwd);
    if (MOSTRA_ARQUIVO.test(prog)) {
      const primeiras = valorDe(/^-(totalcount|head|first)$/i);
      const ultimas = valorDe(/^-(tail|last)$/i);
      emSequencia(arquivos().map((abs) => {
        const total = linhasDoArquivo(abs);
        return { abs, ini: ultimas ? total - ultimas + 1 : 1, fim: primeiras ? Math.min(total, primeiras) : total };
      }));
    } else if (prog === 'head' || prog === 'tail') {
      // head e tail cortam cada arquivo; o pipe depois corta a saída inteira.
      emSequencia(arquivos().map((abs) => {
        const [a, b] = trechoDoFiltro(prog, args, 1, linhasDoArquivo(abs));
        return { abs, ini: a, fim: b };
      }));
    } else if (prog === 'sed' || prog === 'awk') {
      // sed -i muda o arquivo no lugar e não mostra nada.
      if (prog === 'sed' && args.some((x) => /^-[a-zA-Z]*i/.test(x) || x.startsWith('--in-place'))) continue;
      emSequencia(arquivos().map((abs) => ({ abs, ini: 1, fim: linhasDoArquivo(abs) })), (a, b) => trechoDoFiltro(prog, args, a, b));
    } else if (BUSCA.test(prog)) {
      // Busca com muito contexto (-C 20, -A, -B, -Context 20) mostra trechos grandes.
      const ctx = Math.max(
        valorDe(/^-(C|A|B)$/) || 0,
        ...args.filter((x) => /^-[CAB]\d+$|^--context=\d+$/.test(x)).map((x) => Number(x.replace(/\D+/g, '')) || 0),
        ...(() => { const i = args.findIndex((x) => /^-context$/i.test(x)); return i >= 0 ? String(limpo(args[i + 1] || '')).split(',').map(Number).filter(Number.isFinite) : [0]; })(),
      );
      if (ctx < 10) continue;
      // Uma estimativa por busca, não por arquivo: com curinga (lib/*.dart) ou com vários
      // arquivos, os trechos que voltam são os que casam, não um bloco por arquivo.
      const total = arquivos().reduce((s, abs) => s + linhasDoArquivo(abs), 0);
      r.push({ chave: `busca:${chaveArquivo(cwd)}|${sequencia.trim()}`, n: estimativaDeBusca(ctx, total) });
    } else if (prog === 'git' && args.some((x) => x === 'show')) {
      // git show HEAD:lib/a.dart mostra o arquivo inteiro (de outra versão).
      for (const x of args) {
        const m = limpo(x).match(/^[^:\s]+:(.+)$/);
        if (!m || !ehCodigo(m[1])) continue;
        // O tamanho de agora serve de medida (a versão antiga não está no disco).
        const abs = path.resolve(cwd, m[1]);
        const total = existeArquivo(abs) ? linhasDoArquivo(abs) : 200;
        const [a, b] = corte(1, total);
        if (b >= a) r.push({ chave: `show:${limpo(x)}`, ini: a, fim: b });
      }
    }
  }
  return r;
}

// Linhas novas de um intervalo, fora dos que já foram lidos.
function novasLinhas(lidos, ini, fim) {
  const ordenados = [...lidos].sort((x, y) => x[0] - y[0]);
  let novas = 0;
  let cursor = ini;
  for (const [a, b] of ordenados) {
    if (b < cursor) continue;
    if (a > fim) break;
    if (a > cursor) novas += Math.min(fim, a - 1) - cursor + 1;
    cursor = Math.max(cursor, b + 1);
    if (cursor > fim) break;
  }
  if (cursor <= fim) novas += fim - cursor + 1;
  return Math.max(0, novas);
}

// Orçamento de leitura do mestre, por volume. Devolve { decisao, motivo, registro } ou null.
export function decidirOrcamento(entrada) {
  if (tipoDoAgente(entrada) !== 'mestre' || desligada('orcamento')) return null;
  const alvos = leiturasDoMestre(entrada);
  if (!alvos.length) return null;
  const chave = chaveDaChamada(entrada);
  if (!chave) return null;
  const pedido = pedidoAtual(chave);
  if (pedido && pedido.livre) return null;
  const f = fatosRapidos(entrada.cwd || process.cwd());
  if (!f || !f.mapaObrigatorio) return null;
  // Sem o registro do pedido (hook do envio ausente), vale a última meia hora.
  const desde = pedido ? pedido.em : Date.now() - 30 * 60000;
  // O que já foi lido neste pedido: intervalos por arquivo e estimativas por busca.
  const intervalos = new Map();
  const estimadas = new Map();
  // Cada anotação: quando, o que, quanto, e o id da ferramenta (a leitura que falhou volta).
  const linhas = anotacoes(chave, 'lidos').map((l) => l.split('\t'));
  const falharam = new Set(linhas.filter((c) => c[1] === FALHOU && c[3]).map((c) => c[3]));
  for (const [em, nome, quanto, id] of linhas) {
    if (!(Number(em) >= desde) || !nome || nome === FALHOU || (id && falharam.has(id))) continue;
    const m = String(quanto || '').match(/^(\d+)-(\d+)$/);
    if (m) {
      if (!intervalos.has(nome)) intervalos.set(nome, []);
      intervalos.get(nome).push([Number(m[1]), Number(m[2])]);
    } else {
      // Estimativa (~n) ou anotação antiga, sem o tamanho: conta 100 linhas.
      estimadas.set(nome, Number(String(quanto || '').replace('~', '')) || 100);
    }
  }
  // Linhas distintas já lidas em cada arquivo (trechos que se sobrepõem contam uma vez).
  let somaIntervalos = 0;
  for (const lista of intervalos.values()) {
    const vistos = [];
    for (const [a, b] of lista) { somaIntervalos += novasLinhas(vistos, a, b); vistos.push([a, b]); }
  }
  const total = somaIntervalos + [...estimadas.values()].reduce((x, v) => x + v, 0);
  let novas = 0;
  const anotar1 = [];
  for (const alvo of alvos) {
    const ch = String(alvo.chave).replace(/[\t\r\n]/g, ' ');
    if (typeof alvo.n === 'number') {
      if (estimadas.has(ch)) continue;
      estimadas.set(ch, alvo.n);
      novas += alvo.n;
      anotar1.push(`${ch}\t~${alvo.n}`);
    } else {
      const lista = intervalos.get(ch) || [];
      const n = novasLinhas(lista, alvo.ini, alvo.fim);
      if (!n) continue;
      lista.push([alvo.ini, alvo.fim]);
      intervalos.set(ch, lista);
      novas += n;
      anotar1.push(`${ch}\t${alvo.ini}-${alvo.fim}`);
    }
  }
  if (!novas) return null;
  const limite = LIMITE_MESTRE();
  // A primeira leitura do pedido sempre passa (uma mudança direta num arquivo conhecido).
  if (total > 0 && total + novas > limite) {
    return {
      ...negar(`Orçamento de leitura do mestre (trava da equipe): já são ${total} linhas de código lidas neste pedido, e esta leitura traz mais ${novas} (o limite é ${limite}, num projeto médio ou grande). Trecho pequeno gasta pouco: leia só as linhas que precisa (Read com offset e limit). Para entender um arquivo inteiro ou vários, delegue ao Explore, que usa o mapa, com uma pergunta precisa e o caminho por onde começar (ou ao implementador, se for para mudar o arquivo). Se o usuário pediu para você mesmo ler, ele precisa dizer "leia você mesmo" ou "sem delegar" no pedido.`),
      registro: 'barrou',
    };
  }
  const id = String(entrada.tool_use_id || '').replace(/\s+/g, '');
  for (const l of anotar1) anotar(chave, 'lidos', `${Date.now()}\t${l}\t${id}`);
  return null;
}

// Um Read do mestre que falhou (o arquivo passou do tamanho que o Read aceita, por exemplo)
// não mostrou nada: a conta dele volta (PostToolUseFailure, pelo equipe-pos.mjs).
export function devolverLeitura(entrada) {
  if (tipoDoAgente(entrada) !== 'mestre' || String(entrada.tool_name || '') !== 'Read') return false;
  const chave = chaveDaChamada(entrada);
  const id = String(entrada.tool_use_id || '').replace(/\s+/g, '');
  if (!chave || !id) return false;
  anotar(chave, 'lidos', `${Date.now()}\t${FALHOU}\t-\t${id}`);
  return true;
}

// Depois de uma consulta ao mapa que deu certo (equipe-pos.mjs).
export function anotarConsulta(entrada) {
  const tipo = tipoDoAgente(entrada);
  if (tipo !== 'Explore' && tipo !== 'revisor') return false;
  if (!CONSULTAS.test(String(entrada.tool_name || ''))) return false;
  const chave = chaveDaChamada(entrada);
  if (!chave || anotacoes(chave, 'mapa').length) return false;
  anotar(chave, 'mapa', 'consultou');
  return true;
}
