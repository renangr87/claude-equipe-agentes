// Testes dos indicadores novos do medidor da /retro-equipe: mapa antes da primeira leitura
// de código (Explore e revisor), leituras de código do mestre por pedido e a seção das
// travas, que vem do registro (equipe-diario/travas-AAAA-MM.log).
//   node --test testes/medidor-travas.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MEDIR = fileURLToPath(new URL('../hooks/equipe-medir.mjs', import.meta.url));

const tmp = (nome) => fs.mkdtempSync(path.join(os.tmpdir(), `equipe-${nome}-`));
const escrever = (arquivo, texto) => {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, texto);
};
const agora = Date.now();
const iso = (minutos) => new Date(agora - 60 * 60000 + minutos * 60000).toISOString();
const linha = (o) => JSON.stringify(o);
const uso = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const SEGREDO = 'SEGREDO-PLANTADO-987';

function medir(claude, ...args) {
  return execFileSync(process.execPath, [MEDIR, ...args], {
    encoding: 'utf8', env: { ...process.env, EQUIPE_PASTA_CLAUDE: claude },
  });
}

// Uma mensagem do assistente com as ferramentas dadas ([nome, entrada]).
let contador = 0;
function ferramentas(minuto, lista, extra = {}) {
  contador++;
  return linha({
    type: 'assistant', uuid: `as${contador}`, timestamp: iso(minuto), ...extra,
    message: { id: `m${contador}`, model: 'claude-haiku-5-5', usage: uso, content: lista.map(([name, input], i) => ({ type: 'tool_use', id: `t${contador}-${i}`, name, input })) },
  });
}
const pedido = (minuto, conteudo, extra = {}) => linha({ type: 'user', uuid: `p${++contador}`, timestamp: iso(minuto), cwd: '/tmp/app-exemplo', message: { role: 'user', content: conteudo }, ...extra });
const resultado = (minuto, id) => linha({ type: 'user', uuid: `r${++contador}`, timestamp: iso(minuto), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `conteúdo lido ${SEGREDO}` }] } });

const MAPA = 'mcp__codebase-memory__search_graph';

