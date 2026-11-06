// Objetivo com condição de parada (skill /objetivo; roda pelo equipe-pos.mjs e pelo
// equipe-eventos.mjs).
//
// O mestre grava .revisao/objetivo.md: o pedido, "Pronto quando" (linhas da lista do
// verificador e outros critérios), quando pode parar, o Status e as decisões que tomou sem
// perguntar. A trava liga o objetivo para a sessão que gravou o arquivo. Enquanto ele vale, o
// fim da resposta do mestre só passa quando:
//   - as linhas da lista pedidas em "Pronto quando" passaram com o código de agora (pelo
//     resultado dos comandos, como na trava da prova); ou
//   - o Status diz que ele espera o usuário ("aguardando usuário: <o quê>": aprovar, gastar,
//     algo sem volta) ou que acabou ("encerrado"); ou
//   - sem linha da lista no "Pronto quando", o Status diz "concluído"; ou
//   - um agente ainda roda em segundo plano (o mestre só está esperando o resultado).
// Contra laço: a mesma cobrança (mesmo código, mesmas pendências, mesmo arquivo) vale no
// máximo 3 vezes, e no máximo 8 cobranças por pedido do usuário; o objetivo vence 24 horas
// depois da última gravação, e a escada de falhas (convergência) manda parar antes de tudo.
// Erro ou dúvida deixa passar.
import path from 'node:path';
import { anotacoes, anotar, caminhoReal, chaveDaChamada, desligada, fatosRapidos, gravarEstado, lerEstado, lerObjetivo, lerTexto, mesmaPasta, tipoDoAgente } from './equipe-comum.mjs';
import { agentesEmSegundoPlano, arquivosDaSessao, chaveDaSessao, raizGit } from './equipe-entrega.mjs';
import { avaliar, impressao } from './equipe-prova.mjs';

export { lerObjetivo };

const espacos = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const lerJson = (l) => { try { return JSON.parse(l); } catch { return null; } };
export const ARQUIVO = /(^|[\\/])\.revisao[\\/]objetivo\.md$/i;
const VALIDADE = 24 * 3600000;
const MAX_COBRANCAS = 3;
const MAX_POR_PEDIDO = 8;

// Depois de Write, Edit ou MultiEdit do mestre: gravou o objetivo? Liga para esta sessão.
export function anotarObjetivo(entrada) {
  if (tipoDoAgente(entrada) !== 'mestre' || !/^(Edit|Write|MultiEdit)$/.test(String(entrada.tool_name || ''))) return false;
  const arq = String((entrada.tool_input || {}).file_path || '');
  const sessao = chaveDaSessao(entrada);
  if (!sessao || !ARQUIVO.test(arq)) return false;
  gravarEstado(sessao, 'objetivo', { arquivo: caminhoReal(path.resolve(entrada.cwd || process.cwd(), arq)), em: Date.now() });
  return true;
}

// O objetivo desta sessão, se ainda vale: { st, obj } ou null.
function objetivoDaSessao(entrada) {
  const sessao = chaveDaSessao(entrada);
  if (!sessao) return null;
  const st = lerEstado(sessao, 'objetivo');
  if (!st || !st.arquivo || typeof st.em !== 'number' || Date.now() - st.em > VALIDADE) return null;
  const texto = lerTexto(st.arquivo);
  if (!texto) return null;
  return { sessao, st, obj: lerObjetivo(texto) };
}

// As linhas da lista do verificador citadas nos itens (entre crases, ou o item inteiro).
export function linhasPedidas(itens, lista) {
  const daLista = new Set(lista.map(espacos));
  const r = [];
  for (const item of itens) {
    const trechos = [...String(item).matchAll(/`([^`]+)`/g)].map((m) => espacos(m[1]));
    for (const c of [...trechos, espacos(String(item).replace(/`/g, ''))]) {
      if (daLista.has(c) && !r.includes(c)) r.push(c);
    }
  }
  return r;
}

