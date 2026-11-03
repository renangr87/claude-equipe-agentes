// Trava de convergência: a escada de quando a verificação não fica verde.
//
// Quando o verificador termina com falha (pelo resultado dos comandos dele; só sem eles, pelo
// texto do relatório), a equipe guarda a "assinatura" da falha: os arquivos das falhas (sem a
// linha, que a própria correção muda), fora os que o relatório marca como anteriores à
// mudança e os avisos do analisador. Uma tentativa é um implementador que terminou depois da
// última verificação verde e cujo escopo toca os arquivos da falha.
//   1º degrau: a mesma falha depois de duas tentativas. O mestre recebe o aviso na próxima
//      ferramenta, e a próxima chamada do implementador para a mesma falha que não mudou de
//      abordagem ("Já tentado" com conteúdo) nem de modelo (opus) é barrada uma vez.
//   2º degrau: a mesma falha (um arquivo em comum) depois de três tentativas que mexeram
//      nela, no mesmo pedido. Toda chamada do implementador é barrada, sem válvula, até a
//      próxima mensagem do usuário: o mestre para e explica. Tarefas diferentes, cada uma com
//      a sua falha, e falhas anteriores à mudança não somam.
// Enquanto a falha está aberta, o implementador recebe o trecho dela ao começar (aresta de
// correção feita pelo hook, não pela memória do mestre). Só zera quando os comandos que
// falharam passarem sem filtro: um lint verde não apaga um teste vermelho.
// Trava de retrabalho: erro ou dúvida deixa passar.
import crypto from 'node:crypto';
import path from 'node:path';
import { caminhos, secoes } from './equipe-briefing.mjs';
import {
  anotacoes, anotar, apagarEstado, desligada, EXTENSOES_CODIGO, git, gravarEstado, lerEstado, normalizar,
  relatorioDaChamada, statusDoRelatorio, tipoDoAgente,
} from './equipe-comum.mjs';
import { chaveDaSessao, dentroDoEscopo, escopoDoBriefing } from './equipe-entrega.mjs';
import { resultadoDaVerificacao } from './equipe-prova.mjs';

export { relatorioDaChamada };

const exts = [...EXTENSOES_CODIGO].sort((a, b) => b.length - a.length).join('|');
const PONTO = new RegExp(`([A-Za-z]:[\\\\/])?([A-Za-z0-9_.\\/\\\\-]+\\.(?:${exts})):(\\d+)`, 'g');
// Linhas que não são falha desta mudança: anteriores a ela, avisos e infos do analisador.
const ANTERIOR = /anteriores?\s+(a|à)\s+mudan[cç]a|antes\s+da\s+mudan[cç]a|pr[eé]-?existentes?|j[aá]\s+falhava|falhas?\s+antigas?|already\s+fail|pre-?existing/i;
const AVISO = /^\W*(info|warning|warn|aviso|avisos|hint|dica)\b|\b(info|warning|hint)\s+-\s/i;
// A mesma regex sem /g, para test(): a com /g guarda a posição entre chamadas.
const TEM_PONTO = new RegExp(PONTO.source);
const SEIS_HORAS = 6 * 3600000;

// Linhas de falha do relatório: fora as anteriores à mudança e os avisos.
function linhasDeFalha(relatorio) {
  const r = [];
  let pulando = false;
  for (const linha of String(relatorio || '').split(/\r?\n/)) {
    if (ANTERIOR.test(linha)) { pulando = true; continue; }
    // Itens mais à direita, logo abaixo da linha "anteriores à mudança", também são dela.
    if (pulando && /^\s+\S/.test(linha)) continue;
    pulando = false;
    if (AVISO.test(linha)) continue;
    r.push(linha);
  }
  return r;
}

// Assinatura da falha: os arquivos das linhas de falha, em ordem. null se não aponta lugar
// nenhum.
export function assinaturaDaFalha(relatorio) {
  const pontos = new Set();
  for (const linha of linhasDeFalha(relatorio)) {
    for (const m of linha.matchAll(PONTO)) pontos.add(`${(m[1] || '') + m[2]}`.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase());
  }
  return pontos.size ? [...pontos].sort().slice(0, 20).join(' ') : null;
}