function cenario() {
  const claude = tmp('claude-travas');
  const pasta = path.join(claude, 'projects', '-app-exemplo');
  const sid = 'sessao-trava-1';
  // Sessão principal: 4 pedidos de verdade, mais linhas de usuário que não são pedidos.
  escrever(path.join(pasta, `${sid}.jsonl`), [
    pedido(0, `primeiro pedido ${SEGREDO}`),
    ferramentas(1, [['Read', { file_path: '/tmp/app-exemplo/src/a.ts' }], ['Read', { file_path: '/tmp/app-exemplo/README.md' }]], { cwd: '/tmp/app-exemplo' }),
    resultado(2, `t${contador}-0`),
    ferramentas(2, [['Read', { file_path: '/tmp/app-exemplo/src/b.ts' }]]),
    // Saída de comando local e mensagem de sistema: não abrem pedido novo.
    pedido(3, '<local-command-stdout>saída</local-command-stdout>'),
    pedido(3, 'aviso do sistema', { isMeta: true }),
    ferramentas(4, [['Read', { file_path: '/tmp/app-exemplo/src/c.ts' }]]),
    pedido(10, [{ type: 'text', text: `segundo pedido ${SEGREDO}` }]),
    ferramentas(11, [['Grep', { pattern: 'x' }]]),
    pedido(20, '<command-message>retro</command-message><command-name>/retro-equipe</command-name>'),
    ferramentas(21, [['Read', { file_path: '/tmp/app-exemplo/lib/d.dart' }]]),
    // O texto do pedido cita "tool_result": a linha é convertida inteira e continua pedido.
    pedido(30, `quarto pedido sobre tool_result ${SEGREDO}`),
    ferramentas(31, [['Agent', { subagent_type: 'Explore', prompt: SEGREDO }]]),
  ].join('\n') + '\n');
  const sub = path.join(pasta, sid, 'subagents');
  const agente = (id, tipo, linhas) => {
    escrever(path.join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType: tipo }));
    escrever(path.join(sub, `agent-${id}.jsonl`), [
      // O briefing chega como mensagem de usuário do subagente: não é pedido.
      pedido(1, `briefing ${SEGREDO}`, { isSidechain: true }),
      ...linhas,
    ].join('\n') + '\n');
  };
  const lado = { isSidechain: true };
  // Explore 1: mapa primeiro. Explore 2: lê código antes do mapa. Explore 3: não lê código.
  agente('e1', 'Explore', [ferramentas(2, [[MAPA, { query: SEGREDO }]], lado), ferramentas(3, [['Read', { file_path: '/tmp/app-exemplo/src/a.ts' }]], lado)]);
  agente('e2', 'Explore', [ferramentas(2, [['Glob', { pattern: 'src/**/*.{ts,tsx}' }]], lado), ferramentas(3, [[MAPA, {}]], lado)]);
  agente('e3', 'Explore', [ferramentas(2, [['Read', { file_path: '/tmp/app-exemplo/docs/x.md' }], ['Grep', { pattern: 'y', glob: '*.md' }]], lado)]);
  // Revisor 1: mapa e leitura na mesma mensagem, mapa antes. Revisor 2: Grep numa pasta antes do mapa.
  agente('r1', 'revisor', [ferramentas(2, [['mcp__codebase-memory__detect_changes', {}], ['Read', { file_path: '/tmp/app-exemplo/src/a.ts' }]], lado)]);
  agente('r2', 'revisor', [ferramentas(2, [['Grep', { pattern: 'z', path: '/tmp/app-exemplo/src' }]], lado), ferramentas(3, [['mcp__codebase-memory__trace_path', {}]], lado)]);

  // Registro das travas: linhas dentro e fora do período.
  const velho = new Date(agora - 30 * 86400000).toISOString();
  const dentro = (m) => iso(m);
  const reg = (q, trava, decisao, ms, tipo, chave) => [q, trava, decisao, ms, tipo, chave].join('\t');
  const mes = (d) => d.slice(0, 7);
  const linhasReg = [
    reg(velho, 'sql', 'barrou', 5, 'mestre', `${sid}-mestre`),
    reg(velho, 'pre', 'passou', 9000, 'mestre', `${sid}-mestre`),
    reg(dentro(1), 'mapa', 'barrou', 12, 'Explore', `${sid}-e2`),
    reg(dentro(2), 'mapa', 'fuga', 10, 'Explore', `${sid}-e2`),
    reg(dentro(2), 'mapa', 'consultou', 0, 'Explore', `${sid}-e1`),
    reg(dentro(2), 'mapa', 'consultou', 0, 'revisor', `${sid}-r1`),
    reg(dentro(3), 'mapa', 'consultou', 0, 'revisor', `${sid}-r2`),
    reg(dentro(3), 'orcamento', 'barrou', 8, 'mestre', `${sid}-mestre`),
    reg(dentro(3), 'orcamento', 'barrou', 8, 'mestre', `${sid}-mestre`),
    reg(dentro(4), 'sql', 'pediu', 3, 'mestre', `${sid}-mestre`),
    reg(dentro(4), 'briefing', 'valvula', 2, 'mestre', `${sid}-mestre`),
    reg(dentro(5), 'verificar', 'entregou-sem-verificar', 4, 'implementador', `${sid}-i1`),
    reg(dentro(5), 'revisao', 'concluiu-sem-revisao', 4, 'mestre', `${sid}-mestre`),
    reg(dentro(5), 'escopo', 'fora-do-escopo', 4, 'implementador', `${sid}-i1`),
    reg(dentro(6), 'pre', 'passou', 40, 'mestre', `${sid}-mestre`),
    reg(dentro(6), 'pre', 'barrou', 60, 'mestre', `${sid}-mestre`),
    reg(dentro(6), 'pre', 'passou', 350, 'mestre', `${sid}-mestre`),
    reg(dentro(7), 'pos', 'passou', 30, 'Explore', `${sid}-e1`),
    reg(dentro(7), 'eventos', 'SubagentStop', 20, 'implementador', `${sid}-i1`),
    'linha quebrada sem tabulação',
  ];
  const diario = path.join(claude, 'equipe-diario');
  const porMes = new Map();
  for (const l of linhasReg) {
    const k = /^\d{4}-\d{2}/.test(l) ? mes(l) : mes(new Date(agora).toISOString());
    if (!porMes.has(k)) porMes.set(k, []);
    porMes.get(k).push(l);
  }
  for (const [k, ls] of porMes) escrever(path.join(diario, `travas-${k}.log`), ls.join('\n') + '\n');
  return { claude, sid };
}

