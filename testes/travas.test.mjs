// Testes das travas da equipe que rodam pelos despachantes (equipe-pre.mjs, equipe-pos.mjs
// e equipe-eventos.mjs): registro, interruptor, mapa primeiro, orçamento do mestre,
// briefing, analisador, verificação antes da entrega, escopo e revisão obrigatória.
//   node --test testes/travas.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOKS = fileURLToPath(new URL('../hooks/', import.meta.url));
const PRE = path.join(HOOKS, 'equipe-pre.mjs');
const POS = path.join(HOOKS, 'equipe-pos.mjs');
const EVENTOS = path.join(HOOKS, 'equipe-eventos.mjs');

const tmp = (nome) => fs.mkdtempSync(path.join(os.tmpdir(), `equipe-${nome}-`));
const escrever = (arquivo, texto) => {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, texto);
};
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@exemplo.com', '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// Pasta do Claude falsa e sem .claude.json do usuário (o mapa só vale se o projeto declarar).
function ambiente(extra = {}) {
  const claude = tmp('claude');
  return { claude, env: { EQUIPE_SEM_REDE: '1', EQUIPE_PASTA_CLAUDE: claude, CLAUDE_CONFIG_DIR: claude, CLAUDE_PROJECT_DIR: '', EQUIPE_DESLIGAR: '', ...extra } };
}

function rodar(script, entrada, env) {
  const saida = execFileSync(process.execPath, [script], {
    input: typeof entrada === 'string' ? entrada : JSON.stringify(entrada),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return saida.trim() ? JSON.parse(saida) : null;
}
const decisao = (s) => (s && s.hookSpecificOutput ? s.hookSpecificOutput.permissionDecision : null);
const motivo = (s) => (s && s.hookSpecificOutput ? s.hookSpecificOutput.permissionDecisionReason : '');
const contexto = (s) => (s && s.hookSpecificOutput ? s.hookSpecificOutput.additionalContext || '' : '');

function registro(claude) {
  const pasta = path.join(claude, 'equipe-diario');
  let linhas = [];
  for (const n of fs.existsSync(pasta) ? fs.readdirSync(pasta) : []) {
    if (/^travas-\d{4}-\d{2}\.log$/.test(n)) linhas = linhas.concat(fs.readFileSync(path.join(pasta, n), 'utf8').split('\n').filter(Boolean));
  }
  return linhas.map((l) => l.split('\t'));
}

// Projeto médio (60 arquivos de código), com o mapa declarado e a lista do verificador.
function projeto({ grande = true, mapa = true } = {}) {
  const raiz = tmp('proj');
  git(raiz, 'init', '-q');
  const n = grande ? 60 : 3;
  for (let i = 0; i < n; i++) escrever(path.join(raiz, 'lib', `a${i}.dart`), `// ${i}\nvoid f${i}() {}\n`);
  escrever(path.join(raiz, 'README.md'), '# app\n');
  escrever(path.join(raiz, 'pubspec.yaml'), 'name: app\n');
  escrever(path.join(raiz, '.claude', 'verificador-comandos.txt'), 'flutter test\nflutter analyze\n');
  if (mapa) escrever(path.join(raiz, '.mcp.json'), JSON.stringify({ mcpServers: { 'codebase-memory': { command: 'x' } } }));
  git(raiz, 'add', '-A');
  git(raiz, 'commit', '-q', '-m', 'inicio');
  return raiz;
}

// ---------- registro, interruptor e despachante ----------

test('despachante: cada decisão vai para o registro, sem conteúdo', () => {
  const { claude, env } = ambiente();
  const raiz = projeto();
  const s = rodar(PRE, { hook_event_name: 'PreToolUse', session_id: 's1', cwd: raiz, tool_name: 'Bash', tool_input: { command: 'supabase db push' } }, env);
  assert.equal(decisao(s), 'ask');
  rodar(PRE, { hook_event_name: 'PreToolUse', session_id: 's1', cwd: raiz, tool_name: 'Bash', tool_input: { command: 'git status' } }, env);
  const r = registro(claude);
  assert.ok(r.some((l) => l[1] === 'banco' && l[2] === 'pediu' && l[4] === 'mestre' && l[5] === 's1-mestre'));
  assert.ok(r.some((l) => l[1] === 'pre' && l[2] === 'passou' && Number(l[3]) >= 0));
  assert.ok(r.every((l) => l.length === 6));
  assert.ok(!fs.readFileSync(path.join(claude, 'equipe-diario', fs.readdirSync(path.join(claude, 'equipe-diario')).find((n) => n.startsWith('travas-'))), 'utf8').includes('supabase'));
  // Entrada quebrada: calado.
  assert.equal(rodar(PRE, '{quebrado', env), null);
});

test('despachante: barrar vence pedir aprovação', () => {
  const { env } = ambiente();
  const raiz = projeto();
  const chave = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ iss: 'supabase', role: 'service' + '_role' })).toString('base64url'), 'Q'.repeat(43)].join('.');
  escrever(path.join(raiz, 'lib', 'chave.dart'), `const k = '${chave}';\n`);
  git(raiz, 'add', 'lib/chave.dart');
  const s = rodar(PRE, { session_id: 's', cwd: raiz, tool_name: 'Bash', tool_input: { command: 'supabase db push && git commit -m x' } }, env);
  assert.equal(decisao(s), 'deny');
  assert.match(motivo(s), /service_role/);
  assert.ok(!motivo(s).includes(chave));
});

