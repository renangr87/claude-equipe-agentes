// Prova pelo resultado dos comandos (roda pelo equipe-pos.mjs e pelo equipe-eventos.mjs).
//
// Depois de cada comando de terminal que é uma linha de .claude/verificador-comandos.txt, a
// equipe anota se ele deu certo ou falhou (pelo próprio Claude Code: PostToolUse ou
// PostToolUseFailure, e o código de saída quando vem junto) e a "impressão" do código naquele
// momento: o conteúdo dos arquivos de código que a sessão mudou. Com isso:
//   - o status do verificador sai do resultado dos comandos, não do texto do relatório;
//   - no fim da resposta do mestre, se a sessão mudou código e nenhuma linha da lista passou
//     com o código de agora (ou uma falhou), o fim é barrado uma vez.
// A linha com argumentos a mais (um filtro, um arquivo de teste) conta quando falha, mas não
// prova o verde: "npm test -- -t nada" passa sem rodar teste nenhum. Comando com pipe não
// conta (o código de saída é o do último programa). A cobrança no fim vale uma vez por versão
// do código e uma vez por pedido do usuário.
// Trava de retrabalho: erro ou dúvida deixa passar.
import path from 'node:path';
import {
  anotacoes, anotar, chaveDaChamada, desligada, ehCodigo, fatosRapidos, lerEstado, marcaDoTexto, mesmaPasta,
  TESTE_DE_VERDADE, tipoDoAgente,
} from './equipe-comum.mjs';
import { agentesEmSegundoPlano, arquivosDaSessao, chaveDaSessao, CONTA_COMO_CODIGO, hashes, raizGit } from './equipe-entrega.mjs';

const espacos = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const lerJson = (l) => { try { return JSON.parse(l); } catch { return null; } };

