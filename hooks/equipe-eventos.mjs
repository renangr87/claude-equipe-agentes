#!/usr/bin/env node
// Hooks de evento da equipe (um script para todos):
//   - UserPromptSubmit: começa um pedido novo do mestre (zera o orçamento de leitura; lê
//     "leia você mesmo", "sem delegar", "sem revisão", "sem testes" e o pedido de push no
//     texto), guarda a base do repositório e tira a parada do 2º degrau da convergência;
//   - SubagentStart do implementador: tira a foto do git status (escopo) e entrega a falha
//     aberta do verificador; de um revisor: a foto do que ele vai revisar;
//   - SubagentStop: zera as contas da chamada (leituras, mapa); no implementador, barra uma
//     vez a entrega sem verificação, grava a lista do escopo e conta a tentativa; no
//     verificador, guarda o resultado e a assinatura da falha; no revisor, o veredito;
//   - Stop do mestre: revisão obrigatória (mudança grande, sensível ou reprovada), prova
//     (verificação verde com o código de agora) e objetivo (/objetivo: seguir até o "Pronto
//     quando"), numa cobrança só.
// Erro vira silêncio: nunca impede a sessão por defeito próprio.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  anotacoes, anotar, apagarEstado, carregarModulo, chaveDaChamada, desligada, ehAgenteDeRevisao, gravarEstado, lerEntrada,
  lerEstado, limparChamada, normalizar, registrarTrava, tipoDoAgente,
} from './equipe-comum.mjs';

// Cada módulo à parte: um quebrado não leva os outros junto, e a falha vai para o registro.
const carregar = (arquivo) => carregarModulo(import.meta.url, arquivo);
const [entrega, convergencia, leitura, prova, paralelo, push, objetivo] = await Promise.all([
  carregar('./equipe-entrega.mjs'), carregar('./equipe-convergencia.mjs'), carregar('./equipe-leitura.mjs'),
  carregar('./equipe-prova.mjs'), carregar('./equipe-paralelo.mjs'), carregar('./equipe-push.mjs'),
  carregar('./equipe-objetivo.mjs'),
]);

const tentar = (f) => { try { return f(); } catch { return null; } };

const LIVRE = /\b(leia (voce|vc|tu) mesmo|le (voce|vc) mesmo|sem delegar|nao delegue|nao precisa delegar)\b/;
const SEM_REVISAO = /\b(sem revisao|nao precisa (de )?revis(ao|ar)|dispensa (a )?revisao)\b/;
// O usuário autoriza consultar o banco pela conexão normal, com aprovação ("pode rodar a
// consulta", "rode o select", "autorizo a query"), ou responde só "sim"/"ok"/"pode".
const CONSULTAR = /\b(pode|podes|rode|roda|rodar|execute|executa|executar|autorizo|liberad[oa]|libero|faca|fazer)\b.{0,30}\b(consultas?|query|querys|queries|sql|selects?)\b|\b(consultas?|query|sql|selects?)\b.{0,20}\b(liberad[oa]|autorizad[oa]|pode rodar)\b|^\s*(sim|ok|pode|pode sim|manda|rode|roda|claro|beleza|blz)\s*[.!]*\s*$/;
const SEM_VERIFICAR = /\b(sem (rodar )?(os )?testes?|sem verifica(r|cao)|nao (precisa )?(rodar|de) (os )?testes?|nao precisa (testar|verificar)|pul[ea] (os )?testes?|dispensa (os )?testes?)\b/;

// Conversa longa: a partir do 5º resumo automático, uma vez por resumo, o mestre sugere ao
// usuário abrir uma conversa nova para a próxima tarefa (cada passo relê o contexto inteiro,
// e uma sessão com muitos resumos custa várias vezes mais por resposta).
const MIN_RESUMOS = 5;
export function avisoDeConversaLonga(entrada) {
  if (desligada('conversa')) return null;
  const s = String(entrada.session_id || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!s) return null;
  const sessao = `${s}-sessao`;
  const n = anotacoes(sessao, 'resumos').length;
  if (n < MIN_RESUMOS) return null;
  const avisado = Math.max(0, ...anotacoes(sessao, 'resumos-avisados').map(Number).filter(Number.isFinite));
  if (n <= avisado) return null;
  anotar(sessao, 'resumos-avisados', n);
  return `Aviso da equipe: esta conversa já foi resumida ${n} vezes. Cada passo relê um contexto grande, e o custo de cada resposta cresce. Antes de terminar esta resposta, atualize .revisao/progresso.md (o pedido, o que foi feito, como foi verificado, o que falta e por onde retomar). No fim, sugira ao usuário, em uma linha, abrir uma conversa nova para a próxima tarefa: ela começa pelo progresso, pelo plano (.revisao/plano.md), pelas notas de área e pela memória.`;
}