test('interruptor: EQUIPE_DESLIGAR desliga as de economia, nunca as de segurança', async () => {
  const comum = await import(new URL('../hooks/equipe-comum.mjs', import.meta.url).href);
  const antes = process.env.EQUIPE_DESLIGAR;
  process.env.EQUIPE_DESLIGAR = 'Mapa, orçamento';
  assert.equal(comum.desligada('mapa'), true);
  assert.equal(comum.desligada('orcamento'), true);
  assert.equal(comum.desligada('briefing'), false);
  process.env.EQUIPE_DESLIGAR = 'tudo';
  assert.equal(comum.desligada('revisao'), true);
  assert.equal(comum.desligada('segredos'), false);
  assert.equal(comum.desligada('banco'), false);
  process.env.EQUIPE_DESLIGAR = antes ?? '';
});

// ---------- mapa primeiro ----------

test('mapa primeiro: barra, consulta, libera; fuga na segunda tentativa; zera no fim', () => {
  const { claude, env } = ambiente();
  const raiz = projeto();
  const arq = path.join(raiz, 'lib', 'a1.dart');
  const ler = (agent_id, tool_name = 'Read', tool_input = { file_path: arq }, tipo = 'Explore') => rodar(PRE, { session_id: 'sm', agent_id, agent_type: tipo, cwd: raiz, tool_name, tool_input }, env);

  let s = ler('ag1');
  assert.equal(decisao(s), 'deny');
  assert.match(motivo(s), /index_status.*search_graph/s);
  // O agente consulta o mapa (deu certo) e a leitura passa.
  rodar(POS, { session_id: 'sm', agent_id: 'ag1', agent_type: 'Explore', cwd: raiz, tool_name: 'mcp__codebase-memory__search_graph', tool_input: {} }, env);
  assert.equal(ler('ag1'), null);
  // Outra chamada: Grep na pasta também espera o mapa; o que não é código passa.
  assert.equal(decisao(ler('ag2', 'Grep', { pattern: 'f1', path: path.join(raiz, 'lib') })), 'deny');
  assert.equal(ler('ag3', 'Read', { file_path: path.join(raiz, 'README.md') }), null);
  assert.equal(ler('ag3', 'Grep', { pattern: 'x', glob: '*.md' }), null);
  assert.equal(ler('ag3', 'Glob', { pattern: '**/*.yaml' }), null);
  assert.equal(decisao(ler('ag3', 'Glob', { pattern: 'lib/**/*.dart' })), 'deny');
  // Segunda tentativa passa: fuga do mapa, registrada.
  assert.equal(ler('ag3', 'Glob', { pattern: 'lib/**/*.dart' }), null);
  assert.ok(registro(claude).some((l) => l[1] === 'mapa' && l[2] === 'fuga' && l[4] === 'Explore'));
  // O revisor lendo o diff passa; o código, não.
  escrever(path.join(raiz, '.revisao', 'diff.patch'), 'diff\n');
  assert.equal(ler('rv1', 'Read', { file_path: path.join(raiz, '.revisao', 'diff.patch') }, 'revisor'), null);
  assert.equal(decisao(ler('rv1', 'Read', { file_path: arq }, 'revisor')), 'deny');
  // Fim da chamada: a marca zera (o agente retomado começa de novo).
  rodar(EVENTOS, { hook_event_name: 'SubagentStop', session_id: 'sm', agent_id: 'ag1', agent_type: 'Explore', cwd: raiz }, env);
  assert.equal(decisao(ler('ag1')), 'deny');
  // Arquivo inexistente, mestre e verificador: fora da trava.
  assert.equal(ler('ag9', 'Read', { file_path: path.join(raiz, 'lib', 'nao.dart') }), null);
  assert.equal(ler('v1', 'Read', { file_path: arq }, 'verificador'), null);
});

