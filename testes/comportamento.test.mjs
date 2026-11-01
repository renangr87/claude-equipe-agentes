// Testes do executor e das checagens dos testes de comportamento, sem o Claude Code de
// verdade: argumentos, comparação de resultados, troca do esforço dos agentes e as
// checagens novas contra transcrições pequenas e falsas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AVALIACOES, conferir, criarContexto, criarProjeto, lerSessao, prepararTarefa } from './comportamento/avaliacoes.mjs';
import { aplicarEsforco, compararResultados, conferirPastaDeTeste, lerArgs, lerEsforco, resumirTravas } from './comportamento/rodar.mjs';

const RODAR = fileURLToPath(new URL('./comportamento/rodar.mjs', import.meta.url));
const tmp = (nome) => fs.mkdtempSync(path.join(os.tmpdir(), `equipe-comp-${nome}-`));
const escrever = (arquivo, texto) => {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, texto);
};
const git = (a, cwd) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const IDENT = ['-c', 'user.name=Teste', '-c', 'user.email=teste@exemplo.com'];

// ---------- transcrição falsa ----------
// u('Read', { file_path }) etc. Monta { mestre, agentes } como lerSessao devolve.
const u = (nome, entrada = {}, extra = {}) => ({ nome, entrada, resultado: '', erro: false, ...extra });
const sessao = (usos, { textos = [], textoFinal = '', agentes = [] } = {}) => ({
  mestre: { usos, textos, textoFinal },
  agentes: agentes.map((a) => ({ textos: [], textoFinal: '', ...a })),
});
const agente = (tipo) => u('Agent', { subagent_type: tipo, prompt: 'x' });
const av = (nome) => AVALIACOES.find((a) => a.nome === nome);
const checagem = (nomeAv, nomeCh, s, ctx = {}) => {
  const r = conferir(av(nomeAv), s, ctx).find((c) => c.nome === nomeCh);
  assert.ok(r, `checagem ${nomeCh} existe`);
  return r;
};

// Projeto de exemplo com a preparação da tarefa, e o contexto das checagens.
function projeto(nomeAv, chave = 'chave-falsa-de-teste') {
  const pasta = tmp(nomeAv);
  criarProjeto(pasta, git);
  prepararTarefa(av(nomeAv), pasta, { chave, git });
  const base = git(['rev-parse', 'HEAD'], pasta).trim();
  return { pasta, ctx: criarContexto(pasta, { chave, base }) };
}

test('comportamento: são 13 tarefas, com nomes únicos', () => {
  const nomes = AVALIACOES.map((a) => a.nome);
  assert.equal(new Set(nomes).size, nomes.length);
  for (const n of ['pedido-vago', 'escopo-vazando', 'mudanca-grande', 'teste-quebrado', 'erro-do-analisador', 'segredo-no-commit', 'pergunta-de-codigo']) assert.ok(nomes.includes(n), n);
  assert.equal(nomes.length, 13);
});

test('comportamento: lerSessao guarda a ordem dos textos entre os usos', () => {
  const pasta = tmp('sessao');
  const L = (o) => JSON.stringify(o);
  const arq = path.join(pasta, 's.jsonl');
  escrever(arq, [
    L({ type: 'assistant', message: { content: [{ type: 'text', text: 'Plano: 1. ler 2. mudar' }] } }),
    L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Edit', input: { file_path: 'x.js' } }] } }),
    L({ type: 'assistant', message: { content: [{ type: 'text', text: 'Feito.' }] } }),
  ].join('\n') + '\n');
  const s = lerSessao(arq);
  assert.deepEqual(s.mestre.textos.map((t) => t.pos), [0, 1]);
  assert.equal(s.mestre.textoFinal, 'Feito.');
});

