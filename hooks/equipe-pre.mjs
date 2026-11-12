#!/usr/bin/env node
// Hook PreToolUse da equipe: um processo por chamada de ferramenta roda todas as travas e
// junta as decisões. Barrar vence pedir aprovação, que vence liberar.
//
// Travas, nesta ordem (as que anotam algo ficam por último, para só anotar o que passou):
//   segurança: SQL pela conexão que escreve, chave secreta em arquivo ou commit, comando que
//              altera o banco (pede aprovação no mestre, barra no implementador), push sem o
//              pedido do usuário (pede aprovação), teste de desligar uma trava (pede aprovação);
//   retrabalho: briefing do mestre para os agentes; diff em dia, completo e opus em área
//              sensível para o revisor; a mesma falha que voltou e a parada depois de três
//              tentativas (convergência); dois implementadores no mesmo arquivo (paralelo);
//   economia:  mapa primeiro (Explore e revisor), orçamento de leitura do mestre, leitura
//              por trecho e teto de leituras do Explore.
// O tipo do agente vem na entrada do hook, então as travas de cada agente moram aqui, e não
// no arquivo dele. Cada decisão vai para o registro das travas (sem conteúdo).
// Política de falha: trava que quebra fica calada (segue o fluxo normal: as de segurança
// nunca liberam nada, só barram; as de economia deixam passar).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { anotacoes, anotar, carregarModulo, desligada, lerEntrada, lerEstado, registrarTrava, tipoDoAgente } from './equipe-comum.mjs';

// Cada trava num módulo carregado à parte: se um faltar ou quebrar (instalação pela metade),
// as outras continuam valendo, as de segurança inclusive, e a falha vai para o registro.
const carregar = (arquivo) => carregarModulo(import.meta.url, arquivo);
const [sql, segredos, banco, push, briefing, revisao, convergencia, paralelo, mapa, leitura] = await Promise.all([
  carregar('./equipe-sql.mjs'), carregar('./equipe-segredos.mjs'), carregar('./equipe-banco.mjs'), carregar('./equipe-push.mjs'),
  carregar('./equipe-briefing.mjs'), carregar('./equipe-revisao.mjs'), carregar('./equipe-convergencia.mjs'),
  carregar('./equipe-paralelo.mjs'), carregar('./equipe-mapa.mjs'), carregar('./equipe-leitura.mjs'),
]);
const nada = () => null;