// Trecho da falha para o implementador: as linhas que apontam lugar ou dizem o que era
// esperado e o que apareceu.
export function trechoDaFalha(relatorio) {
  const r = [];
  let total = 0;
  for (const linha of linhasDeFalha(relatorio)) {
    const l = linha.trim();
    if (!l) continue;
    if (!TEM_PONTO.test(l) && !/falh|fail|esperad|apareceu|expected|actual|erro|error/i.test(l)) continue;
    const curta = l.length > 220 ? `${l.slice(0, 220)}...` : l;
    if (total + curta.length > 1500 || r.length >= 12) break;
    r.push(curta);
    total += curta.length;
  }
  return r.join('\n');
}

const resumo = (sig) => sig.split(' ').slice(0, 3).join(', ') + (sig.split(' ').length > 3 ? ' ...' : '');
const arquivosDa = (sig) => (String(sig || '').startsWith('cmd:') ? [] : [...new Set(String(sig || '').split(' ').filter(Boolean))]);

// Nome do arquivo sem extensão e sem a marca de teste: cupom_test.dart e cupom.dart são o
// mesmo assunto.
const assunto = (p) => path.basename(String(p)).toLowerCase().replace(/\.[^.]+$/, '').replace(/([._-](test|spec)|^test_)/g, '');

// Zera o episódio: a verificação passou.
const DO_EPISODIO = ['falhas', 'falha-repetida', 'episodio', 'convergencia-avisou', 'convergencia-barrou', 'falha-aberta', 'parar'];
function zerar(sessao) {
  for (const n of DO_EPISODIO) apagarEstado(sessao, n);
  gravarEstado(sessao, 'impl-base', { em: Date.now(), n: anotacoes(sessao, 'impl-fins').length });
}

// SubagentStop do implementador: conta uma tentativa, com os arquivos que ele editou (o
// escopo do briefing, se ele não editou nada pelas ferramentas). Uma pasta inteira no escopo
// ("src/") não faz toda falha daquela pasta virar "a mesma tarefa".
export function fimDoImplementadorConvergencia(entrada, editados = []) {
  const sessao = chaveDaSessao(entrada);
  if (!sessao) return;
  let alvo = (editados || []).map((a) => String(a).replace(/\\/g, '/'));
  if (!alvo.length) { try { alvo = escopoDoBriefing(entrada.agent_transcript_path) || []; } catch { alvo = []; } }
  anotar(sessao, 'impl-fins', `${Date.now()}\t${alvo.slice(0, 30).join('|')}`);
}

// O escopo de um implementador toca estes arquivos? Sem escopo ou sem arquivos: presume que sim.
function toca(escopo, arquivos, raiz) {
  if (!escopo.length || !arquivos.length) return true;
  const assuntos = new Set(escopo.map(assunto));
  const rel = (a) => (path.isAbsolute(a) && raiz ? path.relative(raiz, a).replace(/\\/g, '/') : a);
  return arquivos.some((a) => dentroDoEscopo(rel(a), escopo, raiz) || assuntos.has(assunto(a)));
}

// Tentativas desta falha: implementadores que terminaram depois do último zero e mexeram nela.
function tentativasDa(sessao, arquivos, raiz) {
  const base = lerEstado(sessao, 'impl-base') || {};
  const desde = typeof base.em === 'number' ? base.em : 0;
  return anotacoes(sessao, 'impl-fins')
    .map((l) => l.split('\t'))
    .filter(([em, esc]) => Number(em) > desde && toca(String(esc || '').split('|').filter(Boolean), arquivos, raiz))
    .length;
}

