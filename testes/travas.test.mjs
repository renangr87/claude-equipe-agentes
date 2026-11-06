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
  // Sem ter tentado o mapa, a segunda tentativa é barrada de novo; a terceira passa, registrada.
  assert.match(motivo(ler('ag3', 'Glob', { pattern: 'lib/**/*.dart' })), /o mapa ainda não foi consultado/);
  assert.equal(ler('ag3', 'Glob', { pattern: 'lib/**/*.dart' }), null);
  assert.ok(registro(claude).some((l) => l[1] === 'mapa' && l[2] === 'fuga-sem-tentar' && l[4] === 'Explore'));
  // O mapa foi tentado e deu erro: a segunda tentativa passa, como fuga.
  assert.equal(decisao(ler('ag4', 'Read', { file_path: arq })), 'deny');
  rodar(POS, { hook_event_name: 'PostToolUseFailure', session_id: 'sm', agent_id: 'ag4', agent_type: 'Explore', cwd: raiz, tool_name: 'mcp__codebase-memory__search_graph', tool_input: {} }, env);
  assert.equal(ler('ag4', 'Read', { file_path: arq }), null);
  assert.ok(registro(claude).some((l) => l[1] === 'mapa' && l[2] === 'fuga' && l[4] === 'Explore'));
  // O revisor lendo o diff passa; o código fora da mudança, não; o arquivo que a sessão mudou, sim.
  escrever(path.join(raiz, '.revisao', 'diff.patch'), 'diff\n');
  assert.equal(ler('rv1', 'Read', { file_path: path.join(raiz, '.revisao', 'diff.patch') }, 'revisor'), null);
  assert.equal(decisao(ler('rv1', 'Read', { file_path: arq }, 'revisor')), 'deny');
  const mudado = path.join(raiz, 'lib', 'a2.dart');
  fs.appendFileSync(mudado, '// mudou\n');
  rodar(POS, { session_id: 'sm', cwd: raiz, tool_name: 'Edit', tool_input: { file_path: mudado } }, env);
  assert.equal(ler('rv2', 'Read', { file_path: mudado }, 'revisor'), null);
  assert.equal(decisao(ler('rv2', 'Read', { file_path: arq }, 'revisor')), 'deny');
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