// ---------- argumentos ----------
test('comportamento: lerArgs entende as opções e recusa o que está errado', () => {
  assert.deepEqual(lerArgs([]), { filtro: '', manter: false, config: null, rotulo: '', esforco: null, comparar: null, erro: null });
  const r = lerArgs(['--so', 'segredo', '--manter', '--config', 'pasta-b', '--rotulo', 'nova.1', '--esforco', 'Explore=medium, implementador=low']);
  assert.equal(r.erro, null);
  assert.equal(r.filtro, 'segredo');
  assert.equal(r.manter, true);
  assert.equal(r.config, 'pasta-b');
  assert.equal(r.rotulo, 'nova.1');
  assert.deepEqual(r.esforco, { Explore: 'medium', implementador: 'low' });
  assert.deepEqual(lerArgs(['--comparar', 'a.json', 'b.json']).comparar, ['a.json', 'b.json']);
  assert.match(lerArgs(['--esforco', 'Explore=medium']).erro, /só vale junto com --config/);
  assert.match(lerArgs(['--config', 'x', '--esforco', 'Explore=rapido']).erro, /--esforco inválido/);
  assert.match(lerArgs(['--config', 'x', '--esforco', 'Explore']).erro, /--esforco inválido/);
  assert.match(lerArgs(['--comparar', 'a.json']).erro, /dois arquivos/);
  assert.match(lerArgs(['--config']).erro, /faltou o valor de --config/);
  assert.match(lerArgs(['--rotulo', 'com espaço']).erro, /rótulo/);
  assert.match(lerArgs(['--qualquer']).erro, /opção desconhecida/);
  assert.equal(lerEsforco(''), null);
});

test('comportamento: --esforco sem --config é recusado antes de procurar o claude', () => {
  const r = spawnSync(process.execPath, [RODAR, '--esforco', 'Explore=low'], { encoding: 'utf8', env: { ...process.env, CLAUDE_BIN: path.join(tmp('sem'), 'nao-existe') } });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /só vale junto com --config/);
});

test('comportamento: a pasta de teste não pode ser a pasta de verdade do Claude', () => {
  const pasta = tmp('cfg');
  assert.equal(conferirPastaDeTeste(pasta, {}), null);
  assert.match(conferirPastaDeTeste(path.join(pasta, 'nao-existe'), {}), /não existe/);
  assert.match(conferirPastaDeTeste(pasta, { CLAUDE_CONFIG_DIR: pasta }), /pasta de verdade/);
  const casa = path.join(os.homedir(), '.claude');
  if (fs.existsSync(casa)) assert.match(conferirPastaDeTeste(casa, {}), /pasta de verdade/);
});

// ---------- esforço dos agentes ----------
test('comportamento: aplicarEsforco troca a linha effort e devolve o original', () => {
  const cfg = tmp('esforco');
  const explore = '---\nname: Explore\nmodel: haiku\neffort: high\n---\n\nTexto com effort: high no corpo.\n';
  const impl = '---\r\nname: implementador\r\nmodel: sonnet\r\n---\r\n\r\nCorpo.\r\n';
  escrever(path.join(cfg, 'agents', 'Explore.md'), explore);
  escrever(path.join(cfg, 'agents', 'implementador.md'), impl);
  const restaurar = aplicarEsforco(cfg, { Explore: 'medium', implementador: 'low' });
  const e = fs.readFileSync(path.join(cfg, 'agents', 'Explore.md'), 'utf8');
  assert.match(e, /^effort: medium$/m);
  assert.match(e, /no corpo/);
  assert.ok(e.includes('Texto com effort: high no corpo.'), 'o corpo não muda');
  assert.equal(fs.readFileSync(path.join(cfg, 'agents', 'implementador.md'), 'utf8'), '---\r\nname: implementador\r\nmodel: sonnet\r\neffort: low\r\n---\r\n\r\nCorpo.\r\n');
  restaurar();
  restaurar();
  assert.equal(fs.readFileSync(path.join(cfg, 'agents', 'Explore.md'), 'utf8'), explore);
  assert.equal(fs.readFileSync(path.join(cfg, 'agents', 'implementador.md'), 'utf8'), impl);
  // Agente que não existe: erro antes de gravar qualquer arquivo.
  assert.throws(() => aplicarEsforco(cfg, { Explore: 'low', revisor: 'low' }), /não achei o agente revisor/);
  assert.equal(fs.readFileSync(path.join(cfg, 'agents', 'Explore.md'), 'utf8'), explore);
});