// SubagentStop do verificador. Devolve o registro ('repetiu', 'parou') ou null.
export function fimDoVerificador(entrada) {
  if (desligada('convergencia')) return null;
  const sessao = chaveDaSessao(entrada);
  if (!sessao) return null;
  const relatorio = relatorioDaChamada(entrada);
  const texto = statusDoRelatorio('verificador', relatorio);
  const exec = resultadoDaVerificacao(entrada);
  // Com o resultado dos comandos, vale só ele (o texto "o teste que falhava agora passa" não é
  // falha); sem ele, o texto só conta quando diz que falhou. "Passou" só com uma linha da lista
  // que passou sem filtro.
  let status = 'sem prova';
  if (exec) status = exec.status === 'com falha' ? 'com falha' : exec.status === 'passou' ? 'passou' : 'sem prova';
  else if (texto === 'com falha') status = 'com falha';
  const ep = lerEstado(sessao, 'episodio');
  if (status === 'passou') {
    const pendentes = ((ep && ep.cmds) || []).filter((c) => !exec.passaram.includes(c));
    if (!pendentes.length) zerar(sessao);
    return null;
  }
  if (status !== 'com falha') return null;
  const falharam = exec ? exec.falharam : [];
  const e = ep || { id: String(Date.now()), cmds: [] };
  e.cmds = [...new Set([...(e.cmds || []), ...falharam])];
  gravarEstado(sessao, 'episodio', e);
  // A assinatura vem dos arquivos das falhas desta mudança. Sem ela (só falhas anteriores à
  // mudança, ou sem arquivo:linha), não há "a mesma falha" para contar.
  const sig = assinaturaDaFalha(relatorio);
  if (!sig) return null;
  gravarEstado(sessao, 'falha-aberta', { sig, trecho: trechoDaFalha(relatorio), em: Date.now() });
  const raiz = git(['rev-parse', '--show-toplevel'], entrada.cwd || process.cwd()) || entrada.cwd || '';
  const arquivos = arquivosDa(sig);
  const tentativa = tentativasDa(sessao, arquivos, raiz);
  anotar(sessao, 'falhas', `${sig}\t${tentativa}\t${Date.now()}`);
  const falhas = anotacoes(sessao, 'falhas').map((l) => l.split('\t'));

  // 2º degrau: a mesma falha (um arquivo em comum) depois de três tentativas que mexeram nela,
  // desde a última mensagem do usuário.
  const desde = (lerEstado(sessao, 'pedido-em') || {}).em || 0;
  const meus = new Set(arquivos);
  const seguidas = new Set(falhas.filter(([s, i, em]) => Number(i) > 0 && Number(em || 0) > desde && arquivosDa(s).some((a) => meus.has(a))).map(([, i]) => i)).size;
  if (seguidas >= 3) {
    gravarEstado(sessao, 'parar', { em: Date.now(), vezes: seguidas, sig });
    return 'parou';
  }
  // 1º degrau: a mesma assinatura em duas tentativas diferentes.
  const tentativas = new Set(falhas.filter(([s, i]) => s === sig && Number(i) > 0).map(([, i]) => i)).size;
  if (tentativas < 2) { apagarEstado(sessao, 'falha-repetida'); return null; }
  gravarEstado(sessao, 'falha-repetida', { sig, vezes: tentativas, episodio: e.id, em: Date.now() });
  return 'repetiu';
}

// Mensagem nova do usuário: o 2º degrau sai, e a conta dele recomeça daqui.
export function novoPedidoConvergencia(entrada) {
  const sessao = chaveDaSessao(entrada);
  if (!sessao) return;
  apagarEstado(sessao, 'parar');
  gravarEstado(sessao, 'pedido-em', { em: Date.now() });
}

// O 2º degrau está valendo (o mestre foi mandado parar)?
export function pararAtivo(entrada) {
  if (desligada('convergencia')) return false;
  return Boolean(lerEstado(chaveDaSessao(entrada), 'parar'));
}

// Começo do implementador: o trecho da falha aberta, para ele não depender do briefing.
export function falhaParaImplementador(entrada) {
  if (desligada('convergencia') || tipoDoAgente(entrada) !== 'implementador') return null;
  const f = lerEstado(chaveDaSessao(entrada), 'falha-aberta');
  if (!f || !f.trecho || typeof f.em !== 'number' || Date.now() - f.em > SEIS_HORAS) return null;
  return `A equipe guardou a última falha do verificador nesta sessão (pode ser o motivo desta tarefa; se não for, ignore):\n${f.trecho}\nSe for: corrija só o que falhou, não mexa no que já passou e não repita o que o briefing lista em "Já tentado".`;
}

const CAMINHO = 'Antes de chamar o implementador de novo, escolha um: (1) replaneje, com outra hipótese para a causa, e ponha no briefing a seção "Já tentado" (o que não funcionou e por quê), também no .revisao/plano.md; (2) chame o implementador com model: opus; (3) se já fez isso, pare e explique ao usuário o que falta (às vezes é algo que o agente não enxerga, ou a tarefa está mal formulada).';

// Depois de qualquer ferramenta do mestre: o aviso do 1º degrau, uma vez por falha.
export function avisoParaMestre(entrada) {
  if (tipoDoAgente(entrada) !== 'mestre' || desligada('convergencia')) return null;
  const sessao = chaveDaSessao(entrada);
  const f = lerEstado(sessao, 'falha-repetida');
  if (!f || !f.sig) return null;
  const marca = `${f.episodio}|${f.vezes}`;
  if (anotacoes(sessao, 'convergencia-avisou').includes(marca)) return null;
  anotar(sessao, 'convergencia-avisou', marca);
  return `Trava da equipe: a mesma falha voltou depois de ${f.vezes} tentativas do implementador (${resumo(f.sig)}). Mais uma tentativa igual não resolve. ${CAMINHO}`;
}