export function flagsDoPedido(texto) {
  const t = normalizar(texto);
  return { livre: LIVRE.test(t), semRevisao: SEM_REVISAO.test(t), semVerificar: SEM_VERIFICAR.test(t), consultar: CONSULTAR.test(t) };
}

// Devolve a saída do hook (objeto) ou null.
export function tratar(entrada) {
  if (!entrada || typeof entrada !== 'object') return null;
  const evento = String(entrada.hook_event_name || '');
  const tipo = tipoDoAgente(entrada);
  const chave = chaveDaChamada(entrada);

  if (evento === 'UserPromptSubmit') {
    if (tipo !== 'mestre' || !chave) return null;
    apagarEstado(chave, 'lidos');
    gravarEstado(chave, 'pedido', { em: Date.now(), ...flagsDoPedido(entrada.prompt) });
    if (push) tentar(() => push.novoPedidoPush(entrada));
    if (entrega) tentar(() => entrega.inicioDaSessao(entrada));
    if (convergencia) tentar(() => convergencia.novoPedidoConvergencia(entrada));
    // Listas de escopo de implementadores de segundo plano que o mestre ainda não viu, o
    // aviso de conversa longa e o objetivo que espera o usuário.
    const escopo = entrega ? tentar(() => entrega.escopoParaMestre(entrada)) : null;
    const longa = tentar(() => avisoDeConversaLonga(entrada));
    if (longa) registrarTrava('conversa', 'avisou', 0, entrada);
    const espera = objetivo ? tentar(() => objetivo.avisoDeEspera(entrada)) : null;
    if (espera) registrarTrava('objetivo', 'lembrou', 0, entrada);
    const contexto = [escopo, longa, espera].filter(Boolean).join('\n\n');
    if (contexto) return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: contexto } };
    return null;
  }

  if (evento === 'SubagentStart') {
    if (tipo === 'implementador') {
      if (entrega) tentar(() => entrega.fotoInicial(entrada));
      const falha = convergencia ? tentar(() => convergencia.falhaParaImplementador(entrada)) : null;
      if (falha) {
        registrarTrava('convergencia', 'entregou-falha', 0, entrada);
        return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: falha } };
      }
    } else if (ehAgenteDeRevisao(tipo) && entrega) {
      tentar(() => entrega.fotoDaRevisao(entrada));
    }
    return null;
  }

  if (evento === 'SubagentStop') {
    // Sem o tipo do agente (versão antiga do Claude Code), a chave seria a do mestre: não mexe.
    if (tipo === 'mestre') return null;
    const inicio = Date.now();
    if (tipo === 'implementador') {
      const r = entrega ? tentar(() => entrega.fimDoImplementador(entrada)) : null;
      // Só conta como tentativa quando ele termina de verdade (não na vez em que foi barrado).
      if (!(r && r.bloquear)) {
        if (convergencia) tentar(() => convergencia.fimDoImplementadorConvergencia(entrada, r ? r.editados : []));
        if (paralelo) tentar(() => paralelo.fimDoImplementadorParalelo(entrada));
      }
      if (r && r.registro) registrarTrava(r.registro === 'barrou' || r.registro === 'entregou-sem-verificar' ? 'verificar' : 'escopo', r.registro, Date.now() - inicio, entrada);
      if (r && r.bloquear) return { decision: 'block', reason: r.motivo };
      return null;
    }
    if (tipo === 'verificador' && convergencia) {
      const r = tentar(() => convergencia.fimDoVerificador(entrada));
      if (r) registrarTrava('convergencia', r, Date.now() - inicio, entrada);
    }
    // Revisor da equipe ou o próprio do projeto (um plugin com os revisores dele): só a
    // aprovação conta como revisão.
    if (ehAgenteDeRevisao(tipo) && entrega) {
      const r = tentar(() => entrega.fimDaRevisao(entrada));
      if (r) registrarTrava('revisao', r, Date.now() - inicio, entrada);
    }
    // Explore e revisor: as contas da chamada zeram (um agente retomado começa de novo).
    if (tipo === 'Explore' && leitura) tentar(() => leitura.decidir({ ...entrada, hook_event_name: 'SubagentStop' }));
    limparChamada(chave);
    return null;
  }

  if (evento === 'Stop') {
    if (tipo !== 'mestre') return null;
    const inicio = Date.now();
    // O 2º degrau mandou parar e explicar: cobrar revisão ou teste agora só atrasaria isso.
    if (convergencia && tentar(() => convergencia.pararAtivo(entrada))) return null;
    const sessao = entrega ? tentar(() => entrega.chaveDaSessao(entrada)) : null;
    // stop_hook_active diz que a resposta continuou porque um fim foi barrado, mas não diz por
    // quem (outra trava, ou outro hook). Cada trava só conta como "já cobrou, agora passa" se
    // foi ela que barrou o fim anterior.
    // Sem esse registro (não gravou, ou não deu para ler), vale o de antes: toda trava conta
    // como já tendo cobrado, e o fim passa.
    const anterior = entrada.stop_hook_active && sessao ? tentar(() => lerEstado(sessao, 'fim-barrado')) : null;
    const semMemoria = Boolean(entrada.stop_hook_active) && !(anterior && Array.isArray(anterior.travas));
    const insistiu = (nome) => semMemoria || Boolean(anterior && Array.isArray(anterior.travas) && anterior.travas.includes(nome));
    const para = (nome) => ({ ...entrada, stop_hook_active: insistiu(nome) });
    const arquivos = sessao ? tentar(() => entrega.arquivosDaSessao(sessao)) : null;
    const revisao = entrega ? tentar(() => entrega.revisaoNoFim(para('revisao'), arquivos)) : null;
    if (revisao && revisao.registro) registrarTrava('revisao', revisao.registro, Date.now() - inicio, entrada);
    const alvo = objetivo ? tentar(() => objetivo.objetivoNoFim(entrada, arquivos)) : null;
    if (alvo && alvo.registro) registrarTrava('objetivo', alvo.registro, Date.now() - inicio, entrada);
    // Com o objetivo cobrando as linhas da lista que faltam, a prova espera: ela cobra quando o
    // objetivo deixar parar (e aí o que ela pede a mais, como um teste de verdade, aparece).
    const verde = prova && !(alvo && alvo.bloquear && alvo.cobraLinhas) ? tentar(() => prova.provaNoFim(para('prova'), arquivos)) : null;
    if (verde && verde.registro) registrarTrava('prova', verde.registro, Date.now() - inicio, entrada);
    const motivos = [];
    const barraram = [];
    for (const [nome, r] of [['revisao', revisao], ['prova', verde], ['objetivo', alvo]]) {
      if (r && r.bloquear) { motivos.push(r.motivo); barraram.push(nome); }
    }
    // Lista de escopo com problema (fora do escopo, entrega sem verificação) que o mestre não viu.
    const escopo = !insistiu('escopo') && entrega ? tentar(() => entrega.escopoParaMestre(entrada, { soComProblema: true })) : null;
    if (escopo) {
      registrarTrava('escopo', 'entregou-no-fim', 0, entrada);
      motivos.push(`Trava da equipe: um implementador terminou com algo a conferir antes de concluir.\n${escopo}`);
      barraram.push('escopo');
    }
    let lembrou = true;
    if (sessao) {
      const marca = `${Date.now()}-${process.pid}`;
      tentar(() => gravarEstado(sessao, 'fim-barrado', { em: Date.now(), marca, travas: barraram }));
      const lido = tentar(() => lerEstado(sessao, 'fim-barrado'));
      lembrou = Boolean(lido && lido.marca === marca);
    }
    // Barrar sem lembrar quem barrou faria cada fim seguinte cobrar de novo, sem fim: sem o
    // registro, como antes, só o primeiro fim da sequência é barrado.
    if (motivos.length && (lembrou || !entrada.stop_hook_active)) return { decision: 'block', reason: motivos.join('\n\n') };
    return null;
  }
  return null;
}

function principal() {
  let entrada = {};
  try {
    entrada = lerEntrada();
    const s = tratar(entrada);
    if (s) process.stdout.write(JSON.stringify(s));
  } catch {
    // Silêncio.
  }
  registrarTrava('eventos', String(entrada.hook_event_name || '?'), process.uptime() * 1000, entrada);
}

const real = (p) => {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch { /* fica o caminho dado */ }
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) principal();