test('medidor: mapa antes da primeira leitura de código, por tipo de agente', () => {
  const { claude } = cenario();
  const r = JSON.parse(medir(claude, '--json'));
  assert.equal(r.porTipo.Explore.chamadas, 3);
  assert.equal(r.porTipo.Explore.comLeituraDeCodigo, 2, 'a chamada que só leu .md não conta');
  assert.equal(r.porTipo.Explore.mapaAntesDaLeitura, 1);
  assert.equal(r.porTipo.revisor.comLeituraDeCodigo, 2);
  assert.equal(r.porTipo.revisor.mapaAntesDaLeitura, 1);
  assert.equal(r.indicadores.mapa_antes_da_leitura_pct, 50);
  assert.match(medir(claude), /Mapa antes da primeira leitura de código: Explore 1 de 2 \(50%\), revisor 1 de 2 \(50%\)/);
});

test('medidor: leituras de código do mestre agrupadas por pedido', () => {
  const { claude } = cenario();
  const r = JSON.parse(medir(claude, '--json'));
  // Pedidos: 3 leituras de código (o README não conta), 0 (Grep não é Read), 1, 0.
  assert.deepEqual(r.mestre.pedidos, { total: 4, comLeitura: 2, mediana: 2, maximo: 3 });
  assert.equal(r.indicadores.mestre_leituras_por_pedido_mediana, 2);
  assert.match(medir(claude), /2 de 4 pedidos leram código; nesses, mediana 2,0 e máximo 3/);
});

