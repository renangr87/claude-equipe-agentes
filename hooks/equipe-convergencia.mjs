// Trava de convergência: a mesma falha voltou depois de duas tentativas do implementador,
// então outra tentativa igual não resolve.
//
// Quando o verificador termina com falha (pelo status do relatório, o mesmo que o medidor lê),
// a equipe guarda a "assinatura" dela: os pontos arquivo:linha das falhas, fora as que o
// relatório marca como anteriores à mudança e os avisos do analisador. Uma tentativa é um
// implementador que terminou entre duas verificações; a verificação de antes da primeira
// tentativa (a que reproduz o bug) não conta. Na segunda tentativa com a mesma assinatura:
//   - em primeiro plano, o mestre recebe o aviso junto com o relatório do verificador;
//   - a próxima chamada do implementador para a mesma falha (o escopo dela toca os arquivos
//     da falha) que não mudou de abordagem (sem "Já tentado") nem de modelo (opus) é barrada
//     uma vez, com o caminho: replanejar, subir o modelo ou parar e falar com o usuário.
// Válvula: o mesmo briefing mandado de novo passa e fica registrado. Verificação que passou
// zera tudo. Trava de economia: erro ou dúvida deixa passar.
import crypto from 'node:crypto';
import path from 'node:path';
import { caminhos, secoes } from './equipe-briefing.mjs';
import {
  anotacoes, anotar, apagarEstado, desligada, EXTENSOES_CODIGO, git, gravarEstado, lerEstado, lerTexto,
  normalizar, statusDoRelatorio, tipoDoAgente,
} from './equipe-comum.mjs';
import { chaveDaSessao, dentroDoEscopo } from './equipe-entrega.mjs';

const exts = [...EXTENSOES_CODIGO].sort((a, b) => b.length - a.length).join('|');
const PONTO = new RegExp(`([A-Za-z]:[\\\\/])?([A-Za-z0-9_.\\/\\\\-]+\\.(?:${exts})):(\\d+)`, 'g');
// Linhas que não são falha desta mudança: anteriores a ela, avisos e infos do analisador.
const ANTERIOR = /anteriores?\s+(a|à)\s+mudan[cç]a|antes\s+da\s+mudan[cç]a|pr[eé]-?existentes?|j[aá]\s+falhava|falhas?\s+antigas?|already\s+fail|pre-?existing/i;
const AVISO = /^\W*(info|warning|warn|aviso|avisos|hint|dica)\b|\b(info|warning|hint)\s+-\s/i;

// Assinatura da falha: os pontos arquivo:linha das linhas de falha, em ordem. null se não
// aponta lugar nenhum.
export function assinaturaDaFalha(relatorio) {
  const pontos = new Set();
  let pulando = false;
  for (const linha of String(relatorio || '').split(/\r?\n/)) {
    if (ANTERIOR.test(linha)) { pulando = true; continue; }
    // Itens mais à direita, logo abaixo da linha "anteriores à mudança", também são dela.
    if (pulando && /^\s+\S/.test(linha)) continue;
    pulando = false;
    if (AVISO.test(linha)) continue;
    for (const m of linha.matchAll(PONTO)) pontos.add(`${(m[1] || '') + m[2]}`.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase() + `:${m[3]}`);
  }
  return pontos.size ? [...pontos].sort().slice(0, 20).join(' ') : null;
}

// Relatório do subagente que terminou: a entrega (SubagentHandback) da transcrição dele; se
// não houver, a última mensagem (SubagentStop) ou o último texto.
export function relatorioDaChamada(entrada) {
  let entrega = '';
  let ultimo = '';
  const texto = lerTexto(String(entrada.agent_transcript_path || ''));
  for (const linha of texto ? texto.split('\n') : []) {
    if (!linha.includes('"assistant"')) continue;
    let j;
    try { j = JSON.parse(linha); } catch { continue; }
    const c = j && j.message && Array.isArray(j.message.content) ? j.message.content : [];
    for (const b of c) {
      if (b && b.type === 'tool_use' && b.name === 'SubagentHandback' && b.input && typeof b.input.message === 'string') entrega = b.input.message;
      else if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) ultimo = b.text;
    }
  }
  if (entrega) return entrega;
  if (typeof entrada.last_assistant_message === 'string' && entrada.last_assistant_message.trim()) return entrada.last_assistant_message;
  return ultimo;
}

const resumo = (sig) => sig.split(' ').slice(0, 3).join(', ') + (sig.split(' ').length > 3 ? ' ...' : '');
const arquivosDa = (sig) => [...new Set(sig.split(' ').map((p) => p.replace(/:\d+$/, '')))];

// Zera o episódio: a verificação passou.
function zerar(sessao) {
  for (const n of ['falhas', 'falha-repetida', 'episodio', 'convergencia-avisou', 'convergencia-barrou']) apagarEstado(sessao, n);
  gravarEstado(sessao, 'impl-base', { n: anotacoes(sessao, 'impl-fins').length });
}

// SubagentStop do implementador: conta uma tentativa.
export function fimDoImplementadorConvergencia(entrada) {
  const sessao = chaveDaSessao(entrada);
  if (sessao) anotar(sessao, 'impl-fins', Date.now());
}