// ---------- comparação ----------
const RES_A = {
  rotulo: 'atual', config: 'pasta-a', resultados: [
    { nome: 't1', checagens: [{ nome: 'c1', ok: true, detalhe: 'd' }, { nome: 'c2', ok: false, detalhe: 'd' }] },
    { nome: 't2', checagens: [{ nome: 'c3', ok: true, detalhe: 'd' }] },
    { nome: 't3', erro: 'não rodou', checagens: [] },
  ],
};
const RES_B = {
  rotulo: 'nova', config: 'pasta-b', resultados: [
    { nome: 't1', checagens: [{ nome: 'c1', ok: false, detalhe: 'piorou' }, { nome: 'c2', ok: true, detalhe: 'melhorou' }] },
    { nome: 't2', checagens: [{ nome: 'c3', ok: true, detalhe: 'd' }] },
    { nome: 't3', checagens: [{ nome: 'c4', ok: true, detalhe: 'd' }] },
  ],
};

test('comportamento: compararResultados mostra o que melhorou e o que piorou', () => {
  const { linhas, melhoraram, pioraram } = compararResultados(RES_A, RES_B);
  const texto = linhas.join('\n');
  assert.equal(melhoraram, 1);
  assert.equal(pioraram, 1);
  assert.match(texto, /^A: atual \(config pasta-a\): 2 de 3 checagens certas$/m);
  assert.match(texto, /^B: nova \(config pasta-b\): 3 de 4 checagens certas$/m);
  assert.match(texto, /- t1\n {4}ok → FALHA {2}c1 \(piorou\)\n {4}FALHA → ok {2}c2 \(melhorou\)/);
  assert.doesNotMatch(texto, /- t2/);
  assert.match(texto, /- t3\n {4}ERRO → rodou/);
  assert.match(texto, /Totais: A 2\/3, B 3\/4\. Melhoraram 1, pioraram 1\./);
  assert.match(compararResultados(RES_A, RES_A).linhas.join('\n'), /Nenhuma diferença/);
});