test('mapa primeiro: projeto pequeno ou sem o mapa instalado passa', () => {
  const { env } = ambiente();
  for (const raiz of [projeto({ grande: false }), projeto({ mapa: false })]) {
    const s = rodar(PRE, { session_id: 'sp', agent_id: 'a', agent_type: 'Explore', cwd: raiz, tool_name: 'Read', tool_input: { file_path: path.join(raiz, 'lib', 'a1.dart') } }, env);
    assert.equal(s, null);
  }
  // Desligada pelo interruptor.
  const raiz = projeto();
  const s = rodar(PRE, { session_id: 'sp', agent_id: 'b', agent_type: 'Explore', cwd: raiz, tool_name: 'Read', tool_input: { file_path: path.join(raiz, 'lib', 'a1.dart') } }, { ...env, EQUIPE_DESLIGAR: 'mapa' });
  assert.equal(s, null);
});

test('Explore: leitura por trecho e teto continuam pelo despachante', () => {
  const { env } = ambiente({ EQUIPE_EXPLORE_LEITURAS: '2' });
  const raiz = projeto({ mapa: false });
  const grande = path.join(raiz, 'lib', 'grande.dart');
  escrever(grande, 'x\n'.repeat(400));
  const ler = (f, extra = {}) => rodar(PRE, { session_id: 'st', agent_id: 'e1', agent_type: 'Explore', cwd: raiz, tool_name: 'Read', tool_input: { file_path: f, ...extra } }, env);
  assert.match(motivo(ler(grande)), /mais de 300 linhas/);
  assert.equal(ler(grande, { offset: 1, limit: 50 }), null);
  assert.equal(ler(path.join(raiz, 'lib', 'a1.dart')), null);
  assert.match(motivo(ler(path.join(raiz, 'lib', 'a2.dart'))), /Teto de 2/);
  // O mestre não tem teto de Explore.
  const m = rodar(PRE, { session_id: 'st', cwd: raiz, tool_name: 'Read', tool_input: { file_path: grande } }, env);
  assert.equal(m, null);
});

// ---------- orçamento do mestre ----------

test('orçamento do mestre: 3 arquivos de código por pedido; reler passa; pedido novo zera', () => {
  const { claude, env } = ambiente();
  const raiz = projeto();
  const ler = (i) => rodar(PRE, { session_id: 'so', cwd: raiz, tool_name: 'Read', tool_input: { file_path: path.join(raiz, 'lib', `a${i}.dart`) } }, env);
  const pedido = (prompt) => rodar(EVENTOS, { hook_event_name: 'UserPromptSubmit', session_id: 'so', cwd: raiz, prompt }, env);
  pedido('arrume o botão');
  assert.equal(ler(1), null);
  assert.equal(ler(2), null);
  assert.equal(ler(3), null);
  assert.equal(ler(1), null); // reler o mesmo não conta
  const s = ler(4);
  assert.equal(decisao(s), 'deny');
  assert.match(motivo(s), /delegue ao Explore/);
  assert.ok(registro(claude).some((l) => l[1] === 'orcamento' && l[2] === 'barrou'));
  // Não código e CLAUDE.md não contam.
  assert.equal(rodar(PRE, { session_id: 'so', cwd: raiz, tool_name: 'Read', tool_input: { file_path: path.join(raiz, 'README.md') } }, env), null);
  // Pedido novo zera; "leia você mesmo" libera.
  pedido('outra coisa');
  assert.equal(ler(4), null);
  pedido('Leia você mesmo os arquivos e me diga');
  for (let i = 5; i < 10; i++) assert.equal(ler(i), null);
  // Subagente não entra no orçamento do mestre.
  pedido('mais uma');
  for (let i = 10; i < 15; i++) assert.equal(rodar(PRE, { session_id: 'so', agent_id: 'i1', agent_type: 'implementador', cwd: raiz, tool_name: 'Read', tool_input: { file_path: path.join(raiz, 'lib', `a${i}.dart`) } }, env), null);
});

