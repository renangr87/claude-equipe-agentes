// Travas de leitura de código da equipe (rodam pelo despachante equipe-pre.mjs):
//
// 1. "Mapa primeiro" no Explore e no revisor: em projeto médio ou grande com o mapa do
//    código instalado, a primeira leitura de código (Read, Grep ou Glob) de cada chamada só
//    passa depois de uma consulta ao mapa. A consulta é anotada pelo equipe-pos.mjs, depois
//    que a ferramenta do mapa deu certo. Válvula: se o mapa não responder, a segunda
//    tentativa passa e fica registrada como fuga do mapa.
// 2. Orçamento de leitura do mestre: em projeto médio ou grande, depois de 3 arquivos de
//    código lidos no mesmo pedido, a leitura do próximo é barrada e o mestre delega ao
//    Explore. O pedido com "leia você mesmo" ou "sem delegar" fica livre.
// Trava de economia: erro ou dúvida deixa passar.
import fs from 'node:fs';
import path from 'node:path';
import {
  anotacoes, anotar, chaveDaChamada, desligada, EXTENSOES_CODIGO, ehCodigo, fatosRapidos, lerEstado, tipoDoAgente,
} from './equipe-comum.mjs';

export const CONSULTAS = /^mcp__codebase-memory__(search_graph|search_code|trace_path|query_graph|get_code_snippet|detect_changes)$/;
// Tipos do ripgrep que não são código: busca restrita a eles passa.
const TIPOS_TEXTO = new Set(['md', 'markdown', 'json', 'yaml', 'toml', 'txt', 'html', 'css', 'xml', 'csv', 'log', 'ini', 'config', 'license', 'readme']);

const numero = (v, padrao) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : padrao);
export const LIMITE_MESTRE = () => numero(process.env.EQUIPE_MESTRE_LEITURAS, 3);

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
  if (anotacoes(chave, 'mapa-barrou').length) {
    // Segunda tentativa: o mapa não respondeu (ou o agente insistiu). Passa e fica à vista.
    anotar(chave, 'mapa', 'fuga');
    return { decisao: null, registro: 'fuga' };
  }
  anotar(chave, 'mapa-barrou');
  const revisor = tipo === 'revisor';
  return {
    ...negar([
      `Trava da equipe: neste projeto (${f.codigo} arquivos de código${f.modulos.length > 1 ? `, ${f.modulos.length} módulos` : ''}) a busca no código começa pelo mapa.`,
      `Ordem: index_status; se o índice faltar ou estiver velho, index_repository em ${f.raiz};`,
      revisor ? 'depois detect_changes e trace_path para achar quem depende do que mudou;' : 'depois search_graph ou search_code para achar o ponto;',
      'e só então leia o trecho que o mapa apontou (Read com offset e limit).',
      'O diff em .revisao/ e arquivos que não são código (md, json, yaml) não passam por esta trava.',
      'Se o mapa não responder, repita esta leitura: ela passa e fica registrada como fuga do mapa; diga isso no relatório.',
    ].join(' ')),
    registro: 'barrou',
  };
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

// Programas que mostram o arquivo inteiro no terminal (o mesmo que um Read).
const MOSTRA_ARQUIVO = /^(cat|type|get-content|gc|head|tail|less|more|bat|nl)$/i;

// O que esta ferramenta do mestre lê de código: lista de chaves (arquivo, ou busca com muito
// contexto), ou [] se não lê código.
export function leiturasDoMestre(entrada) {
  const nome = String(entrada.tool_name || '');
  const ti = entrada.tool_input || {};
  const cwd = entrada.cwd || process.cwd();
  if (nome === 'Read') {
    const arq = String(ti.file_path || '');
    return arq && ehCodigo(arq) && !naRevisao(arq) && existeArquivo(arq) ? [chaveArquivo(arq)] : [];
  }
  if (nome === 'Grep') {
    // Busca que devolve trechos grandes (-C 20, por exemplo) é leitura de arquivo inteiro.
    const ctx = Math.max(...['-C', 'context', '-A', '-B'].map((k) => Number(ti[k]) || 0));
    if (ti.output_mode !== 'content' || ctx < 10) return [];
    const alvo = alvoDeCodigo(entrada);
    return alvo ? [`grep:${chaveArquivo(path.resolve(cwd, alvo))}`] : [];
  }
  if (nome === 'Bash' || nome === 'PowerShell') {
    const r = [];
    for (const parte of String(ti.command || '').split(/&&|\|\||[;|\r\n]/)) {
      const tokens = parte.trim().match(/"[^"]*"|'[^']*'|\S+/g) || [];
      if (!tokens.length || !MOSTRA_ARQUIVO.test(path.basename(tokens[0]))) continue;
      for (const t of tokens.slice(1)) {
        const arq = t.replace(/^["']|["']$/g, '');
        if (arq.startsWith('-')) continue;
        const abs = path.resolve(cwd, arq);
        if (ehCodigo(arq) && !naRevisao(arq) && existeArquivo(abs)) r.push(chaveArquivo(abs));
      }
    }
    return r;
  }
  return [];
}

// Orçamento de leitura do mestre (Read, busca com muito contexto e cat pelo terminal).
// Devolve { decisao, motivo, registro } ou null.
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
  const lidos = new Set();
  for (const l of anotacoes(chave, 'lidos')) {
    const [em, nome] = l.split('\t');
    if (Number(em) >= desde && nome) lidos.add(nome);
  }
  const novos = [...new Set(alvos)].filter((a) => !lidos.has(a));
  if (!novos.length) return null;
  const limite = LIMITE_MESTRE();
  if (lidos.size + novos.length > limite) {
    return {
      ...negar(`Orçamento de leitura do mestre (trava da equipe): já são ${lidos.size} arquivos de código lidos neste pedido, num projeto médio ou grande (cat pelo terminal e busca com muito contexto contam como leitura). Não leia mais código direto: delegue ao Explore, que usa o mapa, com uma pergunta precisa e o caminho por onde começar (ou ao implementador, se for para mudar o arquivo). Se o usuário pediu para você mesmo ler, ele precisa dizer "leia você mesmo" ou "sem delegar" no pedido.`),
      registro: 'barrou',
    };
  }
  for (const a of novos) anotar(chave, 'lidos', `${Date.now()}\t${a}`);
  return null;
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
