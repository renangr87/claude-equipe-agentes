// Trava do push (roda pelo despachante equipe-pre.mjs, no terminal de qualquer agente).
//
// Push é o passo sem volta da equipe: o que vai para o GitHub chega aos outros. A regra diz
// "push só quando o usuário pedir"; esta trava pede a sua confirmação quando o pedido desta
// conversa não falou em push. Contam como pedido: a palavra no pedido ("push", "envie",
// "suba", "publique", "pode enviar"), um "ok"/"sim" curto logo depois de o mestre perguntar se
// envia, e a resposta "sim" ou "enviar" a uma pergunta de múltipla escolha sobre envio. O
// pedido vale até o push acontecer: as mensagens seguintes ("ah, use outro formato") não o
// tiram; depois do push, a próxima mensagem do usuário precisa pedir de novo.
// Trava de segurança: não desliga pelo interruptor. O push forçado continua proibido pelo
// settings.json; no implementador, a guarda barra qualquer push.
import path from 'node:path';
import { apagarEstado, gravarEstado, lerEstado, normalizar, tipoDoAgente, ultimaFalaDoMestre } from './equipe-comum.mjs';

const OPCAO_COM_VALOR = /^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env)$/;
const CASCA = /^(bash|sh|zsh|dash|cmd|cmd\.exe|powershell|powershell\.exe|pwsh|pwsh\.exe)$/i;

// O comando faz push? Olha o programa de cada parte (git [opções] push), e o texto entre
// aspas de bash -c "...". "echo git push" e o texto do commit não contam.
export function temPush(comando, nivel = 0) {
  const texto = String(comando || '');
  for (const parte of texto.split(/&&|\|\||[;|\r\n]/)) {
    const seg = parte.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
    if (!seg) continue;
    const tokens = seg.match(/"[^"]*"|'[^']*'|\S+/g) || [];
    // PowerShell: "& git push" chama o programa pelo operador.
    if (tokens[0] === '&') tokens.shift();
    const programa = path.basename(String(tokens[0] || '').replace(/^["'&]+|["']+$/g, '')).toLowerCase();
    if (CASCA.test(programa) && nivel < 2) {
      for (const t of tokens.slice(1)) if (/^["'].*\s.*["']$/.test(t) && temPush(t.slice(1, -1), nivel + 1)) return true;
      continue;
    }
    if (programa !== 'git' && programa !== 'git.exe') continue;
    let j = 1;
    while (j < tokens.length && tokens[j].startsWith('-')) { if (OPCAO_COM_VALOR.test(tokens[j])) j++; j++; }
    if (String(tokens[j] || '').toLowerCase() === 'push') return true;
  }
  return false;
}

// "push" vale sozinho. Os verbos (envie, mande, suba, publique, pode enviar) só no fim da frase
// ("corrija e envie.") ou com o que vai (github, remoto, branch, commit, mudanças): "suba o
// servidor local", "mande o resumo aqui" e "envie um e-mail" não são pedido de push.
const PEDE_PUSH = /\b(push|pushe|pushar)\b|\b(envie|mande|manda|suba|publique|pode (enviar|mandar|subir|publicar))\b(\s*([.!,;)]|$)|[^.!?\n]{0,40}\b(github|remoto|origin|branch|main|commit|commits|mudancas|alteracoes|codigo|repositorio|pr)\b)/m;
const SIM_CURTO = /^\W*(ok|okay|sim|s|pode|pode sim|pode enviar|manda|mande|envia|envie|bora|vai|yes|y|isso|claro|fechado|beleza|blz|positivo)\W*$/;
const PERGUNTA_DE_PUSH = /\b(push|envi[aeo]\w*|subir|suba|publicar|github)\b/;
const RESPOSTA_SIM = /^\W*(sim|yes|pode|ok|envi\w*|mand\w*|push\w*|fa[cz]\w*|sub\w*|public\w*)\b/;
const RESPOSTA_NAO = /^\W*(nao|no|agora nao|depois|ainda nao|deixa)\b/;

const chaveMestre = (entrada) => {
  const s = String((entrada && entrada.session_id) || '').replace(/[^A-Za-z0-9_-]/g, '');
  return s ? `${s}-mestre` : null;
};
const VALIDADE = 12 * 3600000;

// O pedido do usuário autoriza push? (envio do pedido)
export function pedidoAutorizaPush(prompt, transcricao) {
  const p = normalizar(prompt);
  if (PEDE_PUSH.test(p)) return true;
  if (SIM_CURTO.test(p)) return PERGUNTA_DE_PUSH.test(normalizar(ultimaFalaDoMestre(transcricao)));
  return false;
}

// Resposta a uma pergunta de múltipla escolha (AskUserQuestion) que autoriza o push.
export function respostaAutorizaPush(entrada) {
  const ti = entrada.tool_input || {};
  const r = entrada.tool_response;
  const respostas = [];
  for (const fonte of [ti.answers, r && typeof r === 'object' ? r.answers : null]) {
    if (fonte && typeof fonte === 'object') for (const [q, a] of Object.entries(fonte)) respostas.push([normalizar(q), normalizar(a)]);
  }
  return respostas.some(([q, a]) => PERGUNTA_DE_PUSH.test(`${q} ${a}`) && RESPOSTA_SIM.test(a) && !RESPOSTA_NAO.test(a));
}

// Envio do pedido: autoriza (se pedir), ou tira a autorização que já foi usada num push.
export function novoPedidoPush(entrada) {
  const chave = chaveMestre(entrada);
  if (!chave) return false;
  if (pedidoAutorizaPush(entrada.prompt, entrada.transcript_path)) {
    gravarEstado(chave, 'push-autorizado', { em: Date.now() });
    apagarEstado(chave, 'push-usado');
    return true;
  }
  if (lerEstado(chave, 'push-usado')) {
    apagarEstado(chave, 'push-autorizado');
    apagarEstado(chave, 'push-usado');
  }
  return false;
}

// Depois da AskUserQuestion do mestre: a resposta que autoriza o push.
export function anotarRespostaDePush(entrada) {
  if (tipoDoAgente(entrada) !== 'mestre' || !respostaAutorizaPush(entrada)) return false;
  gravarEstado(chaveMestre(entrada), 'push-autorizado', { em: Date.now() });
  return true;
}

// Depois de um comando de terminal que fez push: a autorização acaba na próxima mensagem.
export function anotarPushFeito(entrada) {
  if (!temPush((entrada.tool_input || {}).command)) return false;
  gravarEstado(chaveMestre(entrada), 'push-usado', { em: Date.now() });
  return true;
}

// Antes de um comando de terminal: { decisao, motivo, registro } ou null.
export function decidirPush(entrada) {
  if (!/^(Bash|PowerShell)$/.test(String(entrada.tool_name || ''))) return null;
  const ti = entrada.tool_input || {};
  if (!temPush(ti.command)) return null;
  // O pedido é sempre o do mestre, também quando quem roda é um subagente.
  const a = lerEstado(chaveMestre(entrada), 'push-autorizado');
  if (a && typeof a.em === 'number' && Date.now() - a.em < VALIDADE) return null;
  return {
    decisao: 'ask',
    motivo: 'Trava da equipe: push só com o pedido do usuário, e o pedido desta conversa não falou em push. Confirme se quer enviar.',
    registro: 'pediu',
  };
}