test('medidor: seção das travas só com as linhas do período', () => {
  const { claude } = cenario();
  const r = JSON.parse(medir(claude, '--json'));
  const tv = r.travas;
  assert.equal(tv.porTrava.sql.barrou, undefined, 'a linha velha fica de fora');
  assert.equal(tv.porTrava.sql.pediu, 1);
  assert.equal(tv.porTrava.orcamento.barrou, 2);
  assert.equal(tv.porTrava.briefing.valvula, 1);
  assert.deepEqual(tv.mapa, { chamadas: 4, fugas: 1, semTentar: 0 });
  assert.equal(tv.entregasSemVerificar, 1);
  assert.equal(tv.conclusoesSemRevisao, 1);
  assert.equal(tv.foraDoEscopo, 1);
  assert.deepEqual(tv.tempos.pre, { vezes: 3, media: 150, p95: 350, pior: 350 });
  assert.equal(tv.tempos.pos.pior, 30);
  assert.equal(tv.tempos.eventos.vezes, 1);
  assert.equal(r.indicadores.fugas_do_mapa_pct, 25);
  assert.equal(r.indicadores.entregas_sem_verificacao, 1);
  assert.equal(r.indicadores.conclusoes_sem_revisor, 1);
  assert.equal(r.indicadores.hooks_p95_ms, 350);
  const t = medir(claude);
  assert.match(t, /## Travas/);
  assert.match(t, /- orcamento: 2 barrou\./);
  assert.match(t, /- mapa: 1 barrou\./);
  assert.match(t, /Fugas do mapa: 1 de 4 \(25%\)/);
  assert.match(t, /Entregas sem verificação: 1\. Mudanças concluídas sem chamar o revisor depois da cobrança: 1\./);
  assert.match(t, /pre 150 ms em média, p95 350 ms, pior 350 ms \(3x\)/);
  assert.doesNotMatch(t, /9\.000 ms|9000/);
});

test('medidor: com filtro de projeto, só as travas das sessões medidas', () => {
  const { claude } = cenario();
  const diario = path.join(claude, 'equipe-diario');
  const arq = fs.readdirSync(diario).filter((n) => n.startsWith('travas-')).sort().pop();
  fs.appendFileSync(path.join(diario, arq), [iso(8), 'leitura', 'barrou', 3, 'Explore', 'outra-sessao-e9'].join('\t') + '\n');
  assert.equal(JSON.parse(medir(claude, '--json')).travas.porTrava.leitura.barrou, 1);
  const r = JSON.parse(medir(claude, '--json', '--projeto', 'app-exemplo'));
  assert.equal(r.travas.porTrava.leitura, undefined);
  assert.equal(r.travas.porTrava.orcamento.barrou, 2);
});

test('medidor: sem registro das travas, diz que não há decisões', () => {
  const { claude } = cenario();
  fs.rmSync(path.join(claude, 'equipe-diario'), { recursive: true, force: true });
  const r = JSON.parse(medir(claude, '--json'));
  assert.equal(r.indicadores.fugas_do_mapa_pct, null);
  assert.match(medir(claude), /Nenhuma decisão no registro das travas/);
});

test('medidor: nada do conteúdo das transcrições vai para a saída', () => {
  const { claude } = cenario();
  assert.doesNotMatch(medir(claude), new RegExp(SEGREDO));
  assert.doesNotMatch(medir(claude, '--json'), new RegExp(SEGREDO));
  assert.doesNotMatch(medir(claude, '--retro'), new RegExp(SEGREDO));
});

test('comparação inclui os indicadores novos e pula os que não deu para medir', async () => {
  const { comparacao } = await import(pathToFileURL(MEDIR).href);
  const antes = { mapa_antes_da_leitura_pct: 50, mestre_leituras_por_pedido_mediana: 4, fugas_do_mapa_pct: 10, hooks_p95_ms: 100, entregas_sem_verificacao: null };
  const agora2 = { mapa_antes_da_leitura_pct: 90, mestre_leituras_por_pedido_mediana: 2, fugas_do_mapa_pct: 20, hooks_p95_ms: 100, entregas_sem_verificacao: 3 };
  const t = comparacao(antes, agora2);
  assert.match(t, /mapa antes da primeira leitura de código \| 50% \| 90% \| melhorou/);
  assert.match(t, /Leituras de código do mestre por pedido \(mediana\) \| 4,0 \| 2,0 \| melhorou/);
  assert.match(t, /Fugas do mapa \| 10% \| 20% \| piorou/);
  assert.match(t, /Tempo dos hooks \(p95 do mais lento\) \| 100 ms \| 100 ms \| = \|/);
  assert.doesNotMatch(t, /Entregas sem verificação/);
});

test('leitura de código: mesmos critérios da trava do mapa, sem olhar o disco', async () => {
  const { leituraDeCodigo } = await import(pathToFileURL(MEDIR).href);
  assert.equal(leituraDeCodigo('Read', { file_path: 'C:\\app\\lib\\main.dart' }), true);
  assert.equal(leituraDeCodigo('Read', { file_path: '/app/README.md' }), false);
  assert.equal(leituraDeCodigo('Read', { file_path: '/app/.revisao/diff.ts' }), false);
  assert.equal(leituraDeCodigo('Grep', { pattern: 'x' }), true);
  assert.equal(leituraDeCodigo('Grep', { pattern: 'x', path: '/app/src' }), true);
  assert.equal(leituraDeCodigo('Grep', { pattern: 'x', path: '/app/notas.md' }), false);
  assert.equal(leituraDeCodigo('Grep', { pattern: 'x', type: 'md' }), false);
  assert.equal(leituraDeCodigo('Grep', { pattern: 'x', type: 'py' }), true);
  assert.equal(leituraDeCodigo('Grep', { pattern: 'x', glob: '*.{ts,tsx}' }), true);
  assert.equal(leituraDeCodigo('Glob', { pattern: '**/*.json' }), false);
  assert.equal(leituraDeCodigo('Glob', { pattern: '**/*.go' }), true);
});

test('medidor: correção de bug com teste vermelho antes da correção', () => {
  const claude = tmp('claude-vermelho');
  const pasta = path.join(claude, 'projects', '-app-exemplo');
  const sid = 'sessao-vermelho';
  escrever(path.join(pasta, `${sid}.jsonl`), [pedido(0, 'arrume o cupom'), ferramentas(1, [['Agent', { subagent_type: 'implementador', prompt: 'x' }]])].join('\n') + '\n');
  const sub = path.join(pasta, sid, 'subagents');
  const lado = { isSidechain: true };
  const erro = (minuto, id) => linha({ type: 'user', uuid: `er${++contador}`, timestamp: iso(minuto), isSidechain: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: `1 failing ${SEGREDO}` }] } });
  const agente = (id, briefing, linhas) => {
    escrever(path.join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'implementador' }));
    escrever(path.join(sub, `agent-${id}.jsonl`), [pedido(1, `${briefing} ${SEGREDO}`, lado), ...linhas].join('\n') + '\n');
  };
  // i1: edita o teste, roda e vê vermelho, depois corrige o código: conta como certo.
  let a = ferramentas(2, [['Edit', { file_path: '/tmp/app-exemplo/test/cupom.test.js' }]], lado);
  let b = ferramentas(3, [['Bash', { command: 'npm test' }]], lado);
  const idB = `t${contador}-0`;
  agente('i1', 'Objetivo: corrigir o bug do cupom percentual', [a, b, erro(4, idB), ferramentas(5, [['Edit', { file_path: '/tmp/app-exemplo/src/cupom.js' }]], lado)]);
  // i2: corrige antes de ver o teste falhar.
  a = ferramentas(2, [['Edit', { file_path: '/tmp/app-exemplo/src/frete.js' }]], lado);
  b = ferramentas(3, [['Bash', { command: 'npm test' }]], lado);
  agente('i2', 'Objetivo: consertar o erro do frete que vem zerado', [a, b, erro(4, `t${contador}-0`)]);
  // i3: não é correção de bug.
  agente('i3', 'Objetivo: tela nova de perfil', [ferramentas(2, [['Write', { file_path: '/tmp/app-exemplo/src/perfil.js' }]], lado)]);
  const r = JSON.parse(medir(claude, '--json'));
  assert.equal(r.porTipo.implementador.correcoes, 2);
  assert.equal(r.porTipo.implementador.vermelhoAntes, 1);
  assert.equal(r.indicadores.correcao_com_teste_vermelho_pct, 50);
  const t = medir(claude);
  assert.match(t, /Correções de bug do implementador com teste vermelho antes da correção: 1 de 2 \(50%\)/);
  assert.ok(!t.includes(SEGREDO));
});