test('orçamento do mestre: projeto pequeno fica livre', () => {
  const { env } = ambiente();
  const raiz = projeto({ grande: false });
  for (let i = 0; i < 3; i++) escrever(path.join(raiz, 'lib', `b${i}.dart`), '//\n');
  for (const n of ['a0', 'a1', 'a2', 'b0', 'b1']) {
    assert.equal(rodar(PRE, { session_id: 'sq', cwd: raiz, tool_name: 'Read', tool_input: { file_path: path.join(raiz, 'lib', `${n}.dart`) } }, env), null);
  }
});

// ---------- briefing ----------

test('briefing: implementador precisa de objetivo, escopo com caminho, critério e verificação', () => {
  const { claude, env } = ambiente();
  const raiz = projeto();
  const agente = (subagent_type, prompt, extra = {}) => rodar(PRE, { session_id: 'sb', cwd: raiz, tool_name: 'Agent', tool_input: { subagent_type, prompt, description: 'x' }, ...extra }, env);
  let s = agente('implementador', 'Arrume o botão de login.');
  assert.equal(decisao(s), 'deny');
  assert.match(motivo(s), /Objetivo: <uma frase/);
  assert.match(motivo(s), /flutter test/);
  const bom = [
    '**Objetivo:** corrigir o botão de login que não responde.',
    '**Contexto:** lib/a1.dart:2 chama f1.',
    '**Escopo:** só `lib/a1.dart` e test/a1_test.dart. Fora do escopo: o resto.',
    '**Critérios de aceite:** o teste novo passa.',
    '**Como verificar:** `flutter test test/a1_test.dart`',
  ].join('\n');
  assert.equal(agente('implementador', bom), null);
  // Escopo sem caminho e verificação fora da lista: barra.
  s = agente('implementador', bom.replace('só `lib/a1.dart` e test/a1_test.dart.', 'a tela de login.').replace('flutter test test/a1_test.dart', 'rodar algo'));
  assert.match(motivo(s), /caminho de arquivo ou pasta/);
  assert.match(motivo(s), /Como verificar/);
  // "nenhum" com motivo vale.
  assert.equal(agente('implementador', bom.replace('`flutter test test/a1_test.dart`', 'nenhum, só texto de README')), null);
  // Válvula: o mesmo briefing de novo passa e fica registrado.
  assert.equal(agente('implementador', 'Arrume o botão de login.'), null);
  assert.ok(registro(claude).some((l) => l[1] === 'briefing' && l[2] === 'valvula'));
});

test('briefing: verificador, revisor e Explore; outros agentes e subagentes ficam de fora', () => {
  const { env } = ambiente();
  const raiz = projeto();
  const agente = (subagent_type, prompt, extra = {}) => rodar(PRE, { session_id: 'sv', cwd: raiz, tool_name: 'Agent', tool_input: { subagent_type, prompt }, ...extra }, env);
  assert.equal(decisao(agente('verificador', 'Rode os testes do app.')), 'deny');
  assert.equal(agente('verificador', 'Rode: flutter test\nDevolva as falhas.'), null);
  assert.match(motivo(agente('revisor', 'Revise a mudança do login.')), /caminho do diff/);
  assert.match(motivo(agente('revisor', 'Diff: .revisao/diff.patch')), /não foi encontrado/);
  escrever(path.join(raiz, '.revisao', 'diff.patch'), 'diff\n');
  assert.equal(agente('revisor', 'Diff: .revisao/diff.patch. Objetivo: login.'), null);
  assert.equal(decisao(agente('Explore', 'procure o login')), 'deny');
  assert.equal(agente('Explore', 'Onde o app valida a senha no login? Comece por lib/ e use o mapa do código. Devolva caminho:linha.'), null);
  assert.equal(agente('general-purpose', 'x'), null);
  assert.equal(agente('implementador', 'x', { agent_id: 'sub', agent_type: 'Plan' }), null);
});