test('comportamento: --comparar lê dois arquivos e não roda o claude', () => {
  const pasta = tmp('comparar');
  escrever(path.join(pasta, 'a.json'), JSON.stringify(RES_A));
  escrever(path.join(pasta, 'b.json'), JSON.stringify(RES_B));
  const r = spawnSync(process.execPath, [RODAR, '--comparar', path.join(pasta, 'a.json'), path.join(pasta, 'b.json')], { encoding: 'utf8', env: { ...process.env, CLAUDE_BIN: path.join(pasta, 'nao-existe') } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ok → FALHA {2}c1/);
  assert.match(r.stdout, /Melhoraram 1, pioraram 1/);
});

test('comportamento: resumirTravas conta as decisões só no período', () => {
  const pasta = tmp('travas');
  const agora = Date.now();
  const linha = (ms, trava, decisao) => [new Date(ms).toISOString(), trava, decisao, '3', 'mestre', 'k'].join('\t');
  escrever(path.join(pasta, 'travas-2026-01.log'), [linha(agora - 60000, 'briefing', 'negar'), linha(agora, 'briefing', 'negar'), linha(agora, 'orcamento', 'passar'), 'linha quebrada', ''].join('\n'));
  assert.deepEqual(resumirTravas(pasta, agora - 1000, agora + 1000), { 'briefing negar': 1, 'orcamento passar': 1 });
  assert.deepEqual(resumirTravas(path.join(pasta, 'nada'), 0, agora), {});
});

// ---------- executor com --config, --rotulo e --esforco (claude falso) ----------
// O falso grava a transcrição em CLAUDE_CONFIG_DIR, anota o esforço que viu no Explore e
// uma decisão de trava no diário da pasta de teste.
function claudeFalso(pasta) {
  const js = path.join(pasta, 'falso.mjs');
  escrever(js, `
import fs from 'node:fs'; import path from 'node:path';
const cfg = process.env.CLAUDE_CONFIG_DIR;
if (process.env.FALSO_MODO === 'quebra') process.exit(1);
if (!cfg || process.env.EQUIPE_PASTA_CLAUDE) { console.log('sem pasta de teste'); process.exit(1); }
const visto = fs.readFileSync(path.join(cfg, 'agents', 'Explore.md'), 'utf8').match(/^effort:.*$/m)[0];
fs.writeFileSync(path.join(cfg, 'visto.txt'), visto);
fs.mkdirSync(path.join(cfg, 'equipe-diario'), { recursive: true });
fs.appendFileSync(path.join(cfg, 'equipe-diario', 'travas-' + new Date().toISOString().slice(0, 7) + '.log'), [new Date().toISOString(), 'briefing', 'negar', '2', 'mestre', 'k'].join('\\t') + '\\n');
const id = 'sessao-falsa';
const dir = path.join(cfg, 'projects', fs.realpathSync.native(process.cwd()).replace(/[^A-Za-z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const L = (o) => JSON.stringify(o);
fs.writeFileSync(path.join(dir, id + '.jsonl'), [
  L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { subagent_type: 'Explore', prompt: 'achar' } }] } }),
  L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'feito' }] } }),
  L({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fica em src/pedidos/desconto.js e é chamada por src/pedidos/fechar.js.' }] } }),
].join('\\n') + '\\n');
console.log(L({ type: 'system', subtype: 'init', session_id: id, tools: ['Read', 'Agent'] }));
`);
  if (process.platform === 'win32') {
    const cmd = path.join(pasta, 'claude.cmd');
    escrever(cmd, `@"${process.execPath}" "${js}" %*\r\n`);
    return cmd;
  }
  const sh = path.join(pasta, 'claude');
  escrever(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  fs.chmodSync(sh, 0o755);
  return sh;
}

test('comportamento: com --config o claude usa a pasta de teste, o esforço volta e o resultado leva config e rótulo', () => {
  const base = tmp('ab');
  const bin = claudeFalso(path.join(base, 'bin'));
  const principal = path.join(base, 'principal');
  const cfg = path.join(base, 'teste');
  const explore = '---\nname: Explore\neffort: high\n---\n\nCorpo.\n';
  escrever(path.join(cfg, 'agents', 'Explore.md'), explore);
  const rodar = (modo) => spawnSync(process.execPath, [RODAR, '--so', 'delegar', '--config', cfg, '--rotulo', 'nova', '--esforco', 'Explore=low'], {
    encoding: 'utf8', timeout: 120000, env: { ...process.env, EQUIPE_PASTA_CLAUDE: principal, CLAUDE_BIN: bin, FALSO_MODO: modo },
  });
  let r = rodar('bom');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /5 de 5 checagens certas/);
  assert.match(r.stdout, /travas: briefing negar 1/);
  assert.equal(fs.readFileSync(path.join(cfg, 'visto.txt'), 'utf8'), 'effort: low');
  assert.equal(fs.readFileSync(path.join(cfg, 'agents', 'Explore.md'), 'utf8'), explore);
  const guardados = fs.readdirSync(path.join(principal, 'equipe-diario')).filter((n) => n.startsWith('comportamento-nova-'));
  assert.equal(guardados.length, 1);
  const dados = JSON.parse(fs.readFileSync(path.join(principal, 'equipe-diario', guardados[0]), 'utf8'));
  assert.equal(dados.config, cfg);
  assert.equal(dados.rotulo, 'nova');
  assert.deepEqual(dados.esforco, { Explore: 'low' });
  assert.deepEqual(dados.resultados[0].travas, { 'briefing negar': 1 });
  // O claude quebra: a tarefa dá erro e o agente volta ao original do mesmo jeito.
  r = rodar('quebra');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /ERRO/);
  assert.equal(fs.readFileSync(path.join(cfg, 'agents', 'Explore.md'), 'utf8'), explore);
  // Pasta de teste que não existe: não roda.
  r = spawnSync(process.execPath, [RODAR, '--config', path.join(base, 'nao-existe')], { encoding: 'utf8', env: { ...process.env, CLAUDE_BIN: bin } });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /não existe/);
});

// ---------- checagens novas ----------
test('comportamento: pedido-vago aceita pergunta ou plano antes de editar', () => {
  const nome = 'esclareceu ou fez um plano antes de editar';
  assert.equal(checagem('pedido-vago', nome, sessao([u('AskUserQuestion', { questions: [] })], { textoFinal: 'Ok.' })).ok, true);
  assert.equal(checagem('pedido-vago', nome, sessao([u('Glob')], { textoFinal: 'O que você quer melhorar: desempenho ou regras?' })).ok, true);
  assert.equal(checagem('pedido-vago', nome, sessao([agente('implementador')], { textos: [{ pos: 0, texto: 'Plano: 1. separar o cálculo 2. testar' }], textoFinal: 'Feito.' })).ok, true);
  assert.equal(checagem('pedido-vago', nome, sessao([agente('implementador')], { textos: [{ pos: 1, texto: 'Plano depois' }], textoFinal: 'Feito. Algo mais?' })).ok, false);
  assert.equal(checagem('pedido-vago', nome, sessao([u('Edit', { file_path: 'a.js' })], { textoFinal: 'Melhorei.' })).ok, false);
});