// SubagentStop do verificador: guarda a assinatura. Devolve o registro ('repetiu') ou null.
export function fimDoVerificador(entrada) {
  if (desligada('convergencia')) return null;
  const sessao = chaveDaSessao(entrada);
  if (!sessao) return null;
  const relatorio = relatorioDaChamada(entrada);
  const status = statusDoRelatorio('verificador', relatorio);
  if (status === 'passou') { zerar(sessao); return null; }
  // Bloqueado ou sem status: não dá para saber; nada muda.
  if (status !== 'com falha') return null;
  const sig = assinaturaDaFalha(relatorio);
  if (!sig) return null;
  const base = (lerEstado(sessao, 'impl-base') || {}).n || 0;
  const tentativa = anotacoes(sessao, 'impl-fins').length;
  anotar(sessao, 'falhas', `${sig}\t${tentativa}`);
  if (!lerEstado(sessao, 'episodio')) gravarEstado(sessao, 'episodio', { id: String(Date.now()) });
  // Tentativas com esta mesma falha: implementadores diferentes que terminaram antes dela.
  const tentativas = new Set(anotacoes(sessao, 'falhas').map((l) => l.split('\t')).filter(([s, i]) => s === sig && Number(i) > base).map(([, i]) => i)).size;
  if (tentativas < 2) { apagarEstado(sessao, 'falha-repetida'); return null; }
  gravarEstado(sessao, 'falha-repetida', { sig, vezes: tentativas, episodio: lerEstado(sessao, 'episodio').id, em: Date.now() });
  return 'repetiu';
}

const CAMINHO = 'Antes de chamar o implementador de novo, escolha um: (1) replaneje, com outra hipótese para a causa, e ponha no briefing a seção "Já tentado" (o que não funcionou e por quê), também no .revisao/plano.md; (2) chame o implementador com model: opus; (3) se já fez isso, pare e explique ao usuário o que falta (às vezes é algo que o agente não enxerga, ou a tarefa está mal formulada).';

// Depois da ferramenta Agent do mestre (verificador em primeiro plano): o aviso.
export function avisoParaMestre(entrada) {
  if (tipoDoAgente(entrada) !== 'mestre' || desligada('convergencia')) return null;
  const ti = entrada.tool_input || {};
  if (String(ti.subagent_type || '') !== 'verificador' || ti.run_in_background) return null;
  const sessao = chaveDaSessao(entrada);
  const f = lerEstado(sessao, 'falha-repetida');
  if (!f || !f.sig) return null;
  const marca = `${f.episodio}|${f.vezes}`;
  if (anotacoes(sessao, 'convergencia-avisou').includes(marca)) return null;
  anotar(sessao, 'convergencia-avisou', marca);
  return `Trava da equipe: a mesma falha voltou depois de ${f.vezes} tentativas do implementador (${resumo(f.sig)}). Mais uma tentativa igual não resolve. ${CAMINHO}`;
}

// Nome do arquivo sem extensão e sem a marca de teste: cupom_test.dart e cupom.dart são o
// mesmo assunto.
const assunto = (p) => path.basename(String(p)).toLowerCase().replace(/\.[^.]+$/, '').replace(/([._-](test|spec)|^test_)/g, '');

// O briefing é sobre a falha? Sem caminhos no escopo, presume que sim.
function tocaAFalha(prompt, arquivos, cwd) {
  const escopo = caminhos(secoes(prompt).escopo || '');
  if (!escopo.length) return true;
  const raiz = git(['rev-parse', '--show-toplevel'], cwd || process.cwd()) || cwd || '';
  const rel = (a) => (path.isAbsolute(a) && raiz ? path.relative(raiz, a).replace(/\\/g, '/') : a);
  const assuntos = new Set(escopo.map(assunto));
  return arquivos.some((a) => dentroDoEscopo(rel(a), escopo, raiz) || assuntos.has(assunto(a)));
}

// O briefing registra o que já foi tentado: título ou rótulo "Já tentado", com o que vier.
export const temJaTentado = (prompt) => /(^|\n)[ \t>*#\-\d.)]*\**\s*(ja tentad[oa]s?|tentativas? anteriores|o que ja foi tentado)\b/.test(normalizar(prompt));

// Antes da ferramenta Agent do mestre (implementador): { decisao, motivo, registro } ou null.
// ctx.registros: o que as travas anteriores desta mesma chamada registraram.
export function decidirConvergencia(entrada, ctx = {}) {
  if (!/^(Agent|Task)$/.test(String(entrada.tool_name || ''))) return null;
  if (tipoDoAgente(entrada) !== 'mestre' || desligada('convergencia')) return null;
  const ti = entrada.tool_input || {};
  if (String(ti.subagent_type || '') !== 'implementador') return null;
  // O briefing acabou de passar pela válvula dele: não barra de novo na mesma chamada.
  if ((ctx.registros || []).some((r) => r.nome === 'briefing' && r.registro === 'valvula')) return null;
  const sessao = chaveDaSessao(entrada);
  const f = lerEstado(sessao, 'falha-repetida');
  if (!f || !f.sig) return null;
  const prompt = String(ti.prompt || '');
  if (/opus/i.test(String(ti.model || '')) || temJaTentado(prompt)) return null;
  if (!tocaAFalha(prompt, arquivosDa(f.sig), entrada.cwd)) return null;
  const marca = `${f.episodio}|${crypto.createHash('sha1').update(prompt).digest('hex').slice(0, 16)}`;
  if (anotacoes(sessao, 'convergencia-barrou').includes(marca)) return { decisao: null, registro: 'valvula' };
  anotar(sessao, 'convergencia-barrou', marca);
  return {
    decisao: 'deny',
    motivo: `Barrado pela equipe: a mesma falha do verificador voltou depois de ${f.vezes} tentativas do implementador (${resumo(f.sig)}), e este briefing repete a tentativa. ${CAMINHO} Se você tem certeza de que esta tentativa é diferente, mande este mesmo briefing de novo: ele passa e fica registrado.`,
    registro: 'barrou',
  };
}