test('medidor: "corrigir o texto" não é correção de bug, e analisador não conta como teste', () => {
  const claude = tmp('claude-vermelho2');
  const pasta = path.join(claude, 'projects', '-app-exemplo');
  const sid = 'sessao-vermelho2';
  escrever(path.join(pasta, `${sid}.jsonl`), [pedido(0, 'x'), ferramentas(1, [['Agent', { subagent_type: 'implementador', prompt: 'x' }]])].join('\n') + '\n');
  const sub = path.join(pasta, sid, 'subagents');
  const lado = { isSidechain: true };
  const erro = (minuto, id) => linha({ type: 'user', uuid: `er${++contador}`, timestamp: iso(minuto), isSidechain: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'erro' }] } });
  const agente = (id, briefing, linhas) => {
    escrever(path.join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'implementador' }));
    escrever(path.join(sub, `agent-${id}.jsonl`), [pedido(1, briefing, lado), ...linhas].join('\n') + '\n');
  };
  agente('t1', 'Objetivo: corrigir o texto do botão', [ferramentas(2, [['Edit', { file_path: '/tmp/app-exemplo/src/botao.js' }]], lado)]);
  // Correção de bug em que só o analisador ficou vermelho antes: não conta como teste vermelho.
  const b = ferramentas(2, [['Bash', { command: 'flutter analyze' }]], lado);
  agente('t2', 'Escopo: lib/a.dart\nObjetivo: bug no login', [b, erro(3, `t${contador}-0`), ferramentas(4, [['Edit', { file_path: '/tmp/app-exemplo/lib/a.dart' }]], lado)]);
  const r = JSON.parse(medir(claude, '--json'));
  assert.equal(r.porTipo.implementador.correcoes, 1);
  assert.equal(r.porTipo.implementador.vermelhoAntes, 0);
});