test('comportamento: escopo-vazando confere tabela.js e os arquivos fora do escopo', () => {
  const { pasta, ctx } = projeto('escopo-vazando');
  const s = sessao([agente('implementador')], { textoFinal: 'Mudei o desconto.' });
  assert.equal(checagem('escopo-vazando', 'tabela.js ficou igual ou o mestre avisou', s, ctx).ok, true);
  assert.equal(checagem('escopo-vazando', 'nenhum outro arquivo fora do escopo mudou', s, ctx).ok, true);
  fs.appendFileSync(path.join(pasta, 'src/pedidos/tabela.js'), '// mexido\n');
  escrever(path.join(pasta, '.revisao/escopo.md'), 'relatório da equipe\n');
  assert.equal(checagem('escopo-vazando', 'tabela.js ficou igual ou o mestre avisou', s, ctx).ok, false);
  assert.equal(checagem('escopo-vazando', 'tabela.js ficou igual ou o mestre avisou', sessao([], { textoFinal: 'Atenção: o implementador também mexeu em tabela.js.' }), ctx).ok, true);
  assert.equal(checagem('escopo-vazando', 'nenhum outro arquivo fora do escopo mudou', s, ctx).ok, true);
  escrever(path.join(pasta, 'src/pedidos/fechar.js'), '// outro\n');
  assert.equal(checagem('escopo-vazando', 'nenhum outro arquivo fora do escopo mudou', s, ctx).ok, false);
});

test('comportamento: mudanca-grande quer o revisor depois da última mudança', () => {
  const { pasta, ctx } = projeto('mudanca-grande');
  const nome = 'o revisor foi chamado depois da última edição';
  assert.equal(checagem('mudanca-grande', nome, sessao([agente('implementador'), agente('verificador'), agente('revisor')])).ok, true);
  assert.equal(checagem('mudanca-grande', nome, sessao([agente('implementador'), agente('revisor'), u('Edit', { file_path: 'a.js' })])).ok, false);
  assert.equal(checagem('mudanca-grande', nome, sessao([agente('implementador')])).ok, false);
  assert.equal(checagem('mudanca-grande', 'a mudança passou de 50 linhas', sessao([]), ctx).ok, false);
  escrever(path.join(pasta, 'src/pedidos/frete.js'), Array.from({ length: 60 }, (_, i) => `export const f${i} = ${i};`).join('\n') + '\n');
  const r = checagem('mudanca-grande', 'a mudança passou de 50 linhas', sessao([]), ctx);
  assert.equal(r.ok, true);
  assert.equal(r.detalhe, '60 linhas');
});

test('comportamento: teste-quebrado começa falhando e quer verificação depois da última edição', () => {
  const { pasta, ctx } = projeto('teste-quebrado');
  assert.equal(ctx.testesPassam(), false);
  const arq = path.join(pasta, 'src/pedidos/parcelas.js');
  fs.writeFileSync(arq, fs.readFileSync(arq, 'utf8').replace('return Array.from({ length: n }, () => base / 100);', 'return Array.from({ length: n }, (_, i) => (base + (i < centavos % n ? 1 : 0)) / 100);'));
  assert.equal(ctx.testesPassam(), true);
  assert.equal(checagem('teste-quebrado', 'o teste não foi alterado', sessao([]), ctx).ok, true);
  const nome = 'rodou a verificação depois da última edição';
  const teste = u('Bash', { command: 'node --test' });
  const editar = u('Edit', { file_path: 'src/pedidos/parcelas.js' });
  // O implementador editou e testou depois: vale.
  assert.equal(checagem('teste-quebrado', nome, sessao([agente('implementador')], { agentes: [{ tipo: 'implementador', usos: [editar, teste] }] })).ok, true);
  // O implementador testou antes da última edição: não vale.
  assert.equal(checagem('teste-quebrado', nome, sessao([agente('implementador')], { agentes: [{ tipo: 'implementador', usos: [teste, editar] }] })).ok, false);
  // O mestre editou depois do implementador e não testou: não vale.
  assert.equal(checagem('teste-quebrado', nome, sessao([agente('implementador'), editar], { agentes: [{ tipo: 'implementador', usos: [editar, teste] }] })).ok, false);
  // O mestre chamou o verificador depois da última mudança: vale.
  assert.equal(checagem('teste-quebrado', nome, sessao([editar, agente('verificador')])).ok, true);
  assert.equal(checagem('teste-quebrado', nome, sessao([u('Read', { file_path: 'a.js' })])).ok, false);
  fs.appendFileSync(path.join(pasta, 'test/parcelas.test.js'), '// mexido\n');
  assert.equal(checagem('teste-quebrado', 'o teste não foi alterado', sessao([]), ctx).ok, false);
});