// A linha da lista que o comando roda: { linha, exata, raiz } ou null. Aceita o comando
// precedido de "cd <pasta> &&" (a lista é a do repositório daquela pasta).
export function linhaDaLista(comando, cwd) {
  // Juntar a saída de erro (2>&1) não muda o comando. Com pipe (| tail), o código de saída é o
  // do último programa: o resultado não prova nada, então não conta.
  const c = espacos(String(comando || '').replace(/\s*(?:[12*]?>&[12]|2>\/dev\/null)\s*/g, ' '));
  if (!c || /(^|[^|])\|(?!\|)/.test(c)) return null;
  const formas = [{ resto: c, pasta: cwd || process.cwd() }];
  const m = c.match(/^cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;)\s*(.+)$/);
  if (m) formas.push({ resto: m[2], pasta: path.resolve(cwd || process.cwd(), m[1].replace(/^["']|["']$/g, '')) });
  for (const f of formas) {
    let fatos = null;
    try { fatos = fatosRapidos(f.pasta); } catch { fatos = null; }
    const lista = ((fatos && fatos.comandos) || []).map(espacos).filter(Boolean);
    if (!lista.length) continue;
    const raiz = raizGit(f.pasta);
    if (!raiz) continue;
    for (const l of lista) if (c === l || f.resto === l) return { linha: l, exata: true, raiz };
    for (const l of lista) if (c.startsWith(`${l} `) || f.resto.startsWith(`${l} `)) return { linha: l, exata: false, raiz };
  }
  return null;
}

// Impressão do código da sessão num repositório: o conteúdo dos arquivos de código (com os
// testes) que ela mudou. '' se não mudou código ali. Arquivo novo que só um comando criou (o
// relatório do teste em junit.xml, a cobertura em HTML) não conta: cada rodada o reescreve, e
// o código pareceria mudar a cada teste.
export function impressao(raiz, arquivos) {
  // A chave do Map pode vir noutra forma do mesmo caminho (nome curto no Windows).
  const chave = arquivos.has(raiz) ? raiz : [...arquivos.keys()].find((k) => mesmaPasta(k, raiz)) || raiz;
  const fora = (arquivos.soPorComando && arquivos.soPorComando.get(chave)) || null;
  const rels = [...(arquivos.get(chave) || [])].filter((r) => !(fora && fora.has(r)) && (ehCodigo(r) || CONTA_COMO_CODIGO.test(r))).sort();
  if (!rels.length) return '';
  const h = hashes(raiz, rels);
  // Git com erro ou sem tempo: não dá para saber qual é o código de agora (null: deixa passar).
  if (!h) return null;
  return marcaDoTexto(rels.map((r) => `${r}:${h[r] || '-'}`).join('\n'));
}

// Saída do terminal que mostra falha mesmo com o comando dado como certo.
const FALHA_NA_SAIDA = /Some tests failed|Tests:\s+\d+ failed|\b[1-9]\d* (failed|failing)\b|^# fail [1-9]|test result: FAILED|^FAIL\b/m;

// O comando deu certo? PostToolUseFailure é falha; no PostToolUse, olha o código de saída e
// a saída quando o Claude Code os manda.
export function deuCerto(entrada) {
  if (String(entrada.hook_event_name || '') === 'PostToolUseFailure') return false;
  const r = entrada.tool_response;
  if (r && typeof r === 'object') {
    for (const k of ['exitCode', 'exit_code', 'returnCode', 'code']) if (typeof r[k] === 'number' && r[k] !== 0) return false;
    if (r.interrupted === true || r.is_error === true) return false;
    const saida = `${r.stdout || ''}\n${r.stderr || ''}\n${r.output || ''}`;
    if (FALHA_NA_SAIDA.test(saida)) return false;
  } else if (typeof r === 'string' && FALHA_NA_SAIDA.test(r)) return false;
  return true;
}

// Depois de um comando de terminal (qualquer agente): anota se for uma linha da lista.
export function anotarExecucao(entrada) {
  const ti = entrada.tool_input || {};
  if (ti.run_in_background) return null; // ainda não terminou: o resultado não é este
  const sessao = chaveDaSessao(entrada);
  if (!sessao) return null;
  const l = linhaDaLista(ti.command, entrada.cwd);
  if (!l) return null;
  const r = {
    em: Date.now(),
    linha: l.linha,
    exata: l.exata,
    cmd: marcaDoTexto(ti.command),
    ok: deuCerto(entrada),
    raiz: l.raiz,
    imp: impressao(l.raiz, arquivosDaSessao(sessao)) || '',
  };
  anotar(sessao, 'execucoes', JSON.stringify(r));
  anotar(chaveDaChamada(entrada), 'execucoes', JSON.stringify(r));
  return r;
}

// Resultado de um conjunto de execuções: a última de cada comando vale (a segunda rodada que
// confirma falha intermitente). Falha com filtro que uma rodada sem filtro, depois, desmentiu
// não conta.
export function avaliar(execucoes) {
  const ultima = new Map();
  for (const x of execucoes) ultima.set(x.exata ? `=${x.linha}` : `${x.linha}+${x.cmd}`, x);
  const ult = [...ultima.values()];
  const exataOk = new Map(ult.filter((x) => x.exata && x.ok).map((x) => [x.linha, x.em]));
  const falharam = [...new Set(ult.filter((x) => !x.ok && !(x.linha && exataOk.get(x.linha) > x.em)).map((x) => x.linha))];
  const passaram = [...new Set(ult.filter((x) => x.ok && x.exata).map((x) => x.linha))];
  const filtradas = ult.some((x) => x.ok && !x.exata);
  return { falharam, passaram, filtradas };
}

// Fim do verificador: o que os comandos dele deram. null se ele não rodou nenhuma linha da
// lista. status: 'com falha', 'passou' (uma linha sem filtro passou e nada falhou) ou
// 'parcial' (só com filtro).
export function resultadoDaVerificacao(entrada) {
  const execs = anotacoes(chaveDaChamada(entrada), 'execucoes').map(lerJson).filter(Boolean);
  if (!execs.length) return null;
  const r = avaliar(execs);
  return { ...r, status: r.falharam.length ? 'com falha' : r.passaram.length ? 'passou' : 'parcial' };
}

// Stop do mestre: { bloquear, motivo, registro } ou null. arquivos: o Map de
// arquivosDaSessao, quando quem chama já o tem.
export function provaNoFim(entrada, arquivos = null) {
  if (desligada('prova') || tipoDoAgente(entrada) !== 'mestre') return null;
  const sessao = chaveDaSessao(entrada);
  if (!sessao) return null;
  const pedido = lerEstado(chaveDaChamada(entrada), 'pedido');
  if (pedido && pedido.semVerificar) return null;
  // Um verificador (ou implementador) ainda roda em segundo plano: a verificação está a
  // caminho, e o mestre parou para esperar. Nem cobra, nem gasta a cobrança deste código.
  if (agentesEmSegundoPlano(entrada).some((t) => /^(verificador|implementador)$/.test(String(t.agent_type)))) {
    return { bloquear: false, registro: 'verificador-rodando' };
  }
  const porRaiz = arquivos || arquivosDaSessao(sessao);
  // Uma vez por versão do código e uma vez por pedido do usuário: um teste que já estava
  // vermelho, ou uma resposta que não mexeu no código, não cobram a cada resposta.
  const doPedido = pedido && typeof pedido.em === 'number' ? `pedido:${pedido.em}` : null;
  const cobradas = new Set(anotacoes(sessao, 'prova-cobrada'));
  const execs = anotacoes(sessao, 'execucoes').map(lerJson).filter(Boolean);
  const faltas = [];
  for (const raiz of porRaiz.keys()) {
    let fatos = null;
    try { fatos = fatosRapidos(raiz); } catch { fatos = null; }
    const lista = ((fatos && fatos.comandos) || []).map(espacos).filter(Boolean);
    // Sem lista do verificador não há como provar: a trava não se aplica.
    if (!lista.length) continue;
    const imp = impressao(raiz, porRaiz);
    if (!imp || cobradas.has(`${raiz}|${imp}`) || (doPedido && cobradas.has(`${raiz}|${doPedido}`))) continue;
    const r = avaliar(execs.filter((x) => mesmaPasta(x.raiz, raiz) && x.imp === imp));
    const testes = lista.filter((l) => TESTE_DE_VERDADE.test(l));
    const ok = !r.falharam.length && r.passaram.length && (!testes.length || r.passaram.some((l) => TESTE_DE_VERDADE.test(l)));
    if (!ok) faltas.push({ raiz, imp, r, sugestao: testes[0] || lista[0] });
  }
  if (!faltas.length) return null;
  // Uma vez por versão do código: a trava não volta enquanto o código não mudar.
  for (const x of faltas) {
    anotar(sessao, 'prova-cobrada', `${x.raiz}|${x.imp}`);
    if (doPedido) anotar(sessao, 'prova-cobrada', `${x.raiz}|${doPedido}`);
  }
  if (entrada.stop_hook_active) return { bloquear: false, registro: 'concluiu-sem-prova' };
  const partes = faltas.map(({ raiz, r }) => {
    const nome = path.basename(raiz);
    if (r.falharam.length) return `${nome}: falhou com o código de agora (${r.falharam.join(', ')})`;
    if (r.passaram.length) return `${nome}: passou ${r.passaram.join(', ')}, mas nenhum teste rodou sem filtro`;
    if (r.filtradas) return `${nome}: só rodou com filtro ou com argumentos a mais`;
    return `${nome}: nenhuma linha da lista rodou depois da última mudança`;
  });
  return {
    bloquear: true,
    motivo: `Trava da equipe: o código mudou e não há verificação verde com o código de agora (${partes.join('; ')}). Chame o verificador com a linha da lista como ela está, sem filtro (por exemplo: ${faltas[0].sugestao}). Se não dá para verificar, ou você ainda não terminou, diga isso ao usuário e encerre de novo: a trava não volta por este código. Se o usuário disse "sem testes", ela também não vale.`,
    registro: 'barrou',
  };
}