// Stop do mestre: { bloquear, motivo, registro, cobraLinhas } ou null. cobraLinhas: a cobrança
// é pelas linhas da lista que faltam (a da prova seria a mesma).
export function objetivoNoFim(entrada, arquivos = null) {
  if (desligada('objetivo') || tipoDoAgente(entrada) !== 'mestre') return null;
  const o = objetivoDaSessao(entrada);
  if (!o) return null;
  const { sessao, st, obj } = o;
  if (obj.status === 'encerrado') return null;
  if (obj.status === 'aguardando') return { bloquear: false, registro: 'aguardando' };
  // Um agente ainda roda em segundo plano: o mestre parou para esperar o resultado.
  if (agentesEmSegundoPlano(entrada).length) return { bloquear: false, registro: 'esperando-agente' };
  // As linhas pedidas que são da lista do verificador do projeto do objetivo.
  const raiz = raizGit(path.dirname(path.dirname(st.arquivo)));
  if (!raiz) return null;
  let fatos = null;
  try { fatos = fatosRapidos(raiz); } catch { fatos = null; }
  const pedidas = linhasPedidas(obj.pronto, (fatos && fatos.comandos) || []);
  const porRaiz = arquivos || arquivosDaSessao(sessao);
  const imp = impressao(raiz, porRaiz);
  // Git com erro: não dá para saber qual é o código de agora.
  if (imp === null) return null;
  let pendentes = [];
  if (pedidas.length) {
    const execs = anotacoes(sessao, 'execucoes').map(lerJson).filter((x) => x && mesmaPasta(x.raiz, raiz) && (x.imp || '') === imp);
    const r = avaliar(execs);
    pendentes = pedidas.filter((l) => r.falharam.includes(l) || !r.passaram.includes(l));
    if (!pendentes.length) return { bloquear: false, registro: 'atingido' };
  } else if (obj.status === 'concluido') {
    return { bloquear: false, registro: 'concluido' };
  }
  // A mesma cobrança (mesmo código, mesmas pendências, mesmo arquivo) vale no máximo 3 vezes,
  // e um pedido do usuário leva no máximo 8 cobranças.
  const pedido = lerEstado(chaveDaChamada(entrada), 'pedido');
  const doPedido = pedido && typeof pedido.em === 'number' ? String(pedido.em) : '-';
  const assinatura = `${doPedido}|${st.em}|${imp}|${pendentes.join(',')}|${obj.status}`;
  const cobradas = anotacoes(sessao, 'objetivo-cobrado').filter((x) => x.startsWith(`${doPedido}|`));
  if (cobradas.length >= MAX_POR_PEDIDO || cobradas.filter((x) => x === assinatura).length >= MAX_COBRANCAS) {
    return { bloquear: false, registro: 'sem-progresso' };
  }
  anotar(sessao, 'objetivo-cobrado', assinatura);
  const saida = 'Pare só para o que precisa do usuário (aprovar, gastar dinheiro, algo sem volta): escreva no arquivo "Status: aguardando usuário: <o quê>" e encerre. Se o usuário mudou de assunto ou desistiu do objetivo, "Status: encerrado".';
  if (!pendentes.length) {
    return {
      bloquear: true,
      motivo: `Trava da equipe: objetivo ativo em .revisao/objetivo.md. Siga até cumprir o "Pronto quando"; decisão comum, decida você e anote em "Decisões". Ao terminar, confira cada critério e escreva "Status: concluído". ${saida}`,
      registro: 'barrou',
      cobraLinhas: false,
    };
  }
  const marcou = obj.status === 'concluido' ? ' O arquivo diz concluído, mas a verificação não confirma.' : '';
  return {
    bloquear: true,
    motivo: `Trava da equipe: objetivo ativo em .revisao/objetivo.md, e ainda falta verde com o código de agora em: ${pendentes.join(', ')}.${marcou} Siga até lá: o verificador com a linha da lista como ela está; se falhar, o implementador com a correção. Decisão comum, decida você e anote em "Decisões". ${saida}`,
    registro: 'barrou',
    cobraLinhas: true,
  };
}

// Mensagem nova do usuário com o objetivo desta sessão esperando por ele: o mestre volta o
// Status para ativo se a resposta destrava o trabalho (senão a trava fica calada até vencer).
export function avisoDeEspera(entrada) {
  if (desligada('objetivo') || tipoDoAgente(entrada) !== 'mestre') return null;
  const o = objetivoDaSessao(entrada);
  if (!o || o.obj.status !== 'aguardando') return null;
  const motivo = o.obj.motivo ? ` (${o.obj.motivo})` : '';
  return `Aviso da equipe: o objetivo em .revisao/objetivo.md está esperando o usuário${motivo}. Se esta mensagem destrava o trabalho, volte o Status para "ativo" e siga até o fim; se conclui, "concluído"; se o usuário mudou de assunto, "encerrado".`;
}