// O briefing é sobre a falha? Sem caminhos no escopo, presume que sim.
function tocaAFalha(prompt, arquivos, cwd) {
  const escopo = caminhos(secoes(prompt).escopo || '');
  if (!escopo.length) return true;
  const raiz = git(['rev-parse', '--show-toplevel'], cwd || process.cwd()) || cwd || '';
  const rel = (a) => (path.isAbsolute(a) && raiz ? path.relative(raiz, a).replace(/\\/g, '/') : a);
  const assuntos = new Set(escopo.map(assunto));
  return arquivos.some((a) => dentroDoEscopo(rel(a), escopo, raiz) || assuntos.has(assunto(a)));
}

// O briefing registra o que já foi tentado: título ou rótulo "Já tentado" com conteúdo de
// verdade ("Já tentado: -" ou "nada" não é abordagem nova).
const ROTULO_JA = /(^|\n)[ \t>*#\-\d.)]*\**\s*(ja tentad[oa]s?|tentativas? anteriores|o que ja foi tentado)\b/;
const PROXIMA_SECAO = /\n[ \t>*#\-]*\**\s*(objetivo|contexto|escopo|criterios?|como verificar|verificacao|formato|ferramentas|restricoes|nao fazer)\b/;
export function temJaTentado(prompt) {
  const n = normalizar(prompt);
  const m = n.match(ROTULO_JA);
  if (!m) return false;
  let resto = n.slice(m.index + m[0].length).replace(/^\s*\**\s*(\([^)\n]*\))?\s*[:\-–—]?/, '');
  resto = resto.split(PROXIMA_SECAO)[0].trim();
  if (/^\W*(nada|nenhum|nenhuma|n\/?a|nao|-)?\W*$/.test(resto)) return false;
  return resto.replace(/[^a-z]/g, '').length >= 15;
}

// Antes da ferramenta Agent do mestre (implementador): { decisao, motivo, registro } ou null.
// ctx.registros: o que as travas anteriores desta mesma chamada registraram.
export function decidirConvergencia(entrada, ctx = {}) {
  if (!/^(Agent|Task)$/.test(String(entrada.tool_name || ''))) return null;
  if (tipoDoAgente(entrada) !== 'mestre' || desligada('convergencia')) return null;
  const ti = entrada.tool_input || {};
  if (String(ti.subagent_type || '') !== 'implementador') return null;
  const sessao = chaveDaSessao(entrada);
  // 2º degrau: sem válvula, sem exceção de modelo, até a próxima mensagem do usuário.
  const parar = lerEstado(sessao, 'parar');
  if (parar) {
    return {
      decisao: 'deny',
      motivo: `Barrado pela equipe: ${parar.vezes} tentativas do implementador terminaram com a mesma falha vermelha neste pedido${parar.sig ? ` (${resumo(parar.sig)})` : ''}. Pare aqui e explique ao usuário: o que falhou, o que já foi tentado e do que você precisa dele. A trava sai quando o usuário mandar a próxima mensagem.`,
      registro: 'parou',
    };
  }
  // O briefing acabou de passar pela válvula dele: não barra de novo na mesma chamada.
  if ((ctx.registros || []).some((r) => r.nome === 'briefing' && r.registro === 'valvula')) return null;
  const f = lerEstado(sessao, 'falha-repetida');
  if (!f || !f.sig) return null;
  const prompt = String(ti.prompt || '');
  if (/opus/i.test(String(ti.model || '')) || temJaTentado(prompt)) return null;
  const arquivos = arquivosDa(f.sig);
  if (!arquivos.length || !tocaAFalha(prompt, arquivos, entrada.cwd)) return null;
  const marca = `${f.episodio}|${crypto.createHash('sha1').update(prompt).digest('hex').slice(0, 16)}`;
  if (anotacoes(sessao, 'convergencia-barrou').includes(marca)) return { decisao: null, registro: 'valvula' };
  anotar(sessao, 'convergencia-barrou', marca);
  return {
    decisao: 'deny',
    motivo: `Barrado pela equipe: a mesma falha do verificador voltou depois de ${f.vezes} tentativas do implementador (${resumo(f.sig)}), e este briefing repete a tentativa. ${CAMINHO} Se você tem certeza de que esta tentativa é diferente, mande este mesmo briefing de novo: ele passa e fica registrado.`,
    registro: 'barrou',
  };
}