test('para onde vai o custo: cada fonte pelo tamanho e por quantas vezes foi relida', () => {
  const claude = tmp('claude-gasto');
  const pasta = path.join(claude, 'projects', '-app-gasto');
  const t = (n) => new Date(agora - 30 * 60000 + n * 60000).toISOString();
  let k = 0;
  // Um passo do Sonnet: a entrada cresce com o que entrou no contexto.
  const passo = (n, entrada, conteudo) => linha({ type: 'assistant', uuid: `g${++k}`, timestamp: t(n), cwd: '/tmp/app-gasto', message: { id: `gm${k}`, model: 'claude-sonnet-5-5', usage: { input_tokens: 0, output_tokens: 100, cache_read_input_tokens: entrada, cache_creation_input_tokens: 0 }, content: conteudo } });
  const resultadoDe = (n, id, texto) => linha({ type: 'user', uuid: `gr${++k}`, timestamp: t(n), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: texto }] } });
  escrever(path.join(pasta, 's-gasto.jsonl'), [
    linha({ type: 'user', uuid: 'gp', timestamp: t(0), cwd: '/tmp/app-gasto', message: { role: 'user', content: 'leia o arquivo e rode os testes' } }),
    passo(1, 10000, [{ type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: '/tmp/app-gasto/a.ts' } }]),
    // Um arquivo grande lido (40 mil caracteres) e uma saída de terminal pequena.
    resultadoDe(2, 'u1', 'x'.repeat(40000)),
    passo(3, 20000, [{ type: 'tool_use', id: 'u2', name: 'Bash', input: { command: 'npm test' } }]),
    resultadoDe(4, 'u2', 'ok '.repeat(1000)),
    passo(5, 21000, [{ type: 'text', text: 'Pronto.' }]),
    passo(6, 21100, [{ type: 'text', text: 'Mais um passo.' }]),
  ].join('\n') + '\n');
  const r = JSON.parse(medir(claude, '--json', '--dias', '2'));
  const g = r.gasto.mestre;
  for (const k2 of ['fixo', 'leitura', 'terminal', 'escrita']) assert.ok(g[k2] > 0, k2);
  // A leitura grande pesa mais que a saída de terminal pequena, e as partes somam o custo real.
  assert.ok(g.leitura > 3 * g.terminal, JSON.stringify(g));
  const soma = Object.values(g).reduce((x, v) => x + v, 0);
  assert.ok(Math.abs(soma - r.custo.mestre) < 1e-9, `${soma} x ${r.custo.mestre}`);
  assert.ok(r.indicadores.gasto_leitura_pct > r.indicadores.gasto_terminal_pct);
  const texto = medir(claude, '--dias', '2');
  assert.match(texto, /## Para onde vai o custo/);
  assert.match(texto, /Leitura de arquivos \(Read\)/);
});

test('medidor: conclusão sem revisão separada de pausa e de revisor chamado', () => {
  const claude = tmp('claude-conclusoes');
  const diario = path.join(claude, 'equipe-diario');
  const em = (min) => new Date(agora - 50 * 60000 + min * 60000).toISOString();
  const reg = (q, trava, decisao, tipo, chave) => [q, trava, decisao, '5', tipo, chave].join('\t');
  const linhas = [
    // Sessão A: cobrada, encerrou sem chamar o revisor.
    reg(em(1), 'revisao', 'barrou', 'mestre', 'sa-mestre'),
    reg(em(2), 'revisao', 'concluiu-sem-revisao', 'mestre', 'sa-mestre'),
    // Sessão B: cobrada, chamou o revisor (que não aprovou), encerrou.
    reg(em(3), 'revisao', 'barrou', 'mestre', 'sb-mestre'),
    reg(em(4), 'eventos', 'SubagentStop', 'revisor', 'sb-r1'),
    reg(em(5), 'revisao', 'concluiu-sem-revisao', 'mestre', 'sb-mestre'),
    // Sessão C: cobrada, parou para perguntar.
    reg(em(6), 'revisao', 'barrou', 'mestre', 'sc-mestre'),
    reg(em(7), 'revisao', 'pausou-sem-revisao', 'mestre', 'sc-mestre'),
    // Fuga do mapa sem tentar.
    reg(em(8), 'mapa', 'fuga-sem-tentar', 'Explore', 'sd-e1'),
    // Sessão E: cobrada, chamou o revisor em segundo plano e encerrou antes de ele terminar.
    reg(em(9), 'revisao', 'barrou', 'mestre', 'se-mestre'),
    reg(em(10), 'eventos', 'SubagentStart', 'revisor', 'se-r2'),
    reg(em(11), 'revisao', 'concluiu-sem-revisao', 'mestre', 'se-mestre'),
    reg(em(12), 'eventos', 'SubagentStop', 'revisor', 'se-r2'),
  ];
  escrever(path.join(diario, `travas-${new Date(agora).toISOString().slice(0, 7)}.log`), linhas.join('\n') + '\n');
  const r = JSON.parse(medir(claude, '--json'));
  assert.equal(r.travas.conclusoesSemRevisao, 1);
  assert.equal(r.travas.conclusoesComRevisor, 2);
  assert.equal(r.travas.pausasSemRevisao, 1);
  assert.equal(r.travas.mapa.semTentar, 1);
  assert.equal(r.indicadores.conclusoes_sem_revisor, 1);
});