// Teste da retrospectiva: desligar uma trava por 7 dias vale para todos os projetos, então pede
// o OK do usuário, também quando quem roda é um agente que a trava acabou de barrar. Valem o
// medidor rodado com --testar-trava e o que grava, copia, move ou apaga o arquivo do teste
// (pelo terminal ou pelas ferramentas de arquivo). Ler, buscar e citar num commit, não.
// Nunca desliga.
const RODA_TESTE = /\bnode(?:\.exe)?["']?\s[^|;&\n]*equipe-medir(?:\.mjs)?["']?[^|;&\n]*--testar-trava\b/i;
const MEXE_NO_ARQUIVO = /(?:>|\btee\b|\b(?:cp|mv|rm|del|copy|move)\b|Copy-Item|Move-Item|Remove-Item|Set-Content|Add-Content|Out-File|New-Item|write\w*|unlink\w*|rm\w*Sync|rename\w*)[^|;&\n]*teste-trava\.json/i;
const ARQUIVO_DO_TESTE = /(^|[\\/])teste-trava\.json$/i;
export function pedirTesteDeTrava(entrada) {
  const nome = String(entrada.tool_name || '');
  const ti = entrada.tool_input || {};
  let pedido = false;
  let trava = null;
  if (/^(Write|Edit|MultiEdit)$/.test(nome)) {
    pedido = ARQUIVO_DO_TESTE.test(String(ti.file_path || ''));
  } else {
    // Cada comando simples. Os que só leem ou citam (git, grep, cat, o texto de um commit)
    // ficam de fora, a não ser que gravem com ">" ("cat > teste-trava.json <<EOF").
    for (const parte of String(ti.command || '').split(/&&|\|\||[;\n|]/)) {
      const p = parte.trim();
      if (!p || (/^(git|grep|rg|findstr|Select-String|cat|type|Get-Content|less|more|head|tail)\b/i.test(p) && !p.includes('>'))) continue;
      if (RODA_TESTE.test(p)) { pedido = true; trava = trava || (p.match(/--testar-trava[\s=]+["']?([A-Za-z]+)/) || [])[1] || null; }
      else if (MEXE_NO_ARQUIVO.test(p)) pedido = true;
    }
  }
  if (!pedido) return null;
  return {
    decisao: 'ask',
    motivo: `Teste da retrospectiva: ${trava ? `desligar a trava "${trava}"` : 'mexer no teste de desligar uma trava'} por 7 dias, em todos os projetos, pede o seu OK. Aprove só se você escolheu esse teste na /retro-equipe.`,
  };
}

// Saída no formato dos hooks antigos (hookSpecificOutput) para { decisao, motivo }.
const deHook = (d) => (d && d.hookSpecificOutput ? { decisao: d.hookSpecificOutput.permissionDecision, motivo: d.hookSpecificOutput.permissionDecisionReason } : null);

// Nenhuma trava sem saída: cada uma declara em "saida" como o trabalho segue depois de barrado
// (um teste confere que toda trava tem a sua). Tipos: valvula (insistir passa, registrado),
// pedido (uma frase do usuário libera), aprovacao (o usuário aprova na hora), usuario (a
// próxima mensagem dele libera), caminho (há outro jeito certo de fazer) e nao-barra.
export const TIPOS_DE_SAIDA = ['valvula', 'pedido', 'aprovacao', 'usuario', 'caminho', 'nao-barra'];
export const TRAVAS = [
  { nome: 'sql', quando: /^mcp__.+__execute_sql$/, rodar: sql ? (e) => deHook(sql.decidir(e)) : nada, saida: { tipo: 'pedido', como: 'o OK do usuário no pedido ("pode rodar a consulta") ou a conexão só de leitura; sem ela no projeto, não barra' } },
  { nome: 'segredos', quando: /^(Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell)$/, rodar: segredos ? (e) => deHook(segredos.decidir(e)) : nada, saida: { tipo: 'caminho', como: 'variável de ambiente no lugar da chave; chave de exemplo passa' } },
  { nome: 'banco', quando: /^(Bash|PowerShell)$/, rodar: banco ? (e) => deHook(banco.decidir(e)) : nada, saida: { tipo: 'aprovacao', como: 'no mestre, pede a aprovação do usuário; o implementador devolve ao mestre' } },
  { nome: 'push', quando: /^(Bash|PowerShell)$/, rodar: push ? push.decidirPush : nada, saida: { tipo: 'aprovacao', como: 'pede a aprovação do usuário; com o pedido de push, passa' } },
  { nome: 'teste-trava', quando: /^(Bash|PowerShell|Write|Edit|MultiEdit)$/, rodar: pedirTesteDeTrava, saida: { tipo: 'aprovacao', como: 'pede a aprovação do usuário' } },
  { nome: 'briefing', quando: /^(Agent|Task)$/, rodar: briefing ? briefing.decidirBriefing : nada, saida: { tipo: 'valvula', como: 'o mesmo briefing mandado de novo passa' } },
  { nome: 'modelo', quando: /^(Agent|Task)$/, rodar: briefing ? briefing.modeloDoGenerico : nada, saida: { tipo: 'nao-barra', como: 'só troca o modelo; model: opus no pedido mantém' } },
  { nome: 'revisor', quando: /^(Agent|Task)$/, rodar: revisao ? revisao.decidirRevisor : nada, saida: { tipo: 'valvula', como: 'o mesmo briefing mandado de novo passa' } },
  { nome: 'convergencia', quando: /^(Agent|Task)$/, rodar: convergencia ? convergencia.decidirConvergencia : nada, saida: { tipo: 'usuario', como: 'a tentativa replanejada passa; depois de três falhas, a próxima mensagem do usuário libera' } },
  { nome: 'paralelo', quando: /^(Agent|Task)$/, rodar: paralelo ? paralelo.decidirParalelo : nada, saida: { tipo: 'valvula', como: 'o mesmo briefing mandado de novo passa' } },
  { nome: 'mapa', quando: /^(Read|Grep|Glob)$/, rodar: mapa ? mapa.decidirMapa : nada, saida: { tipo: 'valvula', como: 'consultar o mapa; se ele falhar, a tentativa seguinte passa' } },
  { nome: 'orcamento', quando: /^(Read|Grep|Bash|PowerShell)$/, rodar: mapa ? mapa.decidirOrcamento : nada, saida: { tipo: 'pedido', como: 'delegar ao Explore, ou "leia você mesmo" no pedido', insiste: false } },
  { nome: 'leitura', quando: /^Read$/, rodar: (e) => (leitura && tipoDoAgente(e) === 'Explore' && !desligada('leitura') ? deHook(leitura.decidir(e)) : null), saida: { tipo: 'caminho', como: 'ler por trecho; o teto é por chamada do Explore' } },
];

const PESO = { deny: 3, ask: 2, allow: 1 };

// A mesma trava barrando pela 3ª vez no mesmo pedido: em vez de o agente continuar tentando
// (e a sessão girar), a mensagem manda seguir com o resto e levar o caso ao usuário no fim,
// com o que libera. Só para as travas em que insistir não passa (saída por pedido ou por
// caminho); a trava continua barrando igual. O orçamento de leitura fica de fora: ele barra
// cada leitura depois do limite, e o caminho dele é delegar na hora, não esperar o usuário.
export const INSISTENCIA = 3;
function insistencia(t, entrada) {
  try {
    // Só o mestre fala com o usuário; o subagente tem o próprio teto de voltas.
    if (!t.saida || t.saida.insiste === false || !['pedido', 'caminho'].includes(t.saida.tipo) || tipoDoAgente(entrada) !== 'mestre') return '';
    const s = String(entrada.session_id || '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!s) return '';
    // Sem o registro do pedido (instalação pela metade), não há como saber onde um pedido
    // acaba: não conta, para o recado não aparecer em todo bloqueio da sessão.
    const pedido = lerEstado(`${s}-mestre`, 'pedido');
    if (!pedido || typeof pedido.em !== 'number') return '';
    const marca = `${pedido.em}|${t.nome}`;
    anotar(`${s}-sessao`, 'barradas', marca);
    const n = anotacoes(`${s}-sessao`, 'barradas').filter((x) => x === marca).length;
    if (n < INSISTENCIA) return '';
    registrarTrava(t.nome, 'insistiu', 0, entrada);
    return `\n\nEsta trava já barrou ${n} vezes neste pedido: não tente de novo por outro jeito. Siga com o resto da tarefa e, no fim, diga ao usuário o que ficou barrado e como liberar (${t.saida.como}).`;
  } catch { return ''; }
}

export function decidir(entrada) {
  if (!entrada || typeof entrada !== 'object') return null;
  const ferramenta = String(entrada.tool_name || '');
  let final = null;
  const motivos = [];
  const ctx = { registros: [] };
  // Campos que uma trava troca na entrada da ferramenta (o modelo do agente genérico).
  let atualizar = null;
  for (const t of TRAVAS) {
    if (!t.quando.test(ferramenta)) continue;
    const inicio = Date.now();
    let r = null;
    try { r = t.rodar(entrada, ctx); } catch { r = null; }
    const ms = Date.now() - inicio;
    const decisao = r && r.decisao;
    const registro = (r && r.registro) || (decisao === 'deny' ? 'barrou' : decisao === 'ask' ? 'pediu' : null);
    if (registro) {
      registrarTrava(t.nome, registro, ms, entrada);
      ctx.registros.push({ nome: t.nome, registro });
    }
    if (r && r.atualizar && typeof r.atualizar === 'object') atualizar = { ...(atualizar || {}), ...r.atualizar };
    if (!decisao || !PESO[decisao] || decisao === 'allow') continue;
    if (!final || PESO[decisao] > PESO[final]) final = decisao;
    if (r.motivo) motivos.push({ decisao, motivo: r.motivo + (decisao === 'deny' ? insistencia(t, entrada) : '') });
    // Barrou: as travas seguintes não rodam (nada de anotar leitura que não aconteceu).
    if (decisao === 'deny') break;
  }
  // Entrada trocada: vai junto da decisão (ask mostra a entrada nova). Sem decisão, vai só a
  // troca, sem "allow": as regras de permissão do usuário (deny, ask) continuam valendo, e a
  // versão antiga do Claude Code não pula a conferência delas. Barrar não leva a troca.
  if (atualizar && final !== 'deny') {
    const updatedInput = { ...(entrada.tool_input || {}), ...atualizar };
    if (!final) return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } };
    const motivo = motivos.filter((m) => m.decisao === final).map((m) => m.motivo).join('\n\n');
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: final, permissionDecisionReason: motivo, updatedInput } };
  }
  if (!final) return null;
  const texto = motivos.filter((m) => m.decisao === final).map((m) => m.motivo).join('\n\n');
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: final, permissionDecisionReason: texto } };
}

function principal() {
  let entrada = {};
  let saida = null;
  try {
    entrada = lerEntrada();
    saida = decidir(entrada);
    if (saida) process.stdout.write(JSON.stringify(saida));
  } catch {
    // Silêncio: segue o fluxo normal.
  }
  const d = saida ? saida.hookSpecificOutput.permissionDecision : 'passou';
  // Tempo do processo inteiro, com a partida do Node: é o que a sessão espera.
  registrarTrava('pre', d === 'deny' ? 'barrou' : d === 'ask' ? 'pediu' : 'passou', process.uptime() * 1000, entrada);
}

const real = (p) => {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch { /* fica o caminho dado */ }
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) principal();