test('orçamento do mestre: limite de linhas por pedido; reler passa; pedido novo zera', () => {
  // Arquivos de 2 linhas e um limite de 6: três arquivos passam, o quarto não.
  const { claude, env } = ambiente({ EQUIPE_MESTRE_LINHAS: '6' });
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
  // O agente genérico sem modelo passa a rodar em sonnet; com modelo pedido, fica como está.
  // Só a troca, sem "allow": as regras de permissão do usuário continuam valendo.
  const g = agente('general-purpose', 'x');
  assert.ok(!('permissionDecision' in g.hookSpecificOutput));
  assert.equal(g.hookSpecificOutput.updatedInput.model, 'sonnet');
  assert.equal(g.hookSpecificOutput.updatedInput.prompt, 'x');
  assert.equal(rodar(PRE, { session_id: 'sv', cwd: raiz, tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', prompt: 'x', model: 'opus' } }, env), null);
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
  const { claude, env } = ambiente({ EQUIPE_DESLIGAR: 'prova' });
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
  assert.match(s.reason, /chame o revisor \(o da equipe ou o do projeto\) antes de concluir \(61 linhas/);
  assert.equal(fim({ stop_hook_active: true }), null);
  assert.ok(registro(claude).some((l) => l[1] === 'revisao' && l[2] === 'concluiu-sem-revisao'));
  // O revisor roda: a mudança fica revisada; um ajuste pequeno depois não pede outra.
  rodar(EVENTOS, { hook_event_name: 'SubagentStop', session_id: 'sr', agent_id: 'r1', agent_type: 'revisor', cwd: raiz, last_assistant_message: 'Veredito: APROVADO' }, env);
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
  const { env } = ambiente({ EQUIPE_DESLIGAR: 'prova' });
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
  const { env } = ambiente({ EQUIPE_MESTRE_LINHAS: '6' });
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

test('escopo e revisão: projeto aberto por um atalho de pasta (como o nome curto no Windows)', () => {
  const { claude, env } = ambiente();
  const real = projeto({ mapa: false });
  const atalho = path.join(tmp('atalho'), 'proj');
  fs.symlinkSync(real, atalho, process.platform === 'win32' ? 'junction' : 'dir');
  const base = { session_id: 'sl', agent_type: 'implementador', agent_id: 'i1', cwd: atalho };
  rodar(EVENTOS, { ...base, hook_event_name: 'SubagentStart' }, env);
  const arq = path.join(atalho, 'lib', 'a1.dart');
  fs.appendFileSync(arq, '// linha\n'.repeat(60));
  rodar(POS, { ...base, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  rodar(POS, { ...base, tool_name: 'Bash', tool_input: { command: 'flutter test' } }, env);
  const transcricao = transcricaoComBriefing(claude, 'Objetivo: x\nEscopo: lib/a1.dart\nCritério de aceite: y');
  assert.equal(rodar(EVENTOS, { ...base, hook_event_name: 'SubagentStop', agent_transcript_path: transcricao }, env), null);
  const md = fs.readFileSync(path.join(real, '.revisao', 'escopo.md'), 'utf8');
  assert.match(md, /implementador editou \(1\): lib\/a1\.dart/);
  assert.match(md, /dentro do escopo/);
  // A revisão obrigatória também reconhece o arquivo pelo atalho.
  const s = rodar(EVENTOS, { hook_event_name: 'Stop', session_id: 'sl', cwd: atalho }, env);
  assert.equal(s && s.decision, 'block');
});

// ---------- convergência: a mesma falha voltou ----------

test('convergência: a mesma falha depois de duas tentativas avisa o mestre e barra a tentativa igual', () => {
  const { claude, env } = ambiente();
  const raiz = projeto({ mapa: false });
  const sessao = 'sc';
  let n = 0;
  // O verificador roda os comandos (o hook anota o resultado) e depois entrega o relatório.
  const fimVerificador = (relatorio, comandos = []) => {
    const id = `v${++n}`;
    for (const [comando, ok] of comandos) rodar(POS, { hook_event_name: ok ? 'PostToolUse' : 'PostToolUseFailure', session_id: sessao, agent_id: id, agent_type: 'verificador', cwd: raiz, tool_name: 'Bash', tool_input: { command: comando } }, env);
    return rodar(EVENTOS, { hook_event_name: 'SubagentStop', session_id: sessao, agent_id: id, agent_type: 'verificador', cwd: raiz, last_assistant_message: relatorio }, env);
  };
  const fimImplementador = () => rodar(EVENTOS, { hook_event_name: 'SubagentStop', session_id: sessao, agent_id: `i${++n}`, agent_type: 'implementador', cwd: raiz }, env);
  const depoisDoVerificador = () => rodar(POS, { session_id: sessao, cwd: raiz, tool_name: 'Agent', tool_input: { subagent_type: 'verificador', prompt: 'Rode: flutter test' } }, env);
  const implementador = (prompt, extra = {}) => rodar(PRE, { session_id: sessao, cwd: raiz, tool_name: 'Agent', tool_input: { subagent_type: 'implementador', prompt, ...extra } }, env);
  const falha = 'flutter test: falhou (1 de 12).\n- cupom reduz o total, test/cupom_test.dart:12: esperado 90, apareceu 100.';
  const vermelho = [['flutter test', false]];
  const bom = 'Objetivo: corrigir o cupom.\nEscopo: lib/cupom.dart e test/cupom_test.dart.\nCritério de aceite: o teste passa.\nComo verificar: flutter test test/cupom_test.dart';

  // A verificação que reproduz o bug, antes de qualquer tentativa, não conta.
  fimVerificador(falha, vermelho);
  fimImplementador();
  fimVerificador(falha, vermelho);
  assert.equal(depoisDoVerificador(), null, 'uma tentativa só: nada a dizer');
  assert.equal(implementador(bom), null);
  // Segunda tentativa com a mesma falha (noutra linha: a correção mudou o arquivo).
  fimImplementador();
  fimVerificador(falha.replace('(1 de 12)', '(1 de 12, de novo)').replace(':12:', ':15:'), vermelho);
  assert.match(contexto(depoisDoVerificador()), /mesma falha voltou depois de 2 tentativas do implementador \(test\/cupom_test\.dart\)/);
  assert.equal(depoisDoVerificador(), null, 'o aviso sai uma vez');
  let s = implementador(bom);
  assert.equal(decisao(s), 'deny');
  assert.match(motivo(s), /Já tentado.*model: opus/s);
  // Válvula só para o mesmo briefing; outro briefing igual na abordagem é barrado também.
  assert.equal(implementador(bom), null);
  assert.ok(registro(claude).some((l) => l[1] === 'convergencia' && l[2] === 'valvula'));
  assert.equal(decisao(implementador(`${bom}\nContexto: tente de novo.`)), 'deny');
  // "Já tentado" vazio não é abordagem nova.
  assert.equal(decisao(implementador(`${bom}\nJá tentado: -`)), 'deny');
  // Com outra abordagem registrada (título e lista numerada), com opus, ou noutra tarefa: segue.
  assert.equal(implementador(`${bom}\n\n## Já tentado\n1. trocar a ordem do desconto: o total continuou 100`), null);
  assert.equal(implementador(bom, { model: 'opus' }), null);
  assert.equal(implementador('Objetivo: tela de perfil.\nEscopo: lib/perfil.dart.\nCritério de aceite: abre.\nComo verificar: flutter test'), null);
  // "Passou" só no texto, ou só o lint verde, não zera: o teste que falhou continua aberto.
  fimVerificador('flutter test: passou (12 de 12).');
  fimVerificador('flutter analyze: sem problemas.', [['flutter analyze', true]]);
  assert.equal(decisao(implementador(`${bom}\nContexto: depois do lint.`)), 'deny');
  // O mesmo comando passou sem filtro: zera; a mesma falha num episódio novo volta a ser cobrada.
  fimVerificador('flutter test: passou (12 de 12).', [['flutter test', true]]);
  assert.equal(implementador(`${bom}\nContexto: depois do verde.`), null);
  fimImplementador();
  fimVerificador(falha, vermelho);
  fimImplementador();
  fimVerificador(falha, vermelho);
  assert.match(contexto(depoisDoVerificador()), /depois de 2 tentativas/);
  assert.equal(decisao(implementador(bom)), 'deny');
});

test('convergência: três tentativas com a mesma falha param o implementador até o usuário falar', () => {
  const { env } = ambiente();
  const raiz = projeto({ mapa: false });
  const sessao = 'sp';
  let n = 0;
  const fimVerificador = (relatorio) => {
    const id = `v${++n}`;
    rodar(POS, { hook_event_name: 'PostToolUseFailure', session_id: sessao, agent_id: id, agent_type: 'verificador', cwd: raiz, tool_name: 'Bash', tool_input: { command: 'flutter test' } }, env);
    return rodar(EVENTOS, { hook_event_name: 'SubagentStop', session_id: sessao, agent_id: id, agent_type: 'verificador', cwd: raiz, last_assistant_message: relatorio }, env);
  };
  const fimImplementador = (escopo) => rodar(EVENTOS, { hook_event_name: 'SubagentStop', session_id: sessao, agent_id: `i${++n}`, agent_type: 'implementador', cwd: raiz, agent_transcript_path: transcricaoComBriefing(env.EQUIPE_PASTA_CLAUDE, `Objetivo: x\nEscopo: ${escopo}\nCritério de aceite: y`) }, env);
  const implementador = (prompt, extra = {}) => rodar(PRE, { session_id: sessao, cwd: raiz, tool_name: 'Agent', tool_input: { subagent_type: 'implementador', prompt, ...extra } }, env);
  const brief = (k) => `Objetivo: corrigir o cupom, tentativa ${k}.\nEscopo: lib/cupom.dart.\nCritério de aceite: passa.\nComo verificar: flutter test\n\n## Já tentado\n- a abordagem anterior, que não resolveu o desconto (${k})`;
  rodar(EVENTOS, { hook_event_name: 'UserPromptSubmit', session_id: sessao, cwd: raiz, prompt: 'faça a, b e c, e corrija o cupom' }, env);
  // Tarefas diferentes, cada uma com a sua falha: não somam.
  for (const t of ['a', 'b', 'c']) { fimImplementador(`lib/${t}.dart`); fimVerificador(`Falhou: test/${t}_test.dart:1`); }
  assert.equal(implementador(brief(0)), null, 'três tarefas diferentes vermelhas: segue');
  // A mesma falha (noutra linha a cada vez) em três tentativas que mexeram nela: para.
  for (const k of [1, 2]) { fimImplementador('lib/cupom.dart'); fimVerificador(`Falhou: test/cupom_test.dart:${10 + k}`); }
  assert.equal(implementador(brief(3)), null, 'duas tentativas, com "Já tentado": ainda segue');
  fimImplementador('lib/cupom.dart');
  fimVerificador('Falhou: test/cupom_test.dart:15');
  const s = implementador(brief(4), { model: 'opus' });
  assert.equal(decisao(s), 'deny');
  assert.match(motivo(s), /3 tentativas do implementador terminaram com a mesma falha.*Pare aqui e explique ao usuário/s);
  assert.equal(decisao(implementador(brief(4), { model: 'opus' })), 'deny', 'sem válvula');
  // O fim da resposta não cobra revisão nem teste: o mestre foi mandado parar e explicar.
  const arq = path.join(raiz, 'lib', 'a1.dart');
  fs.appendFileSync(arq, '// x\n'.repeat(80));
  rodar(POS, { session_id: sessao, cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  assert.equal(rodar(EVENTOS, { hook_event_name: 'Stop', session_id: sessao, cwd: raiz }, env), null);
  // A próxima mensagem do usuário tira a parada, e a conta recomeça.
  rodar(EVENTOS, { hook_event_name: 'UserPromptSubmit', session_id: sessao, cwd: raiz, prompt: 'tente mais uma vez, olhando o fuso' }, env);
  assert.equal(implementador(brief(5)), null);
});

test('convergência: falha só anterior à mudança (teste legado vermelho) não conta', () => {
  const { env } = ambiente();
  const raiz = projeto({ mapa: false });
  const sessao = 'sl2';
  let n = 0;
  const legado = 'flutter test: falhou (1 de 40).\n- Falhas que parecem anteriores à mudança:\n  - test/legado_test.dart:9 (já falhava)';
  for (let k = 0; k < 4; k++) {
    rodar(EVENTOS, { hook_event_name: 'SubagentStop', session_id: sessao, agent_id: `i${++n}`, agent_type: 'implementador', cwd: raiz }, env);
    const id = `v${++n}`;
    rodar(POS, { hook_event_name: 'PostToolUseFailure', session_id: sessao, agent_id: id, agent_type: 'verificador', cwd: raiz, tool_name: 'Bash', tool_input: { command: 'flutter test' } }, env);
    rodar(EVENTOS, { hook_event_name: 'SubagentStop', session_id: sessao, agent_id: id, agent_type: 'verificador', cwd: raiz, last_assistant_message: legado }, env);
  }
  const s = rodar(PRE, { session_id: sessao, cwd: raiz, tool_name: 'Agent', tool_input: { subagent_type: 'implementador', prompt: 'Objetivo: x.\nEscopo: lib/legado.dart.\nCritério de aceite: y.\nComo verificar: flutter test' } }, env);
  assert.equal(s, null);
  assert.equal(rodar(POS, { session_id: sessao, cwd: raiz, tool_name: 'Bash', tool_input: { command: 'git status' } }, env), null, 'sem aviso de falha repetida');
});

test('convergência: o implementador recebe a falha aberta ao começar', () => {
  const { env } = ambiente();
  const raiz = projeto({ mapa: false });
  const inicio = () => rodar(EVENTOS, { hook_event_name: 'SubagentStart', session_id: 'sa', agent_id: 'i9', agent_type: 'implementador', cwd: raiz }, env);
  assert.equal(inicio(), null, 'sem falha aberta: nada');
  rodar(EVENTOS, { hook_event_name: 'SubagentStop', session_id: 'sa', agent_id: 'v1', agent_type: 'verificador', cwd: raiz, last_assistant_message: 'flutter test: falhou (1 de 9).\n- total com cupom, test/cupom_test.dart:12: esperado 90, apareceu 100.\n- Falhas anteriores à mudança:\n  - test/velho_test.dart:3' }, env);
  const s = inicio();
  assert.equal(s.hookSpecificOutput.hookEventName, 'SubagentStart');
  assert.match(s.hookSpecificOutput.additionalContext, /test\/cupom_test\.dart:12: esperado 90, apareceu 100/);
  assert.ok(!s.hookSpecificOutput.additionalContext.includes('velho_test'));
});

test('convergência: relatório aprovado, falha anterior à mudança e aviso do analisador não contam', async () => {
  const { assinaturaDaFalha } = await import(new URL('../hooks/equipe-convergencia.mjs', import.meta.url).href);
  const { statusDoRelatorio } = await import(new URL('../hooks/equipe-comum.mjs', import.meta.url).href);
  assert.equal(statusDoRelatorio('verificador', 'flutter analyze: 0 erros, 0 falhas; info em lib/a.dart:3'), 'passou');
  assert.equal(statusDoRelatorio('verificador', 'Nenhuma falha. Teste novo test/x_test.dart:12 passou.'), 'passou');
  assert.equal(assinaturaDaFalha('Falhou (2):\n- total, test/a_test.dart:5: esperado 1, apareceu 2\n- Falhas que parecem anteriores à mudança:\n  - test/velho_test.dart:9 (já falhava)\n- info - lib/b.dart:3 - prefer const'), 'test/a_test.dart');
  assert.equal(assinaturaDaFalha('FAILED src\\Pedidos\\Cupom.ts:7 e test/x.test.ts:20'), 'src/pedidos/cupom.ts test/x.test.ts');
  // A linha não entra: a própria correção a muda, e a falha é a mesma.
  assert.equal(assinaturaDaFalha('Falhou: test/a_test.dart:12'), assinaturaDaFalha('Falhou: test/a_test.dart:15'));
  assert.equal(assinaturaDaFalha('Falhou, mas sem dizer onde.'), null);
});

test('convergência: lê o relatório entregue pelo SubagentHandback antes da última mensagem', () => {
  const { claude, env } = ambiente();
  const raiz = projeto({ mapa: false });
  const transcricao = path.join(claude, 'projects', '-p', 'sh', 'subagents', 'agent-v.jsonl');
  const entrega = (texto) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'SubagentHandback', input: { message: texto } }] } });
  escrever(transcricao, `${entrega('Falhou: lib/a1.dart:3 erro de tipo.')}\n`);
  const fim = (id, tipo, extra = {}) => rodar(EVENTOS, { hook_event_name: 'SubagentStop', session_id: 'sh', agent_id: id, agent_type: tipo, cwd: raiz, ...extra }, env);
  for (const id of ['1', '2']) {
    fim(`i${id}`, 'implementador');
    fim(`v${id}`, 'verificador', { agent_transcript_path: transcricao, last_assistant_message: 'Entregando o relatório.' });
  }
  const s = rodar(PRE, { session_id: 'sh', cwd: raiz, tool_name: 'Agent', tool_input: { subagent_type: 'implementador', prompt: 'Objetivo: x.\nEscopo: lib/a1.dart.\nCritério de aceite: y.\nComo verificar: flutter analyze' } }, env);
  assert.equal(decisao(s), 'deny');
});

test('convergência: o briefing que usou a válvula da trava do briefing não é barrado de novo', () => {
  const { env } = ambiente();
  const raiz = projeto({ mapa: false });
  const fim = (id, tipo, msg) => rodar(EVENTOS, { hook_event_name: 'SubagentStop', session_id: 'sv2', agent_id: id, agent_type: tipo, cwd: raiz, last_assistant_message: msg }, env);
  for (const id of ['1', '2']) { fim(`i${id}`, 'implementador'); fim(`v${id}`, 'verificador', 'Falhou: lib/a1.dart:3'); }
  const incompleto = 'Arrume lib/a1.dart de novo.';
  const chamar = () => rodar(PRE, { session_id: 'sv2', cwd: raiz, tool_name: 'Agent', tool_input: { subagent_type: 'implementador', prompt: incompleto } }, env);
  assert.match(motivo(chamar()), /Briefing barrado/);
  assert.equal(chamar(), null, 'a segunda vez é a válvula do briefing: passa');
});

// ---------- revisão pelo custo de desfazer ----------

test('revisão: texto e documentação não pedem revisor; manifesto de dependências pede', () => {
  const { env } = ambiente();
  const raiz = projeto({ mapa: false });
  escrever(path.join(raiz, 'package.json'), '{\n  "name": "app"\n}\n');
  git(raiz, 'add', '-A');
  git(raiz, 'commit', '-q', '-m', 'pacote');
  const caso = (sessao, rel, texto) => {
    const arq = path.join(raiz, rel);
    fs.appendFileSync(arq, texto);
    rodar(POS, { session_id: sessao, cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
    return rodar(EVENTOS, { hook_event_name: 'Stop', session_id: sessao, cwd: raiz }, env);
  };
  assert.equal(caso('d1', 'README.md', 'linha de texto\n'.repeat(200)), null);
  assert.match(caso('d2', 'package.json', '  \n'.repeat(60)).reason, /6\d linhas mudadas sem revisão/);
});

test('boletim: o plano lembra o que já foi tentado', () => {
  const { env } = ambiente();
  const raiz = projeto({ mapa: false });
  escrever(path.join(raiz, '.revisao', 'plano.md'), '# Plano\n\n- [x] passo 1\n- [ ] passo 2\n\n## Já tentado\n\n- trocar a ordem do desconto: o total continuou errado\n- arredondar no fim: quebrou o teste do frete\n');
  const saida = execFileSync(process.execPath, [path.join(HOOKS, 'equipe-boletim.mjs')], { input: JSON.stringify({ cwd: raiz, source: 'resume' }), encoding: 'utf8', env: { ...process.env, ...env } });
  assert.match(JSON.parse(saida).hookSpecificOutput.additionalContext, /"Já tentado" tem 2 item\(ns\): não repita/);
});

test('revisão: teste volta com um clique; schema e tela contam', () => {
  const { env } = ambiente({ EQUIPE_DESLIGAR: 'prova' });
  const raiz = projeto({ mapa: false });
  escrever(path.join(raiz, 'prisma', 'schema.prisma'), 'model A {}\n');
  escrever(path.join(raiz, 'web', 'index.html'), '<p></p>\n');
  escrever(path.join(raiz, 'test', 'a_test.dart'), '//\n');
  git(raiz, 'add', '-A');
  git(raiz, 'commit', '-q', '-m', 'mais');
  const caso = (sessao, rel) => {
    const arq = path.join(raiz, rel);
    fs.appendFileSync(arq, 'x\n'.repeat(80));
    rodar(POS, { session_id: sessao, cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
    return rodar(EVENTOS, { hook_event_name: 'Stop', session_id: sessao, cwd: raiz }, env);
  };
  assert.equal(caso('t1', 'test/a_test.dart'), null);
  assert.equal(caso('t2', 'prisma/schema.prisma').decision, 'block');
  assert.equal(caso('t3', 'web/index.html').decision, 'block');
});

test('revisão: commit depois da revisão não conta como mudança nova; edição depois, sim', () => {
  const { env } = ambiente({ EQUIPE_DESLIGAR: 'prova' });
  const raiz = projeto({ mapa: false });
  const sessao = 'rc';
  const arq = path.join(raiz, 'supabase', 'migrations', '20260101_nova.sql');
  escrever(arq, 'create table t (id int);\n'.repeat(55));
  rodar(POS, { session_id: sessao, cwd: raiz, tool_name: 'Write', tool_input: { file_path: arq } }, env);
  const fim = () => rodar(EVENTOS, { hook_event_name: 'Stop', session_id: sessao, cwd: raiz }, env);
  assert.equal(fim().decision, 'block');
  rodar(EVENTOS, { hook_event_name: 'SubagentStop', session_id: sessao, agent_id: 'r1', agent_type: 'revisor', cwd: raiz, last_assistant_message: '- **Veredito**: APROVADO COM RESSALVAS' }, env);
  assert.equal(fim(), null);
  git(raiz, 'add', '--', 'supabase/migrations/20260101_nova.sql');
  git(raiz, 'commit', '-q', '-m', 'migração revisada');
  assert.equal(fim(), null, 'só o commit: nada novo');
  fs.appendFileSync(arq, 'alter table t add column x int;\n');
  rodar(POS, { session_id: sessao, cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  assert.match(fim().reason, /área sensível: supabase\/migrations\/20260101_nova\.sql/);
});

test('briefing do revisor: sessão numa pasta fora do repositório acha o diff no repositório editado', () => {
  const { env } = ambiente();
  const raiz = projeto({ mapa: false });
  const solta = tmp('sessao-solta');
  const sessao = 'bs';
  // Como numa sessão de verdade: a pasta do projeto da sessão é a pasta solta.
  const revisor = (prompt) => rodar(PRE, { session_id: sessao, cwd: solta, tool_name: 'Agent', tool_input: { subagent_type: 'revisor', prompt } }, { ...env, CLAUDE_PROJECT_DIR: solta });
  // Sem repositório e sem edições na sessão: não dá para conferir, então não barra.
  assert.equal(revisor('Diff: .revisao/diff.patch. Objetivo: x.'), null);
  // A sessão editou o repositório: o diff relativo é procurado lá.
  const arq = path.join(raiz, 'lib', 'a1.dart');
  fs.appendFileSync(arq, '// x\n');
  rodar(POS, { session_id: sessao, cwd: solta, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  fs.mkdirSync(path.join(raiz, '.revisao'), { recursive: true });
  git(raiz, 'diff', 'HEAD', '--output=.revisao/diff.patch');
  assert.equal(revisor('Diff: .revisao/diff.patch. Objetivo: y.'), null);
  assert.match(motivo(revisor('Diff: .revisao/outro.patch. Objetivo: z.')), /não foi encontrado/);
});

test('revisão: o revisor próprio do projeto (plugin) também conta', () => {
  const { env } = ambiente({ EQUIPE_DESLIGAR: 'prova' });
  const raiz = projeto({ mapa: false });
  const arq = path.join(raiz, 'lib', 'a1.dart');
  fs.appendFileSync(arq, '// linha\n'.repeat(60));
  rodar(POS, { session_id: 'rp', cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  const fim = () => rodar(EVENTOS, { hook_event_name: 'Stop', session_id: 'rp', cwd: raiz }, env);
  assert.equal(fim().decision, 'block');
  rodar(EVENTOS, { hook_event_name: 'SubagentStop', session_id: 'rp', agent_id: 'x1', agent_type: 'meu-plugin:revisor-visual', cwd: raiz }, env);
  assert.equal(fim(), null);
});

test('interruptor por projeto: .claude/equipe.json desliga só naquele projeto', () => {
  const { env } = ambiente({ EQUIPE_MESTRE_LINHAS: '6' });
  const raiz = projeto();
  const ler = (cwdProj, i) => rodar(PRE, { session_id: `ip${cwdProj ? 1 : 2}`, cwd: raiz, tool_name: 'Read', tool_input: { file_path: path.join(raiz, 'lib', `a${i}.dart`) } }, { ...env, CLAUDE_PROJECT_DIR: cwdProj });
  escrever(path.join(raiz, '.claude', 'equipe.json'), JSON.stringify({ desligar: ['orcamento'] }));
  for (let i = 1; i <= 5; i++) assert.equal(ler(raiz, i), null);
  // Outro projeto (sem o arquivo): o orçamento vale.
  const outro = tmp('outro-proj');
  for (let i = 1; i <= 3; i++) ler(outro, i);
  assert.equal(decisao(ler(outro, 4)), 'deny');
  // As de segurança não desligam por ele.
  escrever(path.join(raiz, '.claude', 'equipe.json'), JSON.stringify({ desligar: 'tudo' }));
  const s = rodar(PRE, { session_id: 'ip3', cwd: raiz, tool_name: 'Bash', tool_input: { command: 'supabase db push' } }, { ...env, CLAUDE_PROJECT_DIR: raiz });
  assert.equal(decisao(s), 'ask');
});

// ---------- revisão: só a aprovação conta, e vale para o que o revisor viu ----------

test('revisão: revisor que reprova não libera; o fim cobra uma vez com os achados', () => {
  const { claude, env } = ambiente({ EQUIPE_DESLIGAR: 'prova' });
  const raiz = projeto({ mapa: false });
  const arq = path.join(raiz, 'lib', 'a1.dart');
  fs.appendFileSync(arq, '// linha\n'.repeat(60));
  rodar(POS, { session_id: 'rr', cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  const fim = (extra = {}) => rodar(EVENTOS, { hook_event_name: 'Stop', session_id: 'rr', cwd: raiz, ...extra }, env);
  const revisor = (id, tipo, msg) => rodar(EVENTOS, { hook_event_name: 'SubagentStop', session_id: 'rr', agent_id: id, agent_type: tipo, cwd: raiz, last_assistant_message: msg }, env);
  revisor('r1', 'revisor', '- **Veredito**: REPROVADO\n- **Achados**: crítico, 95, lib/a1.dart:3, a consulta junta texto do usuário no SQL.');
  let s = fim();
  assert.equal(s.decision, 'block');
  assert.match(s.reason, /o revisor reprovou a mudança \(.*a consulta junta texto do usuário/);
  assert.equal(fim({ stop_hook_active: true }), null);
  assert.ok(registro(claude).some((l) => l[1] === 'revisao' && l[2] === 'reprovou'));
  // Revisor da equipe sem veredito (bloqueado, faltou o diff) não conta como revisão.
  revisor('r2', 'revisor', 'Bloqueado: faltou o diff.');
  assert.ok(registro(claude).some((l) => l[1] === 'revisao' && l[2] === 'sem-veredito'));
  // Aprovado: passa.
  revisor('r3', 'revisor', 'Veredito: APROVADO');
  assert.equal(fim(), null);
  // Revisor de plugin que reprova do jeito dele também não libera.
  fs.appendFileSync(arq, '// mais\n'.repeat(60));
  rodar(POS, { session_id: 'rr', cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  revisor('p1', 'meu-plugin:revisor', 'Nota 4. Rejeitado: o texto não segue o roteiro.');
  assert.match(fim().reason, /o revisor reprovou/);
});

test('revisão: o que muda enquanto o revisor lê conta como mudança nova', () => {
  const { env } = ambiente({ EQUIPE_DESLIGAR: 'prova' });
  const raiz = projeto({ mapa: false });
  const a1 = path.join(raiz, 'lib', 'a1.dart');
  const a2 = path.join(raiz, 'lib', 'a2.dart');
  fs.appendFileSync(a1, '// linha\n'.repeat(60));
  rodar(POS, { session_id: 'rf', cwd: raiz, tool_name: 'Edit', tool_input: { file_path: a1 } }, env);
  const base = { session_id: 'rf', agent_id: 'r1', agent_type: 'revisor', cwd: raiz };
  rodar(EVENTOS, { ...base, hook_event_name: 'SubagentStart' }, env);
  // Durante a revisão, outra mudança grande.
  fs.appendFileSync(a2, '// outra\n'.repeat(60));
  rodar(POS, { session_id: 'rf', cwd: raiz, tool_name: 'Edit', tool_input: { file_path: a2 } }, env);
  rodar(EVENTOS, { ...base, hook_event_name: 'SubagentStop', last_assistant_message: 'Veredito: APROVADO' }, env);
  const s = rodar(EVENTOS, { hook_event_name: 'Stop', session_id: 'rf', cwd: raiz }, env);
  assert.match(s.reason, /60 linhas mudadas sem revisão/);
});

test('briefing do revisor: diff velho, diff que não cobre a mudança e área sensível sem opus', () => {
  const { claude, env } = ambiente();
  const raiz = projeto({ mapa: false });
  const sessao = 'bv';
  const editar = (rel, texto) => {
    const arq = path.join(raiz, rel);
    if (fs.existsSync(arq)) fs.appendFileSync(arq, texto); else escrever(arq, texto);
    rodar(POS, { session_id: sessao, cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  };
  const revisor = (prompt, extra = {}) => rodar(PRE, { session_id: sessao, cwd: raiz, tool_name: 'Agent', tool_input: { subagent_type: 'revisor', prompt, ...extra } }, env);
  const gravarDiff = () => { fs.mkdirSync(path.join(raiz, '.revisao'), { recursive: true }); git(raiz, 'diff', 'HEAD', '--output=.revisao/diff.patch'); };
  editar('lib/a1.dart', '// um\n');
  gravarDiff();
  assert.equal(revisor('Diff: .revisao/diff.patch. Objetivo: x.'), null);
  // Editou depois de gravar o diff: o diff está velho.
  editar('lib/a1.dart', '// dois\n');
  assert.match(motivo(revisor('Diff: .revisao/diff.patch. Objetivo: y.')), /diff\.patch está velho: lib\/a1\.dart/);
  gravarDiff();
  // Arquivo novo fora do git: não está no diff, precisa estar no briefing.
  editar('lib/novo.dart', 'void n() {}\n');
  assert.match(motivo(revisor('Diff: .revisao/diff.patch. Objetivo: z.')), /o diff não inclui lib\/novo\.dart/);
  assert.equal(revisor('Diff: .revisao/diff.patch. Arquivos novos: lib/novo.dart. Objetivo: z.'), null);
  // Área sensível pede opus.
  editar('lib/auth/sessao.dart', 'void s() {}\n');
  const p = 'Diff: .revisao/diff.patch. Arquivos novos: lib/novo.dart, lib/auth/sessao.dart. Objetivo: w.';
  assert.match(motivo(revisor(p)), /área sensível \(lib\/auth\/sessao\.dart\): chame o revisor com model: opus/);
  assert.equal(revisor(p, { model: 'opus' }), null);
  // Válvula: o mesmo briefing de novo passa e fica registrado.
  assert.equal(revisor(p), null);
  assert.ok(registro(claude).some((l) => l[1] === 'revisor' && l[2] === 'valvula'));
});

// ---------- o que a sessão mudou: também pelo terminal ----------

test('revisão: mudança feita pelo terminal conta; o que já estava mudado antes da sessão, não', () => {
  const { env } = ambiente({ EQUIPE_DESLIGAR: 'prova' });
  const raiz = projeto({ mapa: false });
  // O usuário já tinha uma mudança grande antes da sessão.
  fs.appendFileSync(path.join(raiz, 'lib', 'a9.dart'), '// do usuário\n'.repeat(80));
  rodar(EVENTOS, { hook_event_name: 'UserPromptSubmit', session_id: 'tb', cwd: raiz, prompt: 'arrume a tela' }, env);
  const fim = () => rodar(EVENTOS, { hook_event_name: 'Stop', session_id: 'tb', cwd: raiz }, env);
  assert.equal(fim(), null);
  // Um script (ou um agente sem as travas) escreve 70 linhas sem Edit/Write.
  escrever(path.join(raiz, 'lib', 'gerado_por_script.dart'), '// x\n'.repeat(70));
  assert.match(fim().reason, /7\d linhas mudadas sem revisão/);
  // Código gerado (build_runner) não conta.
  rodar(EVENTOS, { hook_event_name: 'UserPromptSubmit', session_id: 'tb2', cwd: raiz, prompt: 'gere os modelos' }, env);
  escrever(path.join(raiz, 'lib', 'modelo.g.dart'), '// gerado\n'.repeat(300));
  const s = rodar(EVENTOS, { hook_event_name: 'Stop', session_id: 'tb2', cwd: raiz }, env);
  assert.equal(s, null);
});

// ---------- prova: verificação verde com o código de agora ----------

test('prova: o fim barra uma vez sem verde; linha da lista sem filtro passando libera', () => {
  const { claude, env } = ambiente();
  const raiz = projeto({ mapa: false });
  const sessao = 'pv';
  const arq = path.join(raiz, 'lib', 'a1.dart');
  const pedido = (prompt) => rodar(EVENTOS, { hook_event_name: 'UserPromptSubmit', session_id: sessao, cwd: raiz, prompt }, env);
  const editar = () => { fs.appendFileSync(arq, `// ${Math.random()}\n`); rodar(POS, { session_id: sessao, cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env); };
  const rodou = (comando, ok, extra = {}) => rodar(POS, { hook_event_name: ok ? 'PostToolUse' : 'PostToolUseFailure', session_id: sessao, cwd: raiz, tool_name: 'Bash', tool_input: { command: comando }, ...extra }, env);
  const fim = (extra = {}) => rodar(EVENTOS, { hook_event_name: 'Stop', session_id: sessao, cwd: raiz, ...extra }, env);
  pedido('corrija o total');
  editar();
  let s = fim();
  assert.equal(s.decision, 'block');
  assert.match(s.reason, /nenhuma linha da lista rodou depois da última mudança.*flutter test/s);
  assert.equal(fim({ stop_hook_active: true }), null);
  assert.equal(fim(), null, 'a mesma versão do código não cobra de novo');
  // No mesmo pedido, código novo depois da cobrança não cobra de novo.
  editar();
  assert.equal(fim(), null, 'uma vez por pedido');
  // Pedido novo, código novo: só o filtro passou ("-t nada" passa sem rodar teste), e o lint.
  pedido('agora o frete');
  editar();
  rodou('flutter test --name nao_existe', true, { agent_type: 'verificador', agent_id: 'v1' });
  rodou('flutter analyze', true, { agent_type: 'verificador', agent_id: 'v1' });
  assert.match(fim().reason, /passou flutter analyze, mas nenhum teste rodou sem filtro/);
  // Pedido novo, código novo: a linha falhou.
  pedido('e o desconto');
  editar();
  rodou('flutter test', false, { agent_type: 'verificador', agent_id: 'v2' });
  assert.match(fim().reason, /falhou com o código de agora \(flutter test\)/);
  // Código novo: a linha passou sem filtro (qualquer agente, com o código de agora; "2>&1" não
  // muda o comando). Libera, e o commit depois não muda nada.
  pedido('mais um ajuste');
  editar();
  rodou('flutter test 2>&1', true, { agent_type: 'implementador', agent_id: 'i1' });
  assert.equal(fim(), null);
  git(raiz, 'add', '--', 'lib/a1.dart');
  git(raiz, 'commit', '-q', '-m', 'total');
  assert.equal(fim(), null);
  // Com pipe, o código de saída é o do último programa: não prova.
  pedido('outro ajuste');
  editar();
  rodou('flutter test | tail -5', true);
  assert.equal(fim().decision, 'block');
  assert.ok(registro(claude).some((l) => l[1] === 'prova' && l[2] === 'barrou'));
  // Saída que mostra falha, mesmo dada como certa, não é verde.
  pedido('de novo');
  editar();
  rodou('flutter test', true, { tool_response: { stdout: '00:02 +11 -1: Some tests failed.', stderr: '' } });
  assert.match(fim().reason, /falhou com o código de agora/);
});

test('prova: "sem testes" no pedido, projeto sem lista e só documentação não cobram', () => {
  const { env } = ambiente();
  const raiz = projeto({ mapa: false });
  const editar = (sessao, rel) => {
    const arq = path.join(raiz, rel);
    fs.appendFileSync(arq, '// x\n');
    rodar(POS, { session_id: sessao, cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
    return rodar(EVENTOS, { hook_event_name: 'Stop', session_id: sessao, cwd: raiz }, env);
  };
  rodar(EVENTOS, { hook_event_name: 'UserPromptSubmit', session_id: 'p1', cwd: raiz, prompt: 'ajuste o texto, sem rodar os testes' }, env);
  assert.equal(editar('p1', 'lib/a2.dart'), null);
  assert.equal(editar('p2', 'README.md'), null);
  const semLista = tmp('sem-lista');
  git(semLista, 'init', '-q');
  escrever(path.join(semLista, 'lib', 'a.dart'), 'void a() {}\n');
  git(semLista, 'add', '-A');
  git(semLista, 'commit', '-q', '-m', 'i');
  fs.appendFileSync(path.join(semLista, 'lib', 'a.dart'), '// x\n');
  rodar(POS, { session_id: 'p3', cwd: semLista, tool_name: 'Edit', tool_input: { file_path: path.join(semLista, 'lib', 'a.dart') } }, env);
  assert.equal(rodar(EVENTOS, { hook_event_name: 'Stop', session_id: 'p3', cwd: semLista }, env), null);
});

test('prova: o status do verificador sai do resultado dos comandos', () => {
  const { env } = ambiente();
  const raiz = projeto({ mapa: false });
  const sessao = 'ps';
  const fimImpl = (id) => rodar(EVENTOS, { hook_event_name: 'SubagentStop', session_id: sessao, agent_id: id, agent_type: 'implementador', cwd: raiz }, env);
  const verificador = (id, ok, relatorio) => {
    rodar(POS, { hook_event_name: ok ? 'PostToolUse' : 'PostToolUseFailure', session_id: sessao, agent_id: id, agent_type: 'verificador', cwd: raiz, tool_name: 'Bash', tool_input: { command: 'flutter test' } }, env);
    rodar(EVENTOS, { hook_event_name: 'SubagentStop', session_id: sessao, agent_id: id, agent_type: 'verificador', cwd: raiz, last_assistant_message: relatorio }, env);
  };
  const chamar = () => rodar(PRE, { session_id: sessao, cwd: raiz, tool_name: 'Agent', tool_input: { subagent_type: 'implementador', prompt: `Objetivo: x ${Math.random()}.\nEscopo: lib/cupom.dart.\nCritério de aceite: y.\nComo verificar: flutter test` } }, env);
  // O comando passou; o texto fala de uma falha antiga que agora passa: não é falha.
  for (const k of ['1', '2', '3']) { fimImpl(`i${k}`); verificador(`v${k}`, true, 'O teste de test/cupom_test.dart:3, que falhou na rodada anterior, agora passa.'); }
  assert.equal(chamar(), null);
  // O relatório diz "passou", mas o comando falhou: conta como falha.
  for (const k of ['4', '5', '6']) { fimImpl(`i${k}`); verificador(`v${k}`, false, 'Tudo passou. Detalhe em test/cupom_test.dart:3.'); }
  assert.match(motivo(chamar()), /3 tentativas do implementador terminaram com a mesma falha/);
});

test('status do relatório do verificador: contagem de erro, comando barrado e nenhum teste', async () => {
  const { statusDoRelatorio: st } = await import(new URL('../hooks/equipe-comum.mjs', import.meta.url).href);
  assert.equal(st('verificador', '0 falhas, mas a compilação quebrou com 3 erros'), 'com falha');
  assert.equal(st('verificador', 'pytest: 0 failed, 2 errors (collection)'), 'com falha');
  assert.equal(st('verificador', 'flutter test: comando bloqueado pela guarda; o analyze passou'), 'bloqueado');
  assert.equal(st('verificador', 'Rodei npm test -- -t nada: 0 testes, 0 falhas'), 'sem status');
  assert.equal(st('verificador', 'Exit code 1. Tudo ok com os testes de unidade, mas o build falhou'), 'com falha');
  assert.equal(st('verificador', 'Nada foi bloqueado. flutter test passou: 40 testes, 0 falharam.'), 'passou');
  assert.equal(st('verificador', 'flutter test: 12 testes, 0 falhas. flutter analyze: nenhum problema.'), 'passou');
});

// ---------- verificação do implementador: o programa de teste tem de ser o comando ----------

test('implementador: citar o nome do programa de teste não é verificação', async () => {
  const { ehVerificacao } = await import(new URL('../hooks/equipe-entrega.mjs', import.meta.url).href);
  for (const c of ['cat jest.config.js', 'grep -rn pytest .', 'echo vitest', 'ls test/']) assert.equal(ehVerificacao(c, ['flutter test']), false, c);
  for (const c of ['flutter test test/a_test.dart', 'cd app && npm test', 'CI=1 npx jest x', './gradlew test', 'python -m pytest -q', 'pnpm exec vitest run']) assert.equal(ehVerificacao(c, null), true, c);
  assert.equal(ehVerificacao('cd app && flutter test', ['cd app && flutter test']), true);
});

// ---------- agente genérico, push, paralelo e caixa de entrega ----------

test('briefing: agente genérico mandado mudar código é barrado uma vez; só leitura passa', () => {
  const { env } = ambiente();
  const raiz = projeto();
  const agente = (subagent_type, prompt) => rodar(PRE, { session_id: 'gp', cwd: raiz, tool_name: 'Agent', tool_input: { subagent_type, prompt } }, env);
  const p = 'Corrija o bug do total em lib/a1.dart e escreva o teste.';
  assert.match(motivo(agente('general-purpose', p)), /chame o implementador com o briefing/);
  const v = agente('general-purpose', p);
  assert.ok(!decisao(v), 'válvula');
  assert.equal(v.hookSpecificOutput.updatedInput.model, 'sonnet');
  for (const q of ['Pesquise como corrigir o fuso do lib/a1.dart. Só leitura: não edite nada.', 'Resuma as notícias da semana sobre Flutter.', 'Pesquise bibliotecas para Node.js e escreva um resumo com links de docs.example.com.']) assert.ok(!decisao(agente('general-purpose', q)), q);
});

test('push: pede confirmação quando o pedido não falou em push', () => {
  const { claude, env } = ambiente();
  const raiz = projeto({ mapa: false });
  const transcricao = path.join(claude, 'projects', '-p', 'pp.jsonl');
  const falaDoMestre = (texto) => escrever(transcricao, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: texto }] } })}\n`);
  const pedido = (prompt) => rodar(EVENTOS, { hook_event_name: 'UserPromptSubmit', session_id: 'pp', cwd: raiz, prompt, transcript_path: transcricao }, env);
  const bash = (command, extra = {}) => rodar(PRE, { session_id: 'pp', cwd: raiz, tool_name: 'Bash', tool_input: { command }, ...extra }, env);
  const fezPush = () => rodar(POS, { session_id: 'pp', cwd: raiz, tool_name: 'Bash', tool_input: { command: 'git push origin main' } }, env);
  falaDoMestre('Pronto, está no commit local.');
  pedido('corrija o total');
  assert.equal(decisao(bash('git push origin main')), 'ask');
  assert.equal(decisao(bash('cd app && git -C . push')), 'ask');
  assert.equal(bash('git commit -m "docs: como fazer git push"'), null);
  assert.equal(bash('echo git push'), null);
  // Palavra solta não é pedido de push.
  for (const p of ['o servidor sobe na porta 3000 e o app envia notificação', 'suba o servidor local e rode os testes', 'envie um e-mail de teste', 'mande o resumo do erro aqui']) {
    pedido(p);
    assert.equal(decisao(bash('git push')), 'ask', p);
  }
  // Pedido com a palavra: passa, e continua valendo nas mensagens seguintes até o push.
  pedido('implemente X, faça o commit e envie');
  assert.equal(bash('git push origin main'), null);
  pedido('ah, use dd/mm/aaaa');
  assert.equal(bash('git push origin main'), null);
  fezPush();
  assert.equal(bash('git push origin main'), null, 'no mesmo pedido, um segundo push (correção do CI) passa');
  pedido('agora ajuste o README');
  assert.equal(decisao(bash('git push')), 'ask', 'depois do push, a próxima mensagem precisa pedir de novo');
  // "ok" logo depois de o mestre perguntar se envia: passa; "ok" para outra coisa, não.
  falaDoMestre('Commit feito. Envio para o GitHub?');
  pedido('ok');
  assert.equal(bash('git push'), null);
  fezPush();
  falaDoMestre('Quer que eu rode os testes de novo?');
  pedido('ok');
  assert.equal(decisao(bash('git push')), 'ask');
  // A resposta a uma pergunta de múltipla escolha sobre o envio também conta ("Enviar agora").
  rodar(POS, { session_id: 'pp', cwd: raiz, tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Envio para o GitHub?' }], answers: { 'Envio para o GitHub?': 'Enviar agora' } } }, env);
  assert.equal(bash('git push'), null);
  fezPush();
  pedido('mais nada');
  rodar(POS, { session_id: 'pp', cwd: raiz, tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Envio para o GitHub?' }], answers: { 'Envio para o GitHub?': 'Não, deixe para depois' } } }, env);
  assert.equal(decisao(bash('git push')), 'ask');
  // Vale para o subagente também (o pedido é o do mestre); não desliga pelo interruptor.
  assert.equal(decisao(bash('git push', { agent_type: 'general-purpose', agent_id: 'g1' })), 'ask');
  assert.equal(decisao(rodar(PRE, { session_id: 'pp', cwd: raiz, tool_name: 'Bash', tool_input: { command: 'git push' } }, { ...env, EQUIPE_DESLIGAR: 'tudo' })), 'ask');
});

test('paralelo: dois implementadores em segundo plano no mesmo arquivo; o fim de um libera', () => {
  const { claude, env } = ambiente();
  const raiz = projeto({ mapa: false });
  const brief = (escopo, objetivo) => `Objetivo: ${objetivo}.\nEscopo: ${escopo}.\nCritério de aceite: passa.\nComo verificar: flutter test`;
  const lancar = (prompt, fundo = true) => rodar(PRE, { session_id: 'pl', cwd: raiz, tool_name: 'Agent', tool_input: { subagent_type: 'implementador', prompt, run_in_background: fundo } }, env);
  const a = brief('lib/a1.dart e lib/a2.dart', 'tarefa A');
  assert.equal(lancar(a), null);
  assert.equal(lancar(brief('lib/a5.dart', 'tarefa B')), null, 'escopos separados');
  const c = brief('lib/', 'tarefa C');
  assert.match(motivo(lancar(c)), /outro implementador em segundo plano ainda trabalha em lib\/a1\.dart/);
  // Válvula (em primeiro plano, que não fica na lista: o mestre espera por ele).
  assert.equal(lancar(c, false), null, 'válvula');
  assert.ok(registro(claude).some((l) => l[1] === 'paralelo' && l[2] === 'valvula'));
  // A termina: o escopo dele sai da lista.
  const transcricao = transcricaoComBriefing(claude, a);
  rodar(EVENTOS, { hook_event_name: 'SubagentStop', session_id: 'pl', agent_id: 'ia', agent_type: 'implementador', cwd: raiz, agent_transcript_path: transcricao }, env);
  assert.equal(lancar(brief('lib/a2.dart', 'tarefa D')), null);
  // Nome de tecnologia e prosa no escopo não são caminho: "Node.js" e "e/ou" não se cruzam.
  assert.equal(lancar(brief('lib/a8.dart e/ou o teste dele, usando Node.js', 'tarefa E')), null);
  assert.equal(lancar(brief('lib/a9.dart e/ou o teste dele, usando Node.js', 'tarefa F')), null);
  // Nome de arquivo com maiúscula também é caminho: o cruzamento é visto.
  assert.equal(lancar(brief('web/App.tsx', 'tarefa I')), null);
  assert.match(motivo(lancar(brief('App.tsx', 'tarefa J'))), /ainda trabalha em/);
  // Agent que falhou ao lançar sai da lista.
  const g = brief('lib/a6.dart', 'tarefa G');
  assert.equal(lancar(g), null);
  rodar(POS, { hook_event_name: 'PostToolUseFailure', session_id: 'pl', cwd: raiz, tool_name: 'Agent', tool_input: { subagent_type: 'implementador', prompt: g, run_in_background: true } }, env);
  assert.equal(lancar(brief('lib/a6.dart', 'tarefa H')), null);
});

test('escopo: a lista do implementador de segundo plano chega ao mestre na próxima ferramenta', () => {
  const { claude, env } = ambiente();
  const raiz = projeto({ mapa: false });
  const base = { session_id: 'cx', agent_type: 'implementador', agent_id: 'ib', cwd: raiz };
  rodar(EVENTOS, { ...base, hook_event_name: 'SubagentStart' }, env);
  const arq = path.join(raiz, 'lib', 'a7.dart');
  fs.appendFileSync(arq, '// fora\n');
  rodar(POS, { ...base, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  rodar(POS, { ...base, tool_name: 'Bash', tool_input: { command: 'flutter test' } }, env);
  const transcricao = transcricaoComBriefing(claude, 'Objetivo: tarefa de fundo\nEscopo: lib/a1.dart\nCritério de aceite: y');
  rodar(EVENTOS, { ...base, hook_event_name: 'SubagentStop', agent_transcript_path: transcricao }, env);
  // O mestre roda outra coisa qualquer: recebe a lista uma vez.
  const outra = () => rodar(POS, { session_id: 'cx', cwd: raiz, tool_name: 'Bash', tool_input: { command: 'git status' } }, env);
  const t = contexto(outra());
  assert.match(t, /objetivo: tarefa de fundo/);
  assert.match(t, /FORA DO ESCOPO \(1\): lib\/a7\.dart/);
  assert.equal(outra(), null);
});

test('orçamento do mestre: conta as linhas que cada leitura mostra, pelo terminal também', () => {
  const { env } = ambiente();
  const raiz = projeto();
  const grande = path.join(raiz, 'lib', 'grande.dart');
  escrever(grande, 'void g() {}\n'.repeat(1000));
  const pedido = (prompt) => rodar(EVENTOS, { hook_event_name: 'UserPromptSubmit', session_id: 'oc', cwd: raiz, prompt }, env);
  const pre = (tool_name, tool_input) => rodar(PRE, { session_id: 'oc', cwd: raiz, tool_name, tool_input }, env);
  pedido('entenda o fluxo');
  // Trechos pequenos gastam pouco: 40 + 41 linhas, e o trecho que se sobrepõe só conta o que é novo.
  assert.equal(pre('Read', { file_path: grande, offset: 1, limit: 40 }), null);
  assert.equal(pre('Bash', { command: "sed -n '100,140p' lib/grande.dart" }), null);
  assert.equal(pre('PowerShell', { command: '(Get-Content lib/grande.dart)[100..140]' }), null);
  // Busca com muito contexto conta uma estimativa; com pouco contexto, não conta.
  assert.equal(pre('Grep', { pattern: 'g', path: path.join(raiz, 'lib'), output_mode: 'content', '-C': 40 }), null);
  assert.equal(pre('Grep', { pattern: 'g', path: path.join(raiz, 'lib'), output_mode: 'content', '-C': 2 }), null);
  // O arquivo inteiro passa do limite (500): barrado, com o caminho.
  const s = pre('Bash', { command: 'cat lib/grande.dart' });
  assert.equal(decisao(s), 'deny');
  assert.match(motivo(s), /linhas de código lidas neste pedido.*offset e limit.*delegue ao Explore/s);
  // Reler um trecho já lido não conta; um arquivo pequeno ainda cabe.
  assert.equal(pre('Read', { file_path: grande, offset: 1, limit: 40 }), null);
  assert.equal(pre('Read', { file_path: path.join(raiz, 'lib', 'a2.dart') }), null);
  // Pedido novo: a primeira leitura passa sempre, mesmo grande; a seguinte grande, não.
  pedido('agora outra coisa');
  assert.equal(pre('Read', { file_path: grande }), null);
  // A versão antiga do arquivo (git show) é outro texto: conta de novo.
  assert.equal(decisao(pre('Bash', { command: 'git show HEAD:lib/grande.dart' })), 'deny');
  assert.equal(decisao(pre('Read', { file_path: path.join(raiz, 'lib', 'a3.dart') })), 'deny');
});

test('orçamento do mestre: as contas dos comandos comuns e o que não chega ao contexto', async () => {
  const { leiturasDoMestre } = await import(new URL('../hooks/equipe-mapa.mjs', import.meta.url).href);
  const raiz = projeto({ mapa: false });
  const grande = path.join(raiz, 'lib', 'grande.dart');
  escrever(grande, 'void g() {}\n'.repeat(3000));
  const linhas = (tool_name, tool_input) => leiturasDoMestre({ tool_name, tool_input, cwd: raiz })
    .reduce((s, x) => s + (typeof x.n === 'number' ? x.n : x.fim - x.ini + 1), 0);
  const bash = (command) => linhas('Bash', { command });
  // Opção sem valor não esconde o arquivo; head, tail e os estágios do pipe contam o que mostram.
  assert.equal(bash('cat -n lib/grande.dart'), 3000);
  assert.equal(bash('head -n50 lib/grande.dart'), 50);
  assert.equal(bash('tail -n +2901 lib/grande.dart'), 100);
  assert.equal(bash('tail +2991 lib/grande.dart'), 10);
  assert.equal(bash('head -n -2990 lib/grande.dart'), 10);
  assert.equal(bash("nl lib/grande.dart | sed -n '100,140p'"), 41);
  assert.equal(bash("cat lib/grande.dart | awk 'NR>=10 && NR<=19'"), 10);
  // Curinga no nome: a1.dart e a10 a a19, 2 linhas cada.
  assert.equal(bash('cat lib/a1*.dart'), 22);
  // Vários arquivos num pipe: o corte vale para a saída inteira, não para cada arquivo.
  assert.equal(bash('cat lib/a1.dart lib/grande.dart | head -40'), 40);
  assert.equal(bash("sed -n '1,5p' lib/a1.dart lib/grande.dart"), 5);
  // Busca com curinga: uma estimativa para a busca, não uma por arquivo.
  assert.equal(bash('grep -n -C 10 velho lib/*.dart'), 63);
  // O que não chega ao contexto: saída gravada num arquivo e sed -i.
  assert.equal(bash('cat lib/grande.dart > copia.dart'), 0);
  assert.equal(bash('cat lib/grande.dart &> /dev/null'), 0);
  assert.equal(linhas('PowerShell', { command: 'Get-Content lib/grande.dart | Set-Content x.txt' }), 0);
  assert.equal(bash("sed -i 's/g/h/' lib/grande.dart"), 0);
  assert.equal(bash("sed -i.bak -n '1,9p' lib/grande.dart"), 0);
  // O erro (2>) não muda o que aparece; a saída copiada para o erro (>&2) também aparece.
  assert.equal(bash('cat lib/grande.dart 2>/dev/null'), 3000);
  assert.equal(bash('head -n 5 lib/grande.dart >&2'), 5);
  // Read sem limit mostra até 2000 linhas; o Grep, até 250 (head_limit 0: sem teto).
  assert.equal(linhas('Read', { file_path: grande }), 2000);
  assert.equal(linhas('Read', { file_path: grande, offset: 2901 }), 100);
  assert.equal(linhas('Read', { file_path: grande, allow_large: true }), 3000);
  assert.equal(linhas('Grep', { pattern: 'g', path: grande, output_mode: 'content', '-C': 100 }), 250);
  assert.equal(linhas('Grep', { pattern: 'g', path: grande, output_mode: 'content', '-C': 100, head_limit: 0 }), 603);
});

test('orçamento do mestre: Read que falhou devolve a conta; separador certo com pasta que começa com t', () => {
  const { claude, env } = ambiente();
  const raiz = projeto();
  // Caminho com "\t" (barra invertida e t, como C:\...\testes no Windows): com o separador
  // errado, a chave se partia. Fora do Windows, a barra invertida entra no nome da pasta.
  const grande = path.join(raiz, process.platform === 'win32' ? 'testes' : 'x\\testes', 'tela.dart');
  escrever(grande, 'void g() {}\n'.repeat(4000));
  const base = { session_id: 'rf', cwd: raiz };
  rodar(EVENTOS, { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'entenda o fluxo' }, env);
  const ler = (id, tool_input) => rodar(PRE, { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: id, tool_input }, env);
  // O Read do arquivo inteiro passa (primeira leitura) e falha no Claude Code (grande demais).
  assert.equal(ler('r1', { file_path: grande }), null);
  rodar(POS, { ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: grande }, error: 'File content exceeds maximum allowed size' }, env);
  assert.ok(registro(claude).some((l) => l[1] === 'orcamento' && l[2] === 'devolveu'));
  // A conta voltou: o trecho seguinte é a primeira leitura de verdade.
  assert.equal(ler('r2', { file_path: grande, offset: 1, limit: 300 }), null);
  // Reler o mesmo trecho não conta; 300 + 250 passa do limite (500).
  assert.equal(ler('r3', { file_path: grande, offset: 1, limit: 300 }), null);
  assert.equal(decisao(ler('r4', { file_path: grande, offset: 301, limit: 250 })), 'deny');
});

test('despachante de eventos: módulo quebrado vai para o registro e não derruba os outros', () => {
  const { claude, env } = ambiente();
  const raiz = projeto({ mapa: false });
  const copia = tmp('hooks');
  for (const n of fs.readdirSync(HOOKS)) if (n.endsWith('.mjs')) fs.copyFileSync(path.join(HOOKS, n), path.join(copia, n));
  fs.writeFileSync(path.join(copia, 'equipe-prova.mjs'), 'export const x = ;\n'); // erro de sintaxe
  const arq = path.join(raiz, 'lib', 'a1.dart');
  fs.appendFileSync(arq, '// linha\n'.repeat(60));
  rodar(path.join(copia, 'equipe-pos.mjs'), { session_id: 'mq', cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  const s = rodar(path.join(copia, 'equipe-eventos.mjs'), { hook_event_name: 'Stop', session_id: 'mq', cwd: raiz }, env);
  assert.match(s.reason, /chame o revisor/);
  assert.ok(registro(claude).some((l) => l[1] === 'modulo' && l[2] === 'falhou:prova'));
});

test('briefing do revisor: o que já foi aprovado e não mudou não precisa entrar no diff de novo', () => {
  const { env } = ambiente({ EQUIPE_DESLIGAR: 'prova' });
  const raiz = projeto({ mapa: false });
  const sessao = 'ba';
  const editar = (rel, texto) => { const arq = path.join(raiz, rel); fs.appendFileSync(arq, texto); rodar(POS, { session_id: sessao, cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env); };
  const revisor = (prompt, extra = {}) => rodar(PRE, { session_id: sessao, cwd: raiz, tool_name: 'Agent', tool_input: { subagent_type: 'revisor', prompt, ...extra } }, env);
  fs.mkdirSync(path.join(raiz, '.revisao'), { recursive: true });
  // Tarefa 1: área sensível, aprovada e commitada.
  escrever(path.join(raiz, 'lib', 'auth', 'login.dart'), 'void l() {}\n');
  rodar(POS, { session_id: sessao, cwd: raiz, tool_name: 'Write', tool_input: { file_path: path.join(raiz, 'lib', 'auth', 'login.dart') } }, env);
  rodar(EVENTOS, { hook_event_name: 'SubagentStop', session_id: sessao, agent_id: 'r1', agent_type: 'revisor', cwd: raiz, last_assistant_message: 'Veredito: APROVADO' }, env);
  git(raiz, 'add', '--', 'lib/auth/login.dart');
  git(raiz, 'commit', '-q', '-m', 'login');
  // Tarefa 2: o diff de agora (HEAD) basta, e não pede opus pela área sensível antiga.
  editar('lib/a3.dart', '// tarefa 2\n');
  git(raiz, 'diff', 'HEAD', '--output=.revisao/diff.patch');
  assert.equal(revisor('Diff: .revisao/diff.patch. Objetivo: tarefa 2.'), null);
});

test('revisão e prova: o que chegou por merge não é da sessão', () => {
  const { env } = ambiente();
  const raiz = projeto({ mapa: false });
  rodar(EVENTOS, { hook_event_name: 'UserPromptSubmit', session_id: 'mg', cwd: raiz, prompt: 'traga a branch do colega' }, env);
  git(raiz, 'checkout', '-q', '-b', 'colega');
  escrever(path.join(raiz, 'lib', 'payments', 'pix.dart'), '// do colega\n'.repeat(80));
  git(raiz, 'add', '-A');
  git(raiz, 'commit', '-q', '-m', 'pix');
  git(raiz, 'checkout', '-q', 'main');
  git(raiz, 'merge', '-q', '--no-ff', '-m', 'merge colega', 'colega');
  assert.equal(rodar(EVENTOS, { hook_event_name: 'Stop', session_id: 'mg', cwd: raiz }, env), null);
  // O que a sessão muda depois do merge conta.
  fs.appendFileSync(path.join(raiz, 'lib', 'a1.dart'), '// da sessão\n'.repeat(60));
  rodar(POS, { session_id: 'mg', cwd: raiz, tool_name: 'Edit', tool_input: { file_path: path.join(raiz, 'lib', 'a1.dart') } }, env);
  const s = rodar(EVENTOS, { hook_event_name: 'Stop', session_id: 'mg', cwd: raiz }, env);
  assert.match(s.reason, /60 linhas mudadas sem revisão/);
  assert.ok(!s.reason.includes('pix.dart'));
});

test('revisão: reprovação na continuação dispensa as linhas; dois revisores em paralelo', () => {
  const { env } = ambiente({ EQUIPE_DESLIGAR: 'prova' });
  const raiz = projeto({ mapa: false });
  const arq = path.join(raiz, 'lib', 'a1.dart');
  fs.appendFileSync(arq, '// linha\n'.repeat(60));
  rodar(POS, { session_id: 'rc2', cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  const fim = (extra = {}) => rodar(EVENTOS, { hook_event_name: 'Stop', session_id: 'rc2', cwd: raiz, ...extra }, env);
  const revisor = (id, msg, evento = 'SubagentStop') => rodar(EVENTOS, { hook_event_name: evento, session_id: 'rc2', agent_id: id, agent_type: 'revisor', cwd: raiz, last_assistant_message: msg }, env);
  assert.equal(fim().decision, 'block');
  revisor('r1', 'Veredito: REPROVADO. Achados: crítico, lib/a1.dart:2.');
  assert.equal(fim({ stop_hook_active: true }), null);
  // O usuário deixa pendente e pergunta outra coisa: as mesmas linhas não voltam a cobrar.
  rodar(EVENTOS, { hook_event_name: 'UserPromptSubmit', session_id: 'rc2', cwd: raiz, prompt: 'deixe pendente e me explique o fluxo' }, env);
  assert.equal(fim(), null);
  // Dois revisores em paralelo: a aprovação do que começou antes não apaga a reprovação do outro.
  fs.appendFileSync(arq, '// mais\n'.repeat(60));
  rodar(POS, { session_id: 'rc2', cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  revisor('ra', '', 'SubagentStart');
  revisor('rb', '', 'SubagentStart');
  revisor('rb', 'Veredito: REPROVADO. Achados: alto, lib/a1.dart:70.');
  revisor('ra', 'Veredito: APROVADO');
  assert.match(fim().reason, /o revisor reprovou/);
});

test('escopo: o fim da resposta entrega a lista com algo fora do escopo que o mestre não viu', () => {
  const { claude, env } = ambiente({ EQUIPE_DESLIGAR: 'prova,revisao' });
  const raiz = projeto({ mapa: false });
  const base = { session_id: 'ef', agent_type: 'implementador', agent_id: 'ib', cwd: raiz };
  rodar(EVENTOS, { ...base, hook_event_name: 'SubagentStart' }, env);
  const arq = path.join(raiz, 'lib', 'a7.dart');
  fs.appendFileSync(arq, '// fora\n');
  rodar(POS, { ...base, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  rodar(POS, { ...base, tool_name: 'Bash', tool_input: { command: 'flutter test' } }, env);
  rodar(EVENTOS, { ...base, hook_event_name: 'SubagentStop', agent_transcript_path: transcricaoComBriefing(claude, 'Objetivo: fundo\nEscopo: lib/a1.dart\nCritério de aceite: y') }, env);
  const s = rodar(EVENTOS, { hook_event_name: 'Stop', session_id: 'ef', cwd: raiz }, env);
  assert.match(s.reason, /FORA DO ESCOPO \(1\): lib\/a7\.dart/);
  assert.equal(rodar(EVENTOS, { hook_event_name: 'Stop', session_id: 'ef', cwd: raiz }, env), null, 'uma vez');
});

test('travas de retrabalho: git sem tempo (ou com erro) deixa passar', () => {
  const { env } = ambiente();
  const raiz = projeto({ mapa: false });
  const arq = path.join(raiz, 'lib', 'a1.dart');
  fs.appendFileSync(arq, '// linha\n'.repeat(60));
  rodar(POS, { session_id: 'gt', cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  fs.mkdirSync(path.join(raiz, '.revisao'), { recursive: true });
  git(raiz, 'diff', 'HEAD', '--output=.revisao/diff.patch');
  // Orçamento de tempo do git esgotado: toda chamada ao git devolve nada.
  const semTempo = { ...env, EQUIPE_ORCAMENTO_MS: '1' };
  assert.equal(rodar(PRE, { session_id: 'gt', cwd: raiz, tool_name: 'Agent', tool_input: { subagent_type: 'revisor', prompt: 'Diff: .revisao/diff.patch. Objetivo: x.' } }, semTempo), null);
  assert.equal(rodar(EVENTOS, { hook_event_name: 'Stop', session_id: 'gt', cwd: raiz }, semTempo), null);
  // Depois de uma revisão aprovada, o git sem tempo também não vira "linhas mudadas".
  rodar(EVENTOS, { hook_event_name: 'SubagentStop', session_id: 'gt', agent_id: 'r1', agent_type: 'revisor', cwd: raiz, last_assistant_message: 'Veredito: APROVADO' }, env);
  fs.appendFileSync(arq, '// depois\n');
  rodar(POS, { session_id: 'gt', cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  assert.equal(rodar(EVENTOS, { hook_event_name: 'Stop', session_id: 'gt', cwd: raiz }, semTempo), null);
});

test('convergência: tentativa conta pelos arquivos editados, não pela pasta do escopo', () => {
  const { claude, env } = ambiente();
  const raiz = projeto({ mapa: false });
  const sessao = 'ce';
  let n = 0;
  rodar(EVENTOS, { hook_event_name: 'UserPromptSubmit', session_id: sessao, cwd: raiz, prompt: 'faça as três telas' }, env);
  // Teste legado vermelho, sem a marca de anterior; cada tarefa com "Escopo: lib/" mexe noutro arquivo.
  for (const k of [1, 2, 3, 4]) {
    const id = `i${++n}`;
    const base = { session_id: sessao, agent_id: id, agent_type: 'implementador', cwd: raiz };
    const arq = path.join(raiz, 'lib', `a${k}.dart`);
    fs.appendFileSync(arq, '// tela\n');
    rodar(POS, { ...base, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
    rodar(POS, { ...base, tool_name: 'Bash', tool_input: { command: 'flutter test' } }, env);
    rodar(EVENTOS, { ...base, hook_event_name: 'SubagentStop', agent_transcript_path: transcricaoComBriefing(claude, `Objetivo: tela ${k}\nEscopo: lib/\nCritério de aceite: y`) }, env);
    const v = `v${++n}`;
    rodar(POS, { hook_event_name: 'PostToolUseFailure', session_id: sessao, agent_id: v, agent_type: 'verificador', cwd: raiz, tool_name: 'Bash', tool_input: { command: 'flutter test' } }, env);
    rodar(EVENTOS, { hook_event_name: 'SubagentStop', session_id: sessao, agent_id: v, agent_type: 'verificador', cwd: raiz, last_assistant_message: 'Falhou: lib/legado_test.dart:9' }, env);
  }
  const s = rodar(PRE, { session_id: sessao, cwd: raiz, tool_name: 'Agent', tool_input: { subagent_type: 'implementador', prompt: 'Objetivo: tela 5.\nEscopo: lib/.\nCritério de aceite: y.\nComo verificar: flutter test' } }, env);
  assert.equal(s, null);
});

test('base da sessão: só anda quando o HEAD anda por merge, pull ou checkout de outro commit', () => {
  // Num processo novo: o orçamento de tempo do git conta desde o começo do processo.
  const url = new URL('../hooks/equipe-entrega.mjs', import.meta.url).href;
  const baseEfetiva = (r, b) => execFileSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(url)}); process.stdout.write(String(m.baseEfetiva(${JSON.stringify(r)}, ${JSON.stringify(b)})));`], { encoding: 'utf8' });
  const raiz = projeto({ mapa: false });
  const base = git(raiz, 'rev-parse', 'HEAD');
  fs.appendFileSync(path.join(raiz, 'lib', 'a1.dart'), '// sessão\n');
  git(raiz, 'commit', '-q', '-am', 'da sessão');
  // checkout -b não move o HEAD: a base continua a do começo.
  git(raiz, 'checkout', '-q', '-b', 'nova');
  assert.equal(baseEfetiva(raiz, base), base);
  // Merge de outra branch: a base passa a ser o commit do merge.
  git(raiz, 'checkout', '-q', '-b', 'outra', base);
  fs.appendFileSync(path.join(raiz, 'lib', 'a2.dart'), '// outra\n');
  git(raiz, 'commit', '-q', '-am', 'outra');
  git(raiz, 'checkout', '-q', 'nova');
  git(raiz, 'merge', '-q', '--no-ff', '-m', 'merge', 'outra');
  assert.equal(baseEfetiva(raiz, base), git(raiz, 'rev-parse', 'HEAD'));
});


test('revisão: parar para perguntar ao usuário não conta como concluída nem libera as linhas', () => {
  const { claude, env } = ambiente({ EQUIPE_DESLIGAR: 'prova' });
  const raiz = projeto({ mapa: false });
  const transcricao = path.join(claude, 'projects', '-p', 'rp2.jsonl');
  const fala = (texto) => escrever(transcricao, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: texto }] } })}\n`);
  const fim = (extra = {}) => rodar(EVENTOS, { hook_event_name: 'Stop', session_id: 'rp2', cwd: raiz, transcript_path: transcricao, ...extra }, env);
  const pedido = (prompt) => rodar(EVENTOS, { hook_event_name: 'UserPromptSubmit', session_id: 'rp2', cwd: raiz, prompt, transcript_path: transcricao }, env);
  pedido('faça a tela nova');
  const arq = path.join(raiz, 'lib', 'a1.dart');
  fs.appendFileSync(arq, '// linha\n'.repeat(60));
  rodar(POS, { session_id: 'rp2', cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  fala('Fiz a tela. Qual cor você prefere para o botão?');
  assert.equal(fim().decision, 'block');
  // Na continuação, ainda é uma pergunta: pausa, e as linhas não são liberadas.
  assert.equal(fim({ stop_hook_active: true }), null);
  assert.ok(registro(claude).some((l) => l[1] === 'revisao' && l[2] === 'pausou-sem-revisao'));
  // Outra resposta só com pergunta, sem mudar o código: não cobra de novo.
  pedido('azul ou verde, tanto faz');
  fala('Entendi. Prefere o tom mais claro?');
  assert.equal(fim(), null);
  assert.ok(!registro(claude).some((l) => l[1] === 'revisao' && l[2] === 'concluiu-sem-revisao'));
  // Concluir com o mesmo código: a cobrança já veio antes da pausa; dispensa sem barrar de novo.
  pedido('o claro');
  fala('Pronto: botão no tom claro. Quer que eu envie?');
  assert.equal(fim(), null);
  assert.ok(registro(claude).some((l) => l[1] === 'revisao' && l[2] === 'concluiu-sem-revisao'));
  // Mudança nova depois disso: a cobrança volta.
  fs.appendFileSync(arq, '// mais\n'.repeat(60));
  rodar(POS, { session_id: 'rp2', cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  fala('Ajustei o botão.');
  assert.equal(fim().decision, 'block');
});

test('revisão: a entrega que termina oferecendo o envio é conclusão; revisor em segundo plano não é cobrado', async () => {
  const { ehPausa } = await import(new URL('../hooks/equipe-entrega.mjs', import.meta.url).href);
  const fala = (last_assistant_message) => ({ last_assistant_message });
  // Pausas de verdade.
  assert.equal(ehPausa(fala('Ainda não terminei: preciso que você escolha a cor.')), true);
  assert.equal(ehPausa(fala('Tenho duas opções. Qual você prefere?')), true);
  assert.equal(ehPausa(fala('O plano está em .revisao/plano.md. Posso seguir?')), true);
  assert.equal(ehPausa(fala('Antes do commit: qual mensagem você prefere?')), true);
  assert.equal(ehPausa(fala('Pronto o backend. Sigo com o front?')), true);
  assert.equal(ehPausa(fala('Implementei metade; quer que eu continue?')), true);
  assert.equal(ehPausa(fala('Corrigido e verificado. Posso seguir?')), false);
  // Fim de entrega com o pedido de aprovação no fim (o que a regra pede): conclusão.
  assert.equal(ehPausa(fala('Pronto: corrigi o login. Quer que eu envie?')), false);
  assert.equal(ehPausa(fala('Feito. Posso fazer o push?')), false);
  assert.equal(ehPausa(fala('Implementei a busca e os testes passaram. Me avise se quer ajustes.')), false);
  // O Stop: revisor rodando em segundo plano não é cobrado nem conta como conclusão.
  const { claude, env } = ambiente({ EQUIPE_DESLIGAR: 'prova' });
  const raiz = projeto({ mapa: false });
  const arq = path.join(raiz, 'lib', 'a1.dart');
  fs.appendFileSync(arq, '// linha\n'.repeat(60));
  rodar(POS, { session_id: 'rs', cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  const fim = (extra = {}) => rodar(EVENTOS, { hook_event_name: 'Stop', session_id: 'rs', cwd: raiz, last_assistant_message: 'O revisor está rodando; aviso quando ele terminar.', ...extra }, env);
  const rodando = [{ id: 't1', type: 'local_agent', status: 'running', agent_type: 'revisor', description: 'Revisar a mudança' }];
  assert.equal(fim({ background_tasks: rodando }), null);
  assert.ok(registro(claude).some((l) => l[1] === 'revisao' && l[2] === 'revisor-rodando'));
  // Sem o revisor rodando (outra tarefa qualquer), a cobrança vale.
  assert.equal(fim({ background_tasks: [{ id: 't2', type: 'local_bash', status: 'running', command: 'npm run dev' }] }).decision, 'block');
});

test('contexto do verificador: pasta que sumiu aponta o projeto da sessão e o cd', () => {
  const { env } = ambiente();
  const raiz = projeto({ mapa: false });
  const arq = path.join(raiz, 'lib', 'a1.dart');
  fs.appendFileSync(arq, '// x\n');
  rodar(POS, { session_id: 'cv', cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  const sumiu = path.join(tmp('sumiu'), 'pasta-que-sumiu');
  const saida = execFileSync(process.execPath, [path.join(HOOKS, 'equipe-contexto.mjs')], { input: JSON.stringify({ hook_event_name: 'SubagentStart', session_id: 'cv', agent_type: 'verificador', cwd: sumiu }), encoding: 'utf8', env: { ...process.env, ...env } });
  const t = JSON.parse(saida).hookSpecificOutput.additionalContext;
  assert.match(t, /não existe mais/);
  // Entre aspas e com barra normal (o Git Bash come a barra invertida); ";" no PowerShell.
  // O caminho é comparado pelo real (no Windows, a pasta temporária pode vir com nome curto).
  const m = t.match(/No Bash: cd "([^"]+)" && <linha da lista>/);
  assert.ok(m, t);
  assert.ok(!m[1].includes('\\'), m[1]);
  assert.equal(fs.realpathSync.native(m[1]).toLowerCase(), fs.realpathSync.native(raiz).toLowerCase());
  assert.ok(t.includes(`No PowerShell: cd "${m[1]}"; <linha da lista>`), t);
  assert.match(t, /flutter test/);
  // Numa pasta que é outro repositório, sem a lista: não manda testar o projeto da sessão.
  const outro = tmp('outro-repo');
  git(outro, 'init', '-q');
  for (let i = 0; i < 3; i++) escrever(path.join(outro, 'src', `b${i}.ts`), `export const b${i} = ${i};\n`);
  const t2 = execFileSync(process.execPath, [path.join(HOOKS, 'equipe-contexto.mjs')], { input: JSON.stringify({ hook_event_name: 'SubagentStart', session_id: 'cv', agent_type: 'verificador', cwd: outro }), encoding: 'utf8', env: { ...process.env, ...env } });
  const c2 = t2.trim() ? JSON.parse(t2).hookSpecificOutput.additionalContext : '';
  assert.ok(!/No Bash: cd /.test(c2), c2);
});

test('conversa longa: a partir do 5º resumo, um aviso por resumo', () => {
  const { claude, env } = ambiente();
  const raiz = projeto({ mapa: false });
  const resumo = () => execFileSync(process.execPath, [path.join(HOOKS, 'equipe-boletim.mjs')], { input: JSON.stringify({ session_id: 'cl', cwd: raiz, source: 'compact' }), encoding: 'utf8', env: { ...process.env, ...env } });
  const pedido = () => rodar(EVENTOS, { hook_event_name: 'UserPromptSubmit', session_id: 'cl', cwd: raiz, prompt: 'continue' }, env);
  for (let i = 0; i < 4; i++) resumo();
  assert.equal(pedido(), null, '4 resumos: nada');
  resumo();
  assert.match(contexto(pedido()), /resumida 5 vezes.*conversa nova/s);
  assert.equal(pedido(), null, 'uma vez por resumo');
  resumo();
  assert.match(contexto(pedido()), /resumida 6 vezes/);
  assert.ok(registro(claude).some((l) => l[1] === 'conversa' && l[2] === 'avisou'));
  // Desligado no projeto (uma sessão longa de propósito).
  resumo();
  assert.equal(rodar(EVENTOS, { hook_event_name: 'UserPromptSubmit', session_id: 'cl', cwd: raiz, prompt: 'x' }, { ...env, EQUIPE_DESLIGAR: 'conversa' }), null);
});

// ---------- objetivo, sobras de depuração, progresso e teste de trava ----------

test('objetivo: o fim só passa com o "Pronto quando" verde ou com o Status de espera', () => {
  const { claude, env } = ambiente({ EQUIPE_DESLIGAR: 'revisao' });
  const raiz = projeto({ mapa: false });
  const sessao = 'ob';
  const arq = path.join(raiz, 'lib', 'a1.dart');
  const alvo = path.join(raiz, '.revisao', 'objetivo.md');
  const pedido = (prompt) => rodar(EVENTOS, { hook_event_name: 'UserPromptSubmit', session_id: sessao, cwd: raiz, prompt }, env);
  const editar = () => { fs.appendFileSync(arq, `// ${Math.random()}\n`); rodar(POS, { session_id: sessao, cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env); };
  const rodou = (comando, ok) => rodar(POS, { hook_event_name: ok ? 'PostToolUse' : 'PostToolUseFailure', session_id: sessao, cwd: raiz, tool_name: 'Bash', tool_input: { command: comando }, agent_type: 'verificador', agent_id: 'v' }, env);
  const gravar = (status, pronto = '- `flutter test`\n- `flutter analyze`\n- a tela abre') => {
    escrever(alvo, `# Objetivo\nPedido: corrigir o total\nPronto quando:\n${pronto}\nPare só para: aprovar push.\nStatus: ${status}\nDecisões:\n- nenhuma\n`);
    return rodar(POS, { session_id: sessao, cwd: raiz, tool_name: 'Write', tool_input: { file_path: alvo } }, env);
  };
  const fim = (extra = {}) => rodar(EVENTOS, { hook_event_name: 'Stop', session_id: sessao, cwd: raiz, ...extra }, env);
  pedido('corrija o total; vou sair, deixe rodando');
  gravar('ativo');
  assert.ok(registro(claude).some((l) => l[1] === 'objetivo' && l[2] === 'gravou'));
  editar();
  // Sem verde: barra, com as linhas que faltam (a cobrança da prova não se repete).
  let s = fim();
  assert.equal(s.decision, 'block');
  assert.match(s.reason, /objetivo ativo.*falta verde.*flutter test, flutter analyze/s);
  assert.ok(!/nenhuma linha da lista rodou/.test(s.reason));
  // Uma linha passou, a outra falhou: falta a que falhou. O laço continua no fim seguinte.
  rodou('flutter test', true);
  rodou('flutter analyze', false);
  s = fim({ stop_hook_active: true });
  assert.match(s.reason, /falta verde com o código de agora em: flutter analyze\./);
  // As duas verdes com o código de agora: passa, mesmo com o Status ainda ativo.
  rodou('flutter analyze', true);
  assert.equal(fim(), null);
  assert.ok(registro(claude).some((l) => l[1] === 'objetivo' && l[2] === 'atingido'));
  // Código novo depois do verde: volta a cobrar; "concluído" sem verificação não basta.
  editar();
  gravar('concluído');
  assert.match(fim().reason, /diz concluído, mas a verificação não confirma/);
  // Aguardando o usuário: o objetivo deixa parar, e a prova (que esperava o objetivo) cobra
  // uma vez o código que mudou sem verificação; insistir passa.
  gravar('aguardando usuário: aprovar o push');
  assert.match(fim().reason, /o código mudou e não há verificação verde/);
  assert.equal(fim({ stop_hook_active: true }), null);
  assert.ok(registro(claude).some((l) => l[1] === 'objetivo' && l[2] === 'aguardando'));
  // A mesma cobrança, sem o código mudar, vale no máximo 3 vezes.
  gravar('ativo');
  const barrou = () => { const x = fim(); return Boolean(x && x.decision === 'block'); };
  assert.deepEqual([barrou(), barrou(), barrou(), barrou()], [true, true, true, false]);
  assert.ok(registro(claude).some((l) => l[1] === 'objetivo' && l[2] === 'sem-progresso'));
  // Encerrado: desliga.
  editar();
  gravar('encerrado');
  assert.equal(fim(), null);
});

test('objetivo: sem linha da lista, espera o Status concluído; vale só na sessão que gravou', async () => {
  const { lerObjetivo, linhasPedidas } = await import(new URL('../hooks/equipe-objetivo.mjs', import.meta.url).href);
  const o = lerObjetivo('# Objetivo\n**Pronto quando:** `flutter test` passa\n- o botão aparece\n- `npm test` e `flutter analyze`\nPare só para: aprovar.\n**Status:** Aguardando usuário: escolher a cor\n');
  assert.equal(o.status, 'aguardando');
  assert.equal(o.motivo, 'Aguardando usuário: escolher a cor');
  assert.deepEqual(linhasPedidas(o.pronto, ['flutter test', 'flutter analyze', 'npm run build']), ['flutter test', 'flutter analyze']);
  assert.equal(lerObjetivo('Status: concluído').status, 'concluido');
  assert.equal(lerObjetivo('Pronto quando:\n- x\n').status, 'ativo');
  const { env } = ambiente({ EQUIPE_DESLIGAR: 'revisao,prova' });
  const raiz = projeto({ mapa: false });
  const alvo = path.join(raiz, '.revisao', 'objetivo.md');
  escrever(alvo, '# Objetivo\nPronto quando:\n- o relatório sai em PDF\nStatus: ativo\n');
  rodar(POS, { session_id: 'oa', cwd: raiz, tool_name: 'Write', tool_input: { file_path: alvo } }, env);
  const fim = (sessao) => rodar(EVENTOS, { hook_event_name: 'Stop', session_id: sessao, cwd: raiz }, env);
  assert.match(fim('oa').reason, /Ao terminar, confira cada critério e escreva "Status: concluído"/);
  // Outra sessão não herda o objetivo.
  assert.equal(fim('outra'), null);
  escrever(alvo, '# Objetivo\nPronto quando:\n- o relatório sai em PDF\nStatus: concluído\n');
  rodar(POS, { session_id: 'oa', cwd: raiz, tool_name: 'Edit', tool_input: { file_path: alvo } }, env);
  assert.equal(fim('oa'), null);
  // O interruptor desliga.
  const { env: env2 } = ambiente({ EQUIPE_DESLIGAR: 'revisao,prova,objetivo' });
  escrever(alvo, '# Objetivo\nPronto quando:\n- x\nStatus: ativo\n');
  rodar(POS, { session_id: 'ob2', cwd: raiz, tool_name: 'Write', tool_input: { file_path: alvo } }, env2);
  assert.equal(rodar(EVENTOS, { hook_event_name: 'Stop', session_id: 'ob2', cwd: raiz }, env2), null);
});

test('sobras: aviso depois da edição, uma vez por linha, e na lista do escopo do implementador', () => {
  const { claude, env } = ambiente();
  const raiz = projeto({ mapa: false });
  escrever(path.join(raiz, 'src', 'conta.ts'), 'export const a = 1;\n');
  git(raiz, 'add', '-A');
  git(raiz, 'commit', '-q', '-m', 'ts');
  const editar = (rel, texto, extra = {}) => {
    const arq = path.join(raiz, rel);
    fs.appendFileSync(arq, texto);
    return contexto(rodar(POS, { session_id: 'sb', cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq }, ...extra }, env));
  };
  // Linha nova com console.log e marca de debug: aviso com arquivo e linha.
  let c = editar('src/conta.ts', 'console.log("total", a);\n// DEBUG: tirar depois\n');
  assert.match(c, /sobras de depuração/);
  assert.match(c, /src\/conta\.ts:2 `console\.log\("total", a\);`/);
  assert.match(c, /src\/conta\.ts:3/);
  assert.ok(registro(claude).some((l) => l[1] === 'sobras' && l[2] === 'avisou'));
  // A mesma linha não volta; código comum não avisa; print do Dart avisa.
  assert.ok(!/sobras/.test(editar('src/conta.ts', 'export const b = 2;\n')));
  assert.match(editar('lib/a1.dart', '  print(total);\n'), /lib\/a1\.dart:\d+ `print\(total\);`/);
  // Em arquivo de teste, print e console.log não contam; debugger conta.
  escrever(path.join(raiz, 'test', 'conta_test.dart'), 'void main() {}\n');
  assert.ok(!/sobras/.test(editar('test/conta_test.dart', 'print(1);\n')));
  // Arquivo com cara de temporário.
  escrever(path.join(raiz, 'saida.log'), 'x\n');
  assert.match(contexto(rodar(POS, { session_id: 'sb', cwd: raiz, tool_name: 'Write', tool_input: { file_path: path.join(raiz, 'saida.log') } }, env)), /saida\.log \(arquivo com cara de temporário\)/);
  // O verificador não edita; o interruptor desliga.
  const { env: env2 } = ambiente({ EQUIPE_DESLIGAR: 'sobras' });
  fs.appendFileSync(path.join(raiz, 'src', 'conta.ts'), 'debugger;\n');
  assert.ok(!/sobras/.test(contexto(rodar(POS, { session_id: 'sb2', cwd: raiz, tool_name: 'Edit', tool_input: { file_path: path.join(raiz, 'src', 'conta.ts') } }, env2))));
  // Fim do implementador: a lista do escopo diz as sobras dos arquivos dele.
  const { env: env3 } = ambiente();
  const raiz3 = projeto({ mapa: false });
  const transcricao = path.join(tmp('tr'), 'agente.jsonl');
  escrever(transcricao, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Objetivo: ajustar\nEscopo: lib/\nCritério de aceite: teste\nComo verificar: flutter test' } })}\n`);
  const base = { session_id: 'sc', cwd: raiz3, agent_type: 'implementador', agent_id: 'i9', agent_transcript_path: transcricao };
  rodar(EVENTOS, { ...base, hook_event_name: 'SubagentStart' }, env3);
  const arq3 = path.join(raiz3, 'lib', 'a2.dart');
  fs.appendFileSync(arq3, 'void g() { print("x"); }\n  print(1);\n');
  rodar(POS, { ...base, tool_name: 'Edit', tool_input: { file_path: arq3 } }, env3);
  rodar(POS, { ...base, tool_name: 'Bash', tool_input: { command: 'flutter test' } }, env3);
  rodar(EVENTOS, { ...base, hook_event_name: 'SubagentStop' }, env3);
  const lista = fs.readFileSync(path.join(raiz3, '.revisao', 'escopo.md'), 'utf8');
  assert.match(lista, /Sobras de depuração \(1\): lib\/a2\.dart:4 `print\(1\);`/);
});

test('boletim: progresso, objetivo e teste de trava', () => {
  const { claude, env } = ambiente();
  const raiz = projeto({ mapa: false });
  const BOLETIM = path.join(HOOKS, 'equipe-boletim.mjs');
  const boletim = (source) => contexto(rodar(BOLETIM, { hook_event_name: 'SessionStart', session_id: 'bo', cwd: raiz, source }, env));
  assert.ok(!/Progresso em/.test(boletim('startup')));
  escrever(path.join(raiz, '.revisao', 'progresso.md'), '# Progresso\nPedido: total do carrinho\n- **Feito:** lib/a1.dart\nVerificado: flutter test passou\nFalta: o frete\nRetomar por: escrever o teste do frete em test/frete_test.dart\n');
  let b = boletim('startup');
  assert.match(b, /Progresso em \.revisao\/progresso\.md \(atualizado hoje\): retomar por escrever o teste do frete em test\/frete_test\.dart\. Se a tarefa de agora é a mesma/);
  assert.match(boletim('compact'), /A conversa acabou de ser resumida: releia/);
  // Objetivo de menos de 1 dia ainda ativo.
  escrever(path.join(raiz, '.revisao', 'objetivo.md'), '# Objetivo\nPronto quando:\n- `flutter test`\nStatus: aguardando usuário: aprovar o push\n');
  assert.match(boletim('startup'), /Objetivo de menos de 1 dia em \.revisao\/objetivo\.md \(Status: aguardando usuário: aprovar o push\)/);
  escrever(path.join(raiz, '.revisao', 'objetivo.md'), '# Objetivo\nStatus: concluído\n');
  assert.ok(!/Objetivo/.test(boletim('startup')));
  // Teste de trava em andamento.
  const ate = new Date(Date.now() + 3 * 86400000).toISOString();
  escrever(path.join(claude, 'equipe-diario', 'teste-trava.json'), JSON.stringify({ trava: 'orcamento', desde: new Date().toISOString(), ate }));
  b = boletim('startup');
  assert.match(b, /Teste da retrospectiva: a trava "orcamento" está desligada até/);
});

test('teste de trava: desliga só a testável, e só até a data', () => {
  const { claude, env } = ambiente();
  const raiz = projeto();
  const diario = path.join(claude, 'equipe-diario');
  const comLimite = { ...env, EQUIPE_MESTRE_LINHAS: '1' };
  rodar(EVENTOS, { hook_event_name: 'UserPromptSubmit', session_id: 'tt', cwd: raiz, prompt: 'entenda' }, comLimite);
  const lerCom = (offset, e) => rodar(PRE, { hook_event_name: 'PreToolUse', session_id: 'tt', cwd: raiz, tool_name: 'Read', tool_input: { file_path: path.join(raiz, 'lib', `a${offset}.dart`), offset: 1, limit: 1 } }, e);
  assert.equal(lerCom(1, comLimite), null);
  assert.equal(decisao(lerCom(2, comLimite)), 'deny', 'orçamento ligado');
  // Teste em andamento para o orçamento: a leitura passa.
  escrever(path.join(diario, 'teste-trava.json'), JSON.stringify({ trava: 'orcamento', desde: new Date().toISOString(), ate: new Date(Date.now() + 86400000).toISOString() }));
  assert.equal(lerCom(3, comLimite), null);
  // Vencido: volta.
  escrever(path.join(diario, 'teste-trava.json'), JSON.stringify({ trava: 'orcamento', desde: '2026-01-01T00:00:00Z', ate: '2026-01-08T00:00:00Z' }));
  assert.equal(decisao(lerCom(4, comLimite)), 'deny');
  // Trava que não é testável (prova, revisão, guarda) não desliga pelo teste.
  escrever(path.join(diario, 'teste-trava.json'), JSON.stringify({ trava: 'revisao', desde: new Date().toISOString(), ate: new Date(Date.now() + 86400000).toISOString() }));
  assert.equal(decisao(lerCom(5, comLimite)), 'deny');
});

test('.revisao: arquivo gravado ali ganha o .gitignore da pasta e some do git status', () => {
  const { env } = ambiente();
  const raiz = projeto({ mapa: false });
  const arq = path.join(raiz, '.revisao', 'progresso.md');
  escrever(arq, '# Progresso\nRetomar por: o frete\n');
  assert.match(git(raiz, 'status', '--porcelain'), /\.revisao\//);
  rodar(POS, { session_id: 'gi', cwd: raiz, tool_name: 'Write', tool_input: { file_path: arq } }, env);
  assert.equal(fs.readFileSync(path.join(raiz, '.revisao', '.gitignore'), 'utf8'), '*\n');
  assert.ok(!/\.revisao/.test(git(raiz, 'status', '--porcelain')));
  // Um .gitignore que já existe não é tocado; arquivo fora de .revisao/ não cria nada.
  escrever(path.join(raiz, '.revisao', '.gitignore'), '*\n!manter.md\n');
  rodar(POS, { session_id: 'gi', cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  assert.equal(fs.readFileSync(path.join(raiz, '.revisao', '.gitignore'), 'utf8'), '*\n!manter.md\n');
  escrever(path.join(raiz, 'docs', 'nota.md'), 'x\n');
  rodar(POS, { session_id: 'gi', cwd: raiz, tool_name: 'Write', tool_input: { file_path: path.join(raiz, 'docs', 'nota.md') } }, env);
  assert.ok(!fs.existsSync(path.join(raiz, 'docs', '.gitignore')));
});

// ---------- achados da revisão: objetivo, fim da resposta, sobras e teste de trava ----------

// Sessão do mestre com um objetivo: pedido, gravar o arquivo, editar, rodar uma linha da lista
// (pelo verificador) e o fim da resposta.
function sessaoComObjetivo(raiz, env, id) {
  const alvo = path.join(raiz, '.revisao', 'objetivo.md');
  return {
    alvo,
    pedido: (prompt = 'corrija; vou sair, deixe rodando') => rodar(EVENTOS, { hook_event_name: 'UserPromptSubmit', session_id: id, cwd: raiz, prompt }, env),
    gravar: (texto) => { escrever(alvo, texto); return rodar(POS, { session_id: id, cwd: raiz, tool_name: 'Write', tool_input: { file_path: alvo } }, env); },
    editar: (linhas = 1, arq = path.join(raiz, 'lib', 'a1.dart')) => {
      fs.appendFileSync(arq, Array.from({ length: linhas }, (_, i) => `void g${Math.random().toString(36).slice(2)}${i}() {}\n`).join(''));
      return rodar(POS, { session_id: id, cwd: raiz, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
    },
    rodou: (comando, ok = true, agente = 'v1') => rodar(POS, { hook_event_name: ok ? 'PostToolUse' : 'PostToolUseFailure', session_id: id, cwd: raiz, tool_name: 'Bash', tool_input: { command: comando }, agent_type: 'verificador', agent_id: agente }, env),
    fim: (extra = {}) => rodar(EVENTOS, { hook_event_name: 'Stop', session_id: id, cwd: raiz, last_assistant_message: 'Pronto, terminei a mudança.', ...extra }, env),
  };
}
const barrou = (s) => Boolean(s && s.decision === 'block');

test('fim da resposta: depois de uma cobrança do objetivo, a revisão e a prova ainda cobram a parte delas', () => {
  // A revisão: o objetivo barra cedo; depois, 120 linhas mudam e o teste passa. O fim seguinte
  // (stop_hook_active) não é "insistência" da revisão, que nunca barrou: ela cobra.
  const { claude, env } = ambiente();
  const raiz = projeto({ mapa: false });
  const s = sessaoComObjetivo(raiz, env, 'fa');
  s.pedido();
  s.gravar('# Objetivo\nPronto quando:\n- `flutter test`\nStatus: ativo\n');
  assert.ok(barrou(s.fim({ last_assistant_message: 'Posso seguir com a implementação?' })));
  s.editar(120);
  s.rodou('flutter test', true);
  let f = s.fim({ stop_hook_active: true });
  assert.ok(barrou(f), 'a revisão cobra');
  assert.match(f.reason, /chame o revisor/);
  assert.ok(!registro(claude).some((l) => l[1] === 'revisao' && l[2] === 'concluiu-sem-revisao'));
  // Insistir depois da cobrança dela passa, como sempre.
  assert.equal(barrou(s.fim({ stop_hook_active: true })), false);

  // A prova: "Pronto quando" só com o analyze. O objetivo fica verde, e a prova ainda pede um
  // teste de verdade (antes, a cobrança dela sumia junto com a do objetivo).
  const { env: e2 } = ambiente({ EQUIPE_DESLIGAR: 'revisao' });
  const r2 = projeto({ mapa: false });
  const s2 = sessaoComObjetivo(r2, e2, 'fb');
  s2.pedido();
  s2.gravar('# Objetivo\nPronto quando:\n- `flutter analyze`\nStatus: ativo\n');
  s2.editar(3);
  f = s2.fim();
  assert.match(f.reason, /falta verde com o código de agora em: flutter analyze\./);
  assert.ok(!/nenhuma linha da lista rodou/.test(f.reason));
  s2.rodou('flutter analyze', true);
  f = s2.fim({ stop_hook_active: true });
  assert.ok(barrou(f), 'a prova cobra o teste');
  assert.match(f.reason, /o código mudou e não há verificação verde/);

  // "Pronto quando" só com o teste, e o analyze falhou: depois do teste verde, a falha do
  // analyze aparece.
  const { env: e3 } = ambiente({ EQUIPE_DESLIGAR: 'revisao' });
  const r3 = projeto({ mapa: false });
  const s3 = sessaoComObjetivo(r3, e3, 'fc');
  s3.pedido();
  s3.gravar('# Objetivo\nPronto quando:\n- `flutter test`\nStatus: ativo\n');
  s3.editar(3);
  s3.rodou('flutter analyze', false);
  assert.match(s3.fim().reason, /falta verde com o código de agora em: flutter test\./);
  s3.rodou('flutter test', true);
  f = s3.fim({ stop_hook_active: true });
  assert.match(f.reason, /falhou com o código de agora \(flutter analyze\)/);
});

test('objetivo: teto por pedido, agente em segundo plano e relatório que o teste grava', () => {
  // O código muda a cada volta e o teste segue vermelho: no máximo 8 cobranças por pedido (a
  // prova, desligada aqui, cobraria a parte dela uma vez depois disso).
  const { claude, env } = ambiente({ EQUIPE_DESLIGAR: 'revisao,prova' });
  const raiz = projeto({ mapa: false });
  const s = sessaoComObjetivo(raiz, env, 'ta');
  s.pedido();
  s.gravar('# Objetivo\nPronto quando:\n- `flutter test`\nStatus: ativo\n');
  let n = 0;
  for (let i = 0; i < 12; i++) {
    s.editar(1);
    s.rodou('flutter test', false, `v${i}`);
    if (barrou(s.fim({ stop_hook_active: i > 0 }))) n++;
  }
  assert.equal(n, 8);
  assert.ok(registro(claude).some((l) => l[1] === 'objetivo' && l[2] === 'sem-progresso'));
  // Mensagem nova do usuário: volta a cobrar.
  s.pedido('tente de novo');
  assert.ok(barrou(s.fim()));

  // Verificador em segundo plano: o mestre parou para esperar; não barra nem gasta cobrança.
  const { claude: c2, env: e2 } = ambiente({ EQUIPE_DESLIGAR: 'revisao' });
  const r2 = projeto({ mapa: false });
  const s2 = sessaoComObjetivo(r2, e2, 'tb');
  s2.pedido();
  s2.gravar('# Objetivo\nPronto quando:\n- `flutter test`\nStatus: ativo\n');
  s2.editar(2);
  const bg = { background_tasks: [{ id: 'b1', agent_type: 'verificador', status: 'running' }] };
  for (let i = 0; i < 4; i++) assert.equal(barrou(s2.fim({ ...bg, stop_hook_active: i > 0 })), false);
  assert.ok(registro(c2).some((l) => l[1] === 'objetivo' && l[2] === 'esperando-agente'));
  assert.ok(registro(c2).some((l) => l[1] === 'prova' && l[2] === 'verificador-rodando'), 'a prova também espera');
  // O verificador termina com falha: a cobrança vem, com o código de antes.
  s2.rodou('flutter test', false);
  assert.ok(barrou(s2.fim({ stop_hook_active: true })));

  // O teste grava um relatório (junit.xml, fora do .gitignore): o código não "muda" a cada
  // rodada, e as duas linhas ficam verdes juntas (antes, a trava alternava entre elas).
  const { env: e3 } = ambiente({ EQUIPE_DESLIGAR: 'revisao' });
  const r3 = projeto({ mapa: false });
  escrever(path.join(r3, '.claude', 'verificador-comandos.txt'), 'npm test\nnpm run e2e\n');
  git(r3, 'add', '-A');
  git(r3, 'commit', '-q', '-m', 'lista');
  const s3 = sessaoComObjetivo(r3, e3, 'tc');
  s3.pedido();
  s3.gravar('# Objetivo\nPronto quando:\n- `npm test`\n- `npm run e2e`\nStatus: ativo\n');
  s3.editar(1);
  const comRelatorio = (cmd, i) => { escrever(path.join(r3, 'junit.xml'), `<testsuites id="${i}-${Math.random()}"/>\n`); s3.rodou(cmd, true, `v${i}`); };
  comRelatorio('npm test', 1);
  comRelatorio('npm run e2e', 2);
  assert.equal(s3.fim(), null);
});

test('objetivo: sem linha da lista, código novo ou arquivo regravado voltam a cobrar; Status em item e título', () => {
  const { env } = ambiente({ EQUIPE_DESLIGAR: 'revisao,prova' });
  const raiz = projeto({ mapa: false });
  const s = sessaoComObjetivo(raiz, env, 'sa');
  s.pedido();
  s.gravar('# Objetivo\nPronto quando:\n- a tela abre\nStatus: ativo\n');
  assert.deepEqual([barrou(s.fim()), barrou(s.fim({ stop_hook_active: true })), barrou(s.fim({ stop_hook_active: true })), barrou(s.fim({ stop_hook_active: true }))], [true, true, true, false]);
  s.editar(2);
  assert.ok(barrou(s.fim({ stop_hook_active: true })), 'código novo cobra de novo');
  s.gravar('# Objetivo\nPronto quando:\n- a tela abre\n- o PDF sai\nStatus: ativo\n');
  assert.ok(barrou(s.fim({ stop_hook_active: true })), 'objetivo regravado cobra de novo');
  // Status em item de lista e em título (com o valor na linha seguinte): vale a espera.
  s.gravar('# Objetivo\nPronto quando:\n- a tela abre\n- Status: aguardando usuário: aprovar o push\n');
  assert.equal(s.fim(), null);
  s.gravar('# Objetivo\n## Pronto quando\n- a tela abre\n## Status\naguardando usuário: escolher a cor\n');
  assert.equal(s.fim(), null);
  // Mensagem nova do usuário com o objetivo em espera: o lembrete de voltar ao ativo.
  const c = contexto(s.pedido('pode usar azul'));
  assert.match(c, /objetivo em \.revisao\/objetivo\.md está esperando o usuário \(aguardando usuário: escolher a cor\)\. Se esta mensagem destrava o trabalho, volte o Status para "ativo"/);
  s.gravar('# Objetivo\n## Pronto quando\n- a tela abre\n## Status\nativo\n');
  assert.ok(!/esperando o usuário/.test(contexto(s.pedido('e o resto?'))));
  assert.ok(barrou(s.fim()));
});

test('boletim: objetivo de outra sessão depois de resumir, "pronto" e Status em item de lista', () => {
  const { env } = ambiente();
  const raiz = projeto({ mapa: false });
  const BOLETIM = path.join(HOOKS, 'equipe-boletim.mjs');
  const boletim = (source, sid = 'bx') => contexto(rodar(BOLETIM, { hook_event_name: 'SessionStart', session_id: sid, cwd: raiz, source }, env));
  const alvo = path.join(raiz, '.revisao', 'objetivo.md');
  escrever(alvo, '# Objetivo\nPronto quando:\n- `flutter test`\nStatus: pronto\n');
  assert.ok(!/Objetivo/.test(boletim('startup')), '"pronto" é concluído');
  escrever(alvo, '# Objetivo\nPronto quando:\n- `flutter test`\n- Status: aguardando usuário: aprovar o push\n');
  assert.match(boletim('startup'), /\(Status: aguardando usuário: aprovar o push\)/);
  // Resumo numa sessão que não gravou o objetivo: não diz que a trava segue cobrando.
  escrever(alvo, '# Objetivo\nPronto quando:\n- `flutter test`\nStatus: ativo\n');
  let b = boletim('compact');
  assert.ok(!/A trava segue cobrando/.test(b));
  assert.match(b, /a trava só vale na sessão que o gravou/);
  // Na sessão que gravou: segue.
  rodar(POS, { session_id: 'bx', cwd: raiz, tool_name: 'Write', tool_input: { file_path: alvo } }, env);
  b = boletim('compact');
  assert.match(b, /Objetivo desta sessão em \.revisao\/objetivo\.md \(Status: ativo\): releia antes de continuar\. A trava segue cobrando/);
});

test('teste de trava: data longe não desliga, as que seguram a qualidade nunca, e o comando pede o OK', () => {
  const { claude, env } = ambiente();
  const diario = path.join(claude, 'equipe-diario');
  const COMUM = new URL('../hooks/equipe-comum.mjs', import.meta.url).href;
  const desligadas = () => execFileSync(process.execPath, ['--input-type=module', '-e', `import { desligada } from ${JSON.stringify(COMUM)}; console.log(JSON.stringify(['orcamento', 'revisao', 'prova', 'convergencia', 'sobras'].map(desligada)));`], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
  const agora = Date.now();
  escrever(path.join(diario, 'teste-trava.json'), JSON.stringify({ trava: 'orcamento', desde: new Date(agora).toISOString(), ate: new Date(agora + 3 * 86400000).toISOString() }));
  assert.equal(desligadas(), '[true,false,false,false,false]');
  // "ate" daqui a 10 anos, ou um começo velho com o fim longe: não desliga.
  escrever(path.join(diario, 'teste-trava.json'), JSON.stringify({ trava: 'orcamento', desde: new Date(agora).toISOString(), ate: new Date(agora + 3650 * 86400000).toISOString() }));
  assert.equal(desligadas(), '[false,false,false,false,false]');
  // Revisão e prova no arquivo: continuam ligadas.
  for (const trava of ['revisao', 'prova', 'convergencia', 'sobras']) {
    escrever(path.join(diario, 'teste-trava.json'), JSON.stringify({ trava, desde: new Date(agora).toISOString(), ate: new Date(agora + 86400000).toISOString() }));
    assert.equal(desligadas(), '[false,false,false,false,false]', trava);
  }
  // O comando que liga o teste (e quem mexe direto no arquivo) pede o OK do usuário; encerrar não.
  const raiz = projeto({ mapa: false });
  const pre = (command, tool = 'Bash') => rodar(PRE, { hook_event_name: 'PreToolUse', session_id: 'tq', cwd: raiz, tool_name: tool, tool_input: { command } }, env);
  let s = pre('node "/home/x/.claude/hooks/equipe-medir.mjs" --testar-trava orcamento');
  assert.equal(decisao(s), 'ask');
  assert.match(motivo(s), /desligar a trava "orcamento" por 7 dias, em todos os projetos, pede o seu OK/);
  assert.equal(decisao(pre('node "$HOME\\.claude\\hooks\\equipe-medir.mjs" --testar-trava mapa', 'PowerShell')), 'ask');
  assert.equal(decisao(pre('echo {} > ~/.claude/equipe-diario/teste-trava.json')), 'ask');
  assert.equal(pre('node ~/.claude/hooks/equipe-medir.mjs --fim-teste'), null);
  assert.equal(pre('node ~/.claude/hooks/equipe-medir.mjs --retro'), null);
  assert.ok(registro(claude).some((l) => l[1] === 'teste-trava' && l[2] === 'pediu'));
  // Ler, buscar e citar num commit não pedem OK; gravar pelas ferramentas de arquivo, sim.
  assert.equal(pre('cat ~/.claude/equipe-diario/teste-trava.json'), null);
  assert.equal(pre('grep -rn "teste-trava.json" hooks/ README.md'), null);
  assert.equal(pre('git commit -m "medidor: node equipe-medir.mjs --testar-trava e teste-trava.json" -- hooks/equipe-medir.mjs'), null);
  assert.equal(decisao(pre('cd ~ && rm .claude/equipe-diario/teste-trava.json')), 'ask');
  assert.equal(decisao(pre("cat > ~/.claude/equipe-diario/teste-trava.json <<'EOF'\n{}\nEOF")), 'ask');
  assert.equal(decisao(pre('cat modelo.json > ~/.claude/equipe-diario/teste-trava.json')), 'ask');
  assert.equal(decisao(pre('type modelo.json > %USERPROFILE%\\.claude\\equipe-diario\\teste-trava.json', 'PowerShell')), 'ask');
  assert.equal(pre('grep -n trava ~/.claude/equipe-diario/teste-trava.json > /tmp/saida.txt'), null);
  const gravar = (tool_name) => rodar(PRE, { hook_event_name: 'PreToolUse', session_id: 'tq', cwd: raiz, tool_name, tool_input: { file_path: path.join(claude, 'equipe-diario', 'teste-trava.json'), content: '{}' } }, env);
  assert.equal(decisao(gravar('Write')), 'ask');
  assert.equal(decisao(gravar('Edit')), 'ask');
});

test('sobras: comentário que explica o código e saída de programa de linha de comando não avisam', async () => {
  const { sobrasDasLinhas } = await import(new URL('../hooks/equipe-sobras.mjs', import.meta.url).href);
  const avisa = (rel, texto) => sobrasDasLinhas(rel, [{ n: 1, texto }]).length > 0;
  for (const [rel, texto] of [
    ['lib/lista.dart', '  // Remover itens duplicados da lista'],
    ['src/cache.ts', '// apagar o cache antigo antes de gravar'],
    ['src/nome.py', '    # tirar o prefixo do nome'],
    ['db/consulta.sql', '-- temp table com os totais do mês'],
    ['src/app.py', '# Debug mode: liga o log detalhado'],
    ['src/api.ts', '// TODO: remover quando a API v2 sair'],
    ['src/ok.ts', 'const debugMode = false; // debug'],
    ['src/c.c', '#define DEBUG 1'],
    ['bin/cli.mjs', "console.log('Uso: cli <arquivo>');"],
    ['scripts/build.mjs', 'console.log(`Gerado ${n} arquivos`);'],
    ['bin/main.dart', "  print('Uso: app <arquivo>');"],
    ['tool/gerar.dart', "  print('ok');"],
    ['cypress/e2e/login.cy.ts', 'console.log(1)'],
    ['packages/app/bin/main.dart', "  print('uso');"],
    ['packages/app/scripts/build.mjs', 'console.log(1);'],
    ['src/a.ts', 'const s = "use -- para tirar depois";'],
    ['src/a.ts', "const s = 'veja // DEBUG';"],
  ]) assert.equal(avisa(rel, texto), false, `${rel}: ${texto}`);
  for (const [rel, texto] of [
    ['src/a.ts', 'console.log("x");'],
    ['src/a.ts', 'x(); // DEBUG'],
    ['src/a.py', '# TEMP: tirar'],
    ['src/a.ts', '/* DEBUG */ f();'],
    ['src/a.ts', '// remover depois'],
    ['src/a.ts', '// TODO remover antes do commit'],
    ['src/a.ts', '// remove before commit'],
    ['lib/a.dart', '  print(total);'],
    ['src/a.ts', 'debugger;'],
    ['lib/src/tools/conta.dart', '  print(total);'],
    ['src/scripts/app.ts', 'console.log(x);'],
    ['src/a.ts', 'f("x"); // DEBUG'],
  ]) assert.equal(avisa(rel, texto), true, `${rel}: ${texto}`);
  // O que usa o git roda num processo novo, como o hook (o tempo do git conta da partida).
  const SOBRAS = new URL('../hooks/equipe-sobras.mjs', import.meta.url).href;
  const noFilho = (expr, extra = {}) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `import * as m from ${JSON.stringify(SOBRAS)}; console.log(JSON.stringify(${expr}));`], { encoding: 'utf8', env: { ...process.env, ...extra } }));
  // Arquivo com #! fora das pastas de CLI: console.log é a saída dele.
  const raiz = projeto({ mapa: false });
  const r = JSON.stringify(raiz);
  escrever(path.join(raiz, 'src', 'gerar.mjs'), '#!/usr/bin/env node\nconsole.log("ok");\n');
  escrever(path.join(raiz, 'src', 'conta.js'), 'let i = 0;\n');
  git(raiz, 'add', '-A');
  git(raiz, 'commit', '-q', '-m', 'js');
  fs.appendFileSync(path.join(raiz, 'src', 'gerar.mjs'), 'console.log("mais");\n');
  assert.deepEqual(noFilho(`m.sobrasDosArquivos(${r}, ['src/gerar.mjs'])`), []);
  // Linha nova que começa com "++" conta, e a numeração não se desloca.
  fs.appendFileSync(path.join(raiz, 'src', 'conta.js'), '++i;\nconsole.log(i);\n');
  assert.deepEqual(noFilho(`m.linhasNovas(${r}, 'src/conta.js')`), [{ n: 2, texto: '++i;' }, { n: 3, texto: 'console.log(i);' }]);
  assert.deepEqual(noFilho(`m.sobrasDosArquivos(${r}, ['src/conta.js']).map((x) => x.n)`), [3]);
  // Git com erro (sem tempo): nenhuma linha vira sobra, em vez de o arquivo inteiro.
  assert.deepEqual(noFilho(`m.linhasNovas(${r}, 'src/conta.js')`, { EQUIPE_ORCAMENTO_MS: '1' }), []);
});

test('sobras: arquivo com cara de temporário criado por comando aparece na lista do implementador', () => {
  const { env } = ambiente();
  const raiz = projeto({ mapa: false });
  const transcricao = path.join(tmp('tr'), 'agente.jsonl');
  escrever(transcricao, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Objetivo: ajustar\nEscopo: lib/\nCritério de aceite: teste\nComo verificar: flutter test' } })}\n`);
  const base = { session_id: 'tl', cwd: raiz, agent_type: 'implementador', agent_id: 'i1', agent_transcript_path: transcricao };
  rodar(EVENTOS, { ...base, hook_event_name: 'SubagentStart' }, env);
  const arq = path.join(raiz, 'lib', 'a2.dart');
  fs.appendFileSync(arq, 'void h() {}\n');
  rodar(POS, { ...base, tool_name: 'Edit', tool_input: { file_path: arq } }, env);
  fs.writeFileSync(path.join(raiz, 'nul'), '');
  fs.writeFileSync(path.join(raiz, 'saida.log'), 'x');
  rodar(POS, { ...base, tool_name: 'Bash', tool_input: { command: 'flutter test 2>nul > saida.log' } }, env);
  rodar(EVENTOS, { ...base, hook_event_name: 'SubagentStop' }, env);
  const lista = fs.readFileSync(path.join(raiz, '.revisao', 'escopo.md'), 'utf8');
  assert.match(lista, /Sobras de depuração \(2\): nul \(arquivo com cara de temporário\); saida\.log \(arquivo com cara de temporário\)/);
});

test('fim da resposta: sem gravar o registro do fim, só o primeiro da sequência é barrado', () => {
  // O registro do fim anterior não grava (aqui, uma pasta no lugar do arquivo): a revisão barra
  // uma vez e, insistindo, passa, como antes, em vez de barrar todo fim.
  const { claude, env } = ambiente();
  const raiz = projeto({ mapa: false });
  const s = sessaoComObjetivo(raiz, env, 'gx');
  s.pedido('corrija o total');
  s.editar(120);
  s.rodou('flutter test', true);
  fs.mkdirSync(path.join(claude, 'equipe-diario', 'estado', 'gx-sessao.fim-barrado'), { recursive: true });
  const r = [];
  for (let i = 0; i < 4; i++) r.push(barrou(s.fim({ stop_hook_active: i > 0 })));
  assert.deepEqual(r, [true, false, false, false]);
});

test('prova: código novo criado por comando ou gravado por um agente de plugin conta', () => {
  const { env } = ambiente({ EQUIPE_DESLIGAR: 'revisao' });
  const raiz = projeto({ mapa: false });
  const s = sessaoComObjetivo(raiz, env, 'px');
  s.pedido('corrija o total');
  s.editar(2);
  s.rodou('flutter test', true);
  s.rodou('flutter analyze', true);
  assert.equal(s.fim(), null);
  // Um comando (gerador, cp) cria código novo depois do verde: a prova cobra.
  escrever(path.join(raiz, 'lib', 'novo.dart'), 'void quebrado( {}\n');
  rodar(POS, { session_id: 'px', cwd: raiz, tool_name: 'Bash', tool_input: { command: 'dart run gerador' } }, env);
  s.pedido('e o resto?');
  assert.match(s.fim().reason, /o código mudou e não há verificação verde/);
  // Um agente de plugin grava uma tela nova (.html) pelo Write depois do verde: conta como
  // edição da sessão (o .html que só um comando cria, como a cobertura, não conta).
  const { env: e2 } = ambiente({ EQUIPE_DESLIGAR: 'revisao' });
  const r2 = projeto({ mapa: false });
  const s2 = sessaoComObjetivo(r2, e2, 'py');
  s2.pedido('corrija');
  s2.editar(2);
  s2.rodou('flutter test', true);
  s2.rodou('flutter analyze', true);
  escrever(path.join(r2, 'coverage', 'index.html'), '<html>cobertura</html>\n');
  rodar(POS, { session_id: 'py', cwd: r2, tool_name: 'Bash', tool_input: { command: 'flutter test --coverage' } }, e2);
  assert.equal(s2.fim(), null, 'a cobertura gravada pelo comando não conta');
  const novo = path.join(r2, 'web', 'pagina.html');
  escrever(novo, '<html>tela</html>\n');
  rodar(POS, { session_id: 'py', cwd: r2, tool_name: 'Write', tool_input: { file_path: novo }, agent_type: 'meu-plugin:dev', agent_id: 'p1' }, e2);
  s2.pedido('e agora?');
  assert.match(s2.fim().reason, /o código mudou e não há verificação verde/);
});