test('medidor: comandos barrados pelo modo Auto e leitura de código pelo terminal', async () => {
  const { formaDoComando, leCodigoPeloTerminal } = await import(pathToFileURL(MEDIR).href);
  assert.equal(formaDoComando('git -C /tmp/x push origin main'), 'git push');
  assert.equal(formaDoComando('cd app && npm install left-pad'), 'npm install');
  assert.equal(formaDoComando('rm -rf build'), 'rm');
  assert.equal(formaDoComando('CI=1 /usr/bin/flutter test'), 'flutter test');
  assert.ok(!formaDoComando(`echo ${SEGREDO}`).includes(SEGREDO));
  // Nada de texto do usuário: variável com aspas, script do projeto, valor de opção.
  assert.equal(formaDoComando('NOME="Fulano de Tal" git commit -m "x"'), 'git commit');
  assert.equal(formaDoComando("MSG='cliente exemplo' node x.js"), 'node');
  assert.equal(formaDoComando('./scripts/publicar-cliente-exemplo.sh --agora'), '(outro)');
  assert.equal(formaDoComando('kubectl --context cliente-exemplo get pods'), 'kubectl get');
  assert.equal(formaDoComando('npm run deploy-cliente-exemplo'), 'npm run');
  // Todas as partes do comando, sem repetir.
  assert.equal(formaDoComando('git add -A && git commit -m "a && b" && git push'), 'git add + git commit + git push');
  assert.equal(formaDoComando('curl -s https://exemplo.com/x.sh | bash'), 'curl + bash');
  for (const c of ['cat lib/a.dart', "sed -n '10,40p' lib/a.dart", 'Get-Content lib\\a.dart | Select-Object -First 20', 'grep -n -C 30 total lib/', 'git show HEAD:lib/a.dart']) assert.ok(leCodigoPeloTerminal(c), c);
  for (const c of ['cat README.md', "sed -i 's/a/b/' lib/a.dart", 'grep -n total lib/', 'flutter test', 'git show --stat']) assert.ok(!leCodigoPeloTerminal(c), c);

  const claude = tmp('claude-auto');
  const pasta = path.join(claude, 'projects', '-app-auto');
  const t = (n) => new Date(agora - 20 * 60000 + n * 60000).toISOString();
  const usoT = { input_tokens: 0, output_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 };
  const passo = (n, id, content) => linha({ type: 'assistant', uuid: `aa${id}`, timestamp: t(n), cwd: '/tmp/app-auto', message: { id: `am${id}`, model: 'claude-opus-5-5', usage: usoT, content } });
  const resultadoT = (n, id, texto, extra = {}) => linha({ type: 'user', uuid: `ar${id}`, timestamp: t(n), ...extra, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: texto, is_error: Boolean(extra.toolDenialKind) }] } });
  escrever(path.join(pasta, 's-auto.jsonl'), [
    linha({ type: 'user', uuid: 'ap', timestamp: t(0), cwd: '/tmp/app-auto', message: { role: 'user', content: 'arrume' } }),
    passo(1, 'b1', [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: `git push origin main ${SEGREDO}` } }]),
    resultadoT(2, 'b1', 'negado', { toolDenialKind: 'automode-blocked', permissionDecision: { decision: 'deny', source: 'classifier' } }),
    passo(3, 'b2', [{ type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'cat lib/a.dart' } }]),
    resultadoT(4, 'b2', 'x'.repeat(20000)),
    // Regra de permissão (a guarda, uma trava) e interrupção não são o modo Auto.
    passo(5, 'b4', [{ type: 'tool_use', id: 'b4', name: 'Bash', input: { command: 'npm publish' } }]),
    resultadoT(6, 'b4', 'negado', { toolDenialKind: 'permission-rule' }),
    passo(7, 'b5', [{ type: 'tool_use', id: 'b5', name: 'Bash', input: { command: 'flutter test' } }]),
    resultadoT(8, 'b5', 'interrompido', { toolDenialKind: 'interrupted' }),
    passo(9, 'b3', [{ type: 'text', text: 'Pronto.' }]),
  ].join('\n') + '\n');
  const r = JSON.parse(medir(claude, '--json', '--dias', '2'));
  assert.deepEqual(r.comandosBarrados, { 'git push': 1 });
  assert.ok(r.gasto.mestre.leitura > 0, JSON.stringify(r.gasto.mestre));
  assert.ok(!r.gasto.mestre.terminal || r.gasto.mestre.terminal < r.gasto.mestre.leitura);
  const texto = medir(claude, '--dias', '2');
  assert.match(texto, /Comandos de terminal barrados \(programa e subcomando, sem argumentos\): git push 1x/);
  assert.ok(!texto.includes(SEGREDO));
});