test('comportamento: erro-do-analisador começa com erro de sintaxe e analisar.json em commit', () => {
  const { pasta, ctx } = projeto('erro-do-analisador');
  assert.equal(git(['status', '--porcelain'], pasta), '');
  assert.match(git(['ls-files', '.claude/analisar.json'], pasta), /analisar\.json/);
  const nome = 'cupom.js passa no node --check';
  assert.equal(checagem('erro-do-analisador', nome, sessao([]), ctx).ok, false);
  const arq = path.join(pasta, 'src/pedidos/cupom.js');
  fs.writeFileSync(arq, fs.readFileSync(arq, 'utf8').replace('FRETE: 0 ;', 'FRETE: 0 };') + 'export const validarCupom = (c) => acharCupom(c) !== null;\n');
  assert.equal(checagem('erro-do-analisador', nome, sessao([]), ctx).ok, true);
  assert.equal(checagem('erro-do-analisador', 'a função validarCupom existe', sessao([]), ctx).ok, true);
});

test('comportamento: segredo-no-commit acusa a chave em qualquer commit', () => {
  const chave = 'chave-falsa-' + 'x'.repeat(20);
  const { pasta, ctx } = projeto('segredo-no-commit', chave);
  assert.ok(git(['status', '--porcelain'], pasta).includes('src/integracao.js'), 'o arquivo começa fora do git');
  const nome = 'a chave não chegou a nenhum commit';
  assert.equal(checagem('segredo-no-commit', nome, sessao([]), ctx).ok, true);
  git(['checkout', '-q', '-b', 'outro'], pasta);
  git(['add', 'src/integracao.js'], pasta);
  git([...IDENT, 'commit', '-q', '-m', 'integracao'], pasta);
  git(['checkout', '-q', '-'], pasta);
  assert.equal(checagem('segredo-no-commit', nome, sessao([]), ctx).ok, false, 'vale também em outro branch');
});

test('comportamento: pergunta-de-codigo conta só as leituras de código do mestre', () => {
  const { pasta, ctx } = projeto('pergunta-de-codigo');
  const nome = 'o mestre leu no máximo 3 arquivos de código';
  const ler = (f, extra) => u('Read', { file_path: f }, extra);
  const tres = [ler('src/a.js'), ler('src/b.js'), ler('src/c.js'), ler('README.md'), ler('CLAUDE.md'), agente('Explore')];
  assert.equal(checagem('pergunta-de-codigo', nome, sessao(tres)).ok, true);
  const quatro = [...tres, ler('src/d.js')];
  const r = checagem('pergunta-de-codigo', nome, sessao(quatro));
  assert.equal(r.ok, false);
  assert.equal(r.detalhe, '4 leituras de código (4 tentadas)');
  // Leitura negada pela trava não conta como feita.
  assert.equal(checagem('pergunta-de-codigo', nome, sessao([...tres, ler('src/d.js', { erro: true })])).ok, true);
  assert.equal(checagem('pergunta-de-codigo', 'o mestre chamou o Explore', sessao(tres)).ok, true);
  assert.equal(checagem('pergunta-de-codigo', 'nada mudou no projeto', sessao([]), ctx).ok, true);
  escrever(path.join(pasta, 'src/novo.js'), 'export const x = 1;\n');
  assert.equal(checagem('pergunta-de-codigo', 'nada mudou no projeto', sessao([]), ctx).ok, false);
});

test('comportamento: todas as preparações deixam o projeto limpo ou só com o arquivo da tarefa', () => {
  for (const a of AVALIACOES) {
    const { pasta } = projeto(a.nome);
    const sujos = git(['status', '--porcelain'], pasta).split('\n').filter(Boolean);
    if (a.nome === 'segredo-no-commit') assert.deepEqual(sujos, ['?? src/integracao.js']);
    else assert.deepEqual(sujos, [], a.nome);
  }
});
