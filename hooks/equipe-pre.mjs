#!/usr/bin/env node
// Hook PreToolUse da equipe: um processo por chamada de ferramenta roda todas as travas e
// junta as decisões. Barrar vence pedir aprovação, que vence liberar.
//
// Travas, nesta ordem (as que anotam algo ficam por último, para só anotar o que passou):
//   segurança: SQL pela conexão que escreve, chave secreta em arquivo ou commit, comando que
//              altera o banco (pede aprovação no mestre, barra no implementador);
//   retrabalho: briefing do mestre para os agentes; a mesma falha que voltou (convergência);
//   economia:  mapa primeiro (Explore e revisor), orçamento de leitura do mestre, leitura
//              por trecho e teto de leituras do Explore.
// O tipo do agente vem na entrada do hook, então as travas de cada agente moram aqui, e não
// no arquivo dele. Cada decisão vai para o registro das travas (sem conteúdo).
// Política de falha: trava que quebra fica calada (segue o fluxo normal: as de segurança
// nunca liberam nada, só barram; as de economia deixam passar).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desligada, lerEntrada, registrarTrava, tipoDoAgente } from './equipe-comum.mjs';

// Cada trava num módulo carregado à parte: se um faltar ou quebrar (instalação pela metade),
// as outras continuam valendo, as de segurança inclusive.
async function carregar(arquivo) {
  try { return await import(new URL(arquivo, import.meta.url).href); } catch { return null; }
}
const [sql, segredos, banco, briefing, mapa, leitura, convergencia] = await Promise.all([
  carregar('./equipe-sql.mjs'), carregar('./equipe-segredos.mjs'), carregar('./equipe-banco.mjs'),
  carregar('./equipe-briefing.mjs'), carregar('./equipe-mapa.mjs'), carregar('./equipe-leitura.mjs'),
  carregar('./equipe-convergencia.mjs'),
]);
const nada = () => null;

// Saída no formato dos hooks antigos (hookSpecificOutput) para { decisao, motivo }.
const deHook = (d) => (d && d.hookSpecificOutput ? { decisao: d.hookSpecificOutput.permissionDecision, motivo: d.hookSpecificOutput.permissionDecisionReason } : null);

export const TRAVAS = [
  { nome: 'sql', quando: /^mcp__.+__execute_sql$/, rodar: sql ? (e) => deHook(sql.decidir(e)) : nada },
  { nome: 'segredos', quando: /^(Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell)$/, rodar: segredos ? (e) => deHook(segredos.decidir(e)) : nada },
  { nome: 'banco', quando: /^(Bash|PowerShell)$/, rodar: banco ? (e) => deHook(banco.decidir(e)) : nada },
  { nome: 'briefing', quando: /^(Agent|Task)$/, rodar: briefing ? briefing.decidirBriefing : nada },
  { nome: 'convergencia', quando: /^(Agent|Task)$/, rodar: convergencia ? convergencia.decidirConvergencia : nada },
  { nome: 'mapa', quando: /^(Read|Grep|Glob)$/, rodar: mapa ? mapa.decidirMapa : nada },
  { nome: 'orcamento', quando: /^Read$/, rodar: mapa ? mapa.decidirOrcamento : nada },
  { nome: 'leitura', quando: /^Read$/, rodar: (e) => (leitura && tipoDoAgente(e) === 'Explore' && !desligada('leitura') ? deHook(leitura.decidir(e)) : null) },
];

const PESO = { deny: 3, ask: 2, allow: 1 };

export function decidir(entrada) {
  if (!entrada || typeof entrada !== 'object') return null;
  const ferramenta = String(entrada.tool_name || '');
  let final = null;
  const motivos = [];
  const ctx = { registros: [] };
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
    if (!decisao || !PESO[decisao] || decisao === 'allow') continue;
    if (!final || PESO[decisao] > PESO[final]) final = decisao;
    if (r.motivo) motivos.push({ decisao, motivo: r.motivo });
    // Barrou: as travas seguintes não rodam (nada de anotar leitura que não aconteceu).
    if (decisao === 'deny') break;
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