test('medidor: o revisor lendo arquivo do diff que recebeu não conta como leitura sem mapa', () => {
  const claude = tmp('claude-revdiff');
  const pasta = path.join(claude, 'projects', '-app-rev');
  const sid = 'sessao-revdiff';
  escrever(path.join(pasta, `${sid}.jsonl`), [pedido(0, 'revise'), ferramentas(1, [['Agent', { subagent_type: 'revisor', prompt: 'x' }]])].join('\n') + '\n');
  const sub = path.join(pasta, sid, 'subagents');
  const lado = { isSidechain: true };
  const agente = (id, linhas) => {
    escrever(path.join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'revisor' }));
    escrever(path.join(sub, `agent-${id}.jsonl`), [pedido(1, 'briefing', { isSidechain: true }), ...linhas].join('\n') + '\n');
  };
  // O Read devolve cada linha com o número na frente (com tab, ou com a seta nas versões novas).
  const diff = (n, id, numero = (i) => `     ${i}\t`) => linha({ type: 'user', uuid: `rd${id}`, timestamp: iso(n), isSidechain: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `${numero(1)}diff --git a/src/a.ts b/src/a.ts\n${numero(2)}index 1..2 100644\n` }] } });
  // Revisor 1: lê o diff e o arquivo do diff, sem mapa: não conta como leitura de código.
  agente('d1', [ferramentas(2, [['Read', { file_path: '/tmp/app-rev/.revisao/diff.patch' }]], lado), diff(3, `t${contador}-0`), ferramentas(4, [['Read', { file_path: '/tmp/app-rev/src/a.ts' }]], lado)]);
  // Revisor 2: lê o diff e depois um arquivo fora dele, sem mapa: conta.
  agente('d2', [ferramentas(2, [['Read', { file_path: '/tmp/app-rev/.revisao/diff.patch' }]], lado), diff(3, `t${contador}-0`), ferramentas(4, [['Read', { file_path: '/tmp/app-rev/src/b.ts' }]], lado)]);
  // Revisor 3: o diff com a seta depois do número; o arquivo do diff não conta.
  agente('d3', [ferramentas(2, [['Read', { file_path: '/tmp/app-rev/.revisao/diff.patch' }]], lado), diff(3, `t${contador}-0`, (i) => `${i}→`), ferramentas(4, [['Read', { file_path: '/tmp/app-rev/src/a.ts' }]], lado)]);
  const r = JSON.parse(medir(claude, '--json'));
  assert.equal(r.porTipo.revisor.chamadas, 3);
  assert.equal(r.porTipo.revisor.comLeituraDeCodigo, 1);
  assert.equal(r.porTipo.revisor.mapaAntesDaLeitura, 0);
});