// ---------- analisador depois da edição ----------

// Um analisador falso com nome de analisador conhecido (ruff), numa pasta posta no PATH.
function ruffFalso() {
  const bin = tmp('bin');
  const script = path.join(bin, 'ruff-falso.mjs');
  escrever(script, "import fs from 'node:fs';\nconst arq = process.argv[process.argv.length - 1];\nconst t = fs.readFileSync(arq, 'utf8');\nif (t.includes('ERRO')) { console.log(arq + ':1:1: E999 nome indefinido'); process.exit(1); }\n");
  if (process.platform === 'win32') escrever(path.join(bin, 'ruff.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
  else {
    escrever(path.join(bin, 'ruff'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    fs.chmodSync(path.join(bin, 'ruff'), 0o755);
  }
  return bin;
}

test('analisador: devolve os erros do arquivo editado; limpo ou sem analisador, calado', () => {
  const bin = ruffFalso();
  const { claude, env } = ambiente({ PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  const raiz = projeto({ mapa: false });
  const config = (cmd) => escrever(path.join(raiz, '.claude', 'analisar.json'), JSON.stringify({ '.dart': cmd }));
  config(['ruff', 'check', '{arquivo}']);
  git(raiz, 'add', '-A');
  git(raiz, 'commit', '-q', '-m', 'analisador');
  const arq = path.join(raiz, 'lib', 'a1.dart');
  const editar = (texto, tipo) => {
    fs.writeFileSync(arq, texto);
    return rodar(POS, { session_id: 'sa', agent_id: tipo ? 'i1' : undefined, agent_type: tipo, cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  };
  const s = editar('void f() { ERRO; }\n', 'implementador');
  assert.match(contexto(s), /Analisador da equipe.*a1\.dart: há erro/s);
  assert.match(contexto(s), /nome indefinido/);
  assert.ok(registro(claude).some((l) => l[1] === 'analisar' && l[2] === 'avisou'));
  assert.equal(editar('void f() {}\n'), null);
  // Configuração fora de commit não vale.
  config(['ruff', 'check', '--fix', '{arquivo}']);
  assert.equal(editar('void f() { ERRO; }\n'), null);
  // Programa que não é analisador conhecido, ou por caminho, não roda nem em commit.
  for (const cmd of [[process.execPath, path.join(bin, 'ruff-falso.mjs'), '{arquivo}'], ['sh', '-c', 'echo ERRO; exit 1'], [path.join(bin, 'ruff'), 'check', '{arquivo}'], ['node', path.join(bin, 'ruff-falso.mjs'), '{arquivo}']]) {
    config(cmd);
    git(raiz, 'add', '-A');
    git(raiz, 'commit', '-q', '-m', 'outro');
    assert.equal(editar('void f() { ERRO; }\n'), null, JSON.stringify(cmd));
  }
});

// ---------- verificação antes da entrega e escopo ----------

function transcricaoComBriefing(claude, texto) {
  const arq = path.join(claude, 'projects', '-p', 'sessao', 'subagents', `agent-${Math.random().toString(16).slice(2)}.jsonl`);
  escrever(arq, `${JSON.stringify({ type: 'user', message: { role: 'user', content: texto } })}\n`);
  return arq;
}

test('implementador: barra uma vez a entrega sem verificação; com teste depois, passa', () => {
  const { claude, env } = ambiente();
  const raiz = projeto({ mapa: false });
  const base = { session_id: 'si', agent_type: 'implementador', cwd: raiz };
  const arq = path.join(raiz, 'lib', 'a1.dart');
  rodar(EVENTOS, { ...base, agent_id: 'i1', hook_event_name: 'SubagentStart' }, env);
  fs.appendFileSync(arq, '// mudou\n');
  rodar(POS, { ...base, agent_id: 'i1', tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  const fim = (agent_id, extra = {}) => rodar(EVENTOS, { ...base, agent_id, hook_event_name: 'SubagentStop', ...extra }, env);
  let s = fim('i1');
  assert.equal(s.decision, 'block');
  assert.match(s.reason, /Rode a verificação antes de entregar/);
  s = fim('i1', { stop_hook_active: true });
  assert.equal(s, null);
  assert.ok(registro(claude).some((l) => l[1] === 'verificar' && l[2] === 'entregou-sem-verificar'));

  // Outro: edita, roda o teste, entrega.
  rodar(EVENTOS, { ...base, agent_id: 'i2', hook_event_name: 'SubagentStart' }, env);
  rodar(POS, { ...base, agent_id: 'i2', tool_name: 'Write', tool_input: { file_path: arq } }, env);
  rodar(POS, { ...base, agent_id: 'i2', tool_name: 'Bash', tool_input: { command: 'flutter test test/a1_test.dart' } }, env);
  assert.equal(fim('i2'), null);
  // Editar só texto (não código) não exige teste.
  rodar(POS, { ...base, agent_id: 'i3', tool_name: 'Edit', tool_input: { file_path: path.join(raiz, 'README.md') } }, env);
  assert.equal(fim('i3'), null);
});

test('escopo: lista o que mudou e o que ficou fora do escopo do briefing', () => {
  const { claude, env } = ambiente();
  const raiz = projeto({ mapa: false });
  // O usuário já tinha uma mudança antes do implementador: não é dele.
  fs.appendFileSync(path.join(raiz, 'lib', 'a9.dart'), '// do usuário\n');
  const base = { session_id: 'se', agent_type: 'implementador', agent_id: 'i1', cwd: raiz };
  rodar(EVENTOS, { ...base, hook_event_name: 'SubagentStart' }, env);
  const editar = (rel, texto) => {
    const arq = path.join(raiz, rel);
    if (fs.existsSync(arq)) fs.appendFileSync(arq, texto); else escrever(arq, texto);
    rodar(POS, { ...base, tool_name: fs.existsSync(arq) ? 'Edit' : 'Write', tool_input: { file_path: arq } }, env);
  };
  editar('lib/a1.dart', '// no escopo\n');
  editar('lib/a2.dart', '// fora\n');
  editar('lib/novo/b.dart', '// novo no escopo\n');
  // Outro agente (em paralelo) mexe noutro arquivo durante a tarefa: não é fuga deste.
  fs.appendFileSync(path.join(raiz, 'lib', 'a3.dart'), '// de outro agente\n');
  rodar(POS, { ...base, tool_name: 'Bash', tool_input: { command: 'flutter test' } }, env);
  // Escopo com caminho absoluto (e barras invertidas, como no Windows) também vale.
  const absoluto = path.join(raiz, 'lib', 'a1.dart').replace(/\//g, '\\');
  const transcricao = transcricaoComBriefing(claude, `Objetivo: x\nEscopo: \`${absoluto}\` e a pasta lib/novo/. Fora do escopo: lib/a2.dart\nCritério de aceite: y`);
  assert.equal(rodar(EVENTOS, { ...base, hook_event_name: 'SubagentStop', agent_transcript_path: transcricao }, env), null);
  const md = fs.readFileSync(path.join(raiz, '.revisao', 'escopo.md'), 'utf8');
  assert.match(md, /implementador editou \(3\): lib\/a1\.dart, lib\/a2\.dart, lib\/novo\/b\.dart/);
  assert.match(md, /Outras mudanças na pasta durante a tarefa \(1\).*lib\/a3\.dart/);
  assert.match(md, /FORA DO ESCOPO \(1\): lib\/a2\.dart\./);
  assert.ok(!md.includes('a9.dart'));
  assert.equal(fs.readFileSync(path.join(raiz, '.revisao', '.gitignore'), 'utf8'), '*\n');
  // O mestre recebe a lista junto com o relatório (primeiro plano), uma vez.
  const agente = { session_id: 'se', cwd: raiz, tool_name: 'Agent', tool_input: { subagent_type: 'implementador', prompt: 'x' } };
  assert.match(contexto(rodar(POS, agente, env)), /FORA DO ESCOPO/);
  assert.equal(rodar(POS, agente, env), null);
});

// ---------- revisão obrigatória ----------

test('revisão: mudança grande sem revisor barra o fim uma vez; depois do revisor, passa', () => {
  const { claude, env } = ambiente();
  const raiz = projeto({ mapa: false });
  const arq = path.join(raiz, 'lib', 'a1.dart');
  const pedido = (prompt) => rodar(EVENTOS, { hook_event_name: 'UserPromptSubmit', session_id: 'sr', cwd: raiz, prompt }, env);
  const editar = (texto) => {
    fs.appendFileSync(arq, texto);
    rodar(POS, { session_id: 'sr', cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  };
  const fim = (extra = {}) => rodar(EVENTOS, { hook_event_name: 'Stop', session_id: 'sr', cwd: raiz, ...extra }, env);
  pedido('faça a tela nova');
  editar('// pouco\n');
  assert.equal(fim(), null); // 1 linha: dispensa
  editar('// linha\n'.repeat(60));
  let s = fim();
  assert.equal(s.decision, 'block');
  assert.match(s.reason, /chame o revisor antes de concluir \(61 linhas/);
  assert.equal(fim({ stop_hook_active: true }), null);
  assert.ok(registro(claude).some((l) => l[1] === 'revisao' && l[2] === 'concluiu-sem-revisao'));
  // O revisor roda: a mudança fica revisada; um ajuste pequeno depois não pede outra.
  rodar(EVENTOS, { hook_event_name: 'SubagentStop', session_id: 'sr', agent_id: 'r1', agent_type: 'revisor', cwd: raiz }, env);
  assert.equal(fim(), null);
  editar('// ajuste\n');
  assert.equal(fim(), null);
  // "sem revisão" no pedido dispensa, e as mesmas linhas não voltam a cobrar depois.
  pedido('pode concluir sem revisão');
  editar('// mais\n'.repeat(80));
  assert.equal(fim(), null);
  pedido('qual o nome do arquivo principal?');
  assert.equal(fim(), null);
  // Concluiu sem revisão depois de cobrado: a cobrança não se repete nas respostas seguintes.
  pedido('mais uma tela');
  editar('// tela\n'.repeat(70));
  assert.equal(fim().decision, 'block');
  assert.equal(fim({ stop_hook_active: true }), null);
  pedido('e agora?');
  assert.equal(fim(), null);
  // Arquivo ignorado pelo git (um .env, por exemplo) não conta linhas.
  escrever(path.join(raiz, '.gitignore'), '.env.local\n');
  git(raiz, 'add', '.gitignore');
  git(raiz, 'commit', '-q', '-m', 'ignora');
  escrever(path.join(raiz, '.env.local'), 'A=1\n'.repeat(200));
  rodar(POS, { session_id: 'sr', cwd: raiz, tool_name: 'Write', tool_input: { file_path: path.join(raiz, '.env.local') } }, env);
  assert.equal(fim(), null);
});

test('revisão: área sensível (padrão e do CLAUDE.md) pede revisor mesmo em mudança pequena', () => {
  const { env } = ambiente();
  const raiz = projeto({ mapa: false });
  escrever(path.join(raiz, 'CLAUDE.md'), '# P\n\n## Regras deste projeto\n\n- Áreas sensíveis além das globais: `lib/a5.dart`, `scripts/`.\n');
  escrever(path.join(raiz, 'supabase', 'migrations', '001.sql'), 'select 1;\n');
  git(raiz, 'add', '-A');
  git(raiz, 'commit', '-q', '-m', 'mais');
  const caso = (sessao, rel) => {
    const arq = path.join(raiz, rel);
    fs.appendFileSync(arq, '-- x\n');
    rodar(POS, { session_id: sessao, cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
    return rodar(EVENTOS, { hook_event_name: 'Stop', session_id: sessao, cwd: raiz }, env);
  };
  assert.match(caso('s1', 'supabase/migrations/001.sql').reason, /área sensível: supabase\/migrations\/001\.sql.*model opus/);
  assert.match(caso('s2', 'lib/a5.dart').reason, /área sensível: lib\/a5\.dart/);
  assert.equal(caso('s3', 'lib/a6.dart'), null);
});

test('despachante: EQUIPE_DESLIGAR=leitura desliga a leitura por trecho e o teto do Explore', () => {
  const { env } = ambiente({ EQUIPE_DESLIGAR: 'leitura', EQUIPE_EXPLORE_LEITURAS: '1' });
  const raiz = projeto({ mapa: false });
  const grande = path.join(raiz, 'lib', 'grande.dart');
  escrever(grande, 'x\n'.repeat(400));
  for (let i = 0; i < 3; i++) assert.equal(rodar(PRE, { session_id: 'sd', agent_id: 'e', agent_type: 'Explore', cwd: raiz, tool_name: 'Read', tool_input: { file_path: grande } }, env), null);
  // As de segurança continuam valendo com tudo desligado.
  const s = rodar(PRE, { session_id: 'sd', cwd: raiz, tool_name: 'Bash', tool_input: { command: 'supabase db push' } }, { ...env, EQUIPE_DESLIGAR: 'tudo' });
  assert.equal(decisao(s), 'ask');
});

test('implementador: teste que falhou (PostToolUseFailure) conta como verificação feita', () => {
  const { env } = ambiente();
  const raiz = projeto({ mapa: false });
  const base = { session_id: 'sf', agent_type: 'implementador', agent_id: 'i1', cwd: raiz };
  const arq = path.join(raiz, 'lib', 'a1.dart');
  fs.appendFileSync(arq, '// mudou\n');
  rodar(POS, { ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  rodar(POS, { ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'flutter test' } }, env);
  assert.equal(rodar(EVENTOS, { ...base, hook_event_name: 'SubagentStop' }, env), null);
});

test('fim de subagente sem o tipo do agente não mexe no estado do mestre', () => {
  const { env } = ambiente();
  const raiz = projeto();
  const ler = (i) => rodar(PRE, { session_id: 'sg', cwd: raiz, tool_name: 'Read', tool_input: { file_path: path.join(raiz, 'lib', `a${i}.dart`) } }, env);
  rodar(EVENTOS, { hook_event_name: 'UserPromptSubmit', session_id: 'sg', cwd: raiz, prompt: 'arrume' }, env);
  for (let i = 1; i <= 3; i++) ler(i);
  rodar(EVENTOS, { hook_event_name: 'SubagentStop', session_id: 'sg', cwd: raiz }, env);
  assert.equal(decisao(ler(4)), 'deny');
});

test('caminhos do briefing: letra do drive, barra invertida e espaço entre crases', async () => {
  const { caminhos } = await import(new URL('../hooks/equipe-briefing.mjs', import.meta.url).href);
  const c = caminhos('Escopo: `C:\\Users\\Nome Composto\\app\\lib\\a.dart` e D:\\proj\\lib\\b.dart, mais lib/c.dart.');
  assert.ok(c.includes('C:/Users/Nome Composto/app/lib/a.dart'), JSON.stringify(c));
  assert.ok(c.includes('D:/proj/lib/b.dart'), JSON.stringify(c));
  assert.ok(c.includes('lib/c.dart'), JSON.stringify(c));
});

test('revisão: área sensível pelo nome, sem pegar tela de login ou cartão de sessão', async () => {
  const { ehSensivel } = await import(new URL('../hooks/equipe-entrega.mjs', import.meta.url).href);
  for (const a of ['lib/auth/x.dart', 'lib/services/auth_service.dart', 'supabase/migrations/1.sql', '.github/workflows/ci.yml', 'infra/main.tf', 'lib/payments/pix.dart']) assert.ok(ehSensivel(a, []), a);
  for (const a of ['lib/login_screen.dart', 'lib/session_card.dart', 'lib/author.dart', 'lib/home.dart']) assert.ok(!ehSensivel(a, []), a);
  assert.ok(ehSensivel('scripts/deploy.sh', ['scripts/']));
});

test('despachante: módulo de trava quebrado não derruba as de segurança', () => {
  const { env } = ambiente();
  const raiz = projeto({ mapa: false });
  const copia = tmp('hooks');
  for (const n of fs.readdirSync(HOOKS)) if (n.endsWith('.mjs')) fs.copyFileSync(path.join(HOOKS, n), path.join(copia, n));
  fs.writeFileSync(path.join(copia, 'equipe-mapa.mjs'), 'export const x = ;\n'); // erro de sintaxe
  const s = rodar(path.join(copia, 'equipe-pre.mjs'), { session_id: 'sk', cwd: raiz, tool_name: 'Bash', tool_input: { command: 'supabase db push' } }, env);
  assert.equal(decisao(s), 'ask');
});
