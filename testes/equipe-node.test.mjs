// Testes dos scripts da equipe em Node: hooks de início de sessão e de subagente, e o
// medidor da /retro-equipe. Rodam no Windows (CI) e em qualquer sistema com Node 20+ e git:
//   node --test testes/equipe-node.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOOKS = fileURLToPath(new URL('../hooks/', import.meta.url));
const BOLETIM = path.join(HOOKS, 'equipe-boletim.mjs');
const CONTEXTO = path.join(HOOKS, 'equipe-contexto.mjs');
const MEDIR = path.join(HOOKS, 'equipe-medir.mjs');
const GUARDA = path.join(HOOKS, 'guarda-comandos.ps1');

const tmp = (nome) => fs.mkdtempSync(path.join(os.tmpdir(), `equipe-${nome}-`));
const escrever = (arquivo, texto) => {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, texto);
};
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@exemplo.com', '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// Pasta do Claude falsa: sem rede, sem sessões, sem retro.
const claudeVazio = tmp('claude');

function rodar(script, entrada, env = {}) {
  const saida = execFileSync(process.execPath, [script], {
    input: typeof entrada === 'string' ? entrada : JSON.stringify(entrada),
    encoding: 'utf8',
    env: { ...process.env, EQUIPE_SEM_REDE: '1', EQUIPE_PASTA_CLAUDE: claudeVazio, CLAUDE_PROJECT_DIR: '', ...env },
  });
  if (!saida.trim()) return '';
  const j = JSON.parse(saida);
  return j.hookSpecificOutput.additionalContext;
}

// Projeto Flutter com backend Supabase, 60 arquivos de código, nota de área e lista do verificador.
function projetoGrande() {
  const raiz = tmp('projeto');
  git(raiz, 'init', '-q');
  for (let i = 0; i < 60; i++) escrever(path.join(raiz, 'lib', `arquivo${i}.dart`), `// ${i}\n`);
  escrever(path.join(raiz, 'lib', 'gerado.g.dart'), '// gerado\n');
  escrever(path.join(raiz, 'pubspec.yaml'), 'name: app\n');
  escrever(path.join(raiz, 'supabase', 'config.toml'), 'project_id = "x"\n');
  escrever(path.join(raiz, 'lib', 'auth', 'CLAUDE.md'), '# Auth\n');
  escrever(path.join(raiz, 'CLAUDE.md'), [
    '# CLAUDE.md', '', '## Comandos', '', '- Testar tudo: `flutter test`', '',
    '## Regras deste projeto', '', '- Produção: projeto abc no Supabase.', '- <outras regras próprias deste projeto>', '',
    '## Notas de área', '', '- `lib/auth`: login', '',
  ].join('\n'));
  escrever(path.join(raiz, '.claude', 'verificador-comandos.txt'), '# comentário\nflutter test\nflutter analyze\n');
  git(raiz, 'add', '-A');
  git(raiz, 'commit', '-q', '-m', 'inicio');
  return raiz;
}

test('contexto do Explore: mapa obrigatório, indexação, apoio e notas de área', () => {
  const raiz = projetoGrande();
  const t = rodar(CONTEXTO, { agent_type: 'Explore', cwd: path.join(raiz, 'lib') });
  assert.match(t, /60 arquivos de código, 2 módulos/);
  assert.match(t, /obrigatório neste projeto/);
  assert.ok(t.includes(`index_repository em ${git(raiz, 'rev-parse', '--show-toplevel')}`));
  assert.match(t, /apoio-local/);
  assert.match(t, /lib\/auth\/CLAUDE\.md/);
});

test('contexto do revisor: regras do projeto sem as linhas do modelo', () => {
  const raiz = projetoGrande();
  const t = rodar(CONTEXTO, { agent_type: 'revisor', cwd: raiz });
  assert.match(t, /Produção: projeto abc no Supabase/);
  assert.doesNotMatch(t, /outras regras próprias/);
  assert.match(t, /detect_changes/);
});

test('contexto do verificador: comandos da lista e estado do commit', () => {
  const raiz = projetoGrande();
  let t = rodar(CONTEXTO, { agent_type: 'verificador', cwd: raiz });
  assert.match(t, /- flutter test/);
  assert.match(t, /- flutter analyze/);
  assert.match(t, /\(em commit\)/);
  assert.doesNotMatch(t, /comentário/);
  fs.appendFileSync(path.join(raiz, '.claude', 'verificador-comandos.txt'), 'rm -rf build\n');
  t = rodar(CONTEXTO, { agent_type: 'verificador', cwd: raiz });
  assert.match(t, /fora de commit/);
});

test('contexto: implementador e agentes de fora não recebem nada; entrada inválida não quebra', () => {
  const raiz = projetoGrande();
  assert.equal(rodar(CONTEXTO, { agent_type: 'implementador', cwd: raiz }), '');
  assert.equal(rodar(CONTEXTO, { agent_type: 'general-purpose', cwd: raiz }), '');
  assert.equal(rodar(CONTEXTO, 'isto não é json'), '');
  assert.equal(rodar(CONTEXTO, ''), '');
});

test('boletim: projeto configurado, módulos, verificador e notas', () => {
  const raiz = projetoGrande();
  const t = rodar(BOLETIM, { cwd: raiz, source: 'startup' });
  assert.match(t, /obrigatório aqui/);
  assert.match(t, /2 módulos \(\., supabase\)/);
  assert.match(t, /Verificador: 2 comando\(s\)/);
  assert.match(t, /Notas de área: lib\/auth\/CLAUDE\.md/);
  assert.doesNotMatch(t, /Projeto sem configuração/);
});

test('boletim: projeto pequeno sem configuração', () => {
  const raiz = tmp('pequeno');
  git(raiz, 'init', '-q');
  escrever(path.join(raiz, 'main.py'), 'print(1)\n');
  const t = rodar(BOLETIM, { cwd: raiz, source: 'startup' });
  assert.match(t, /1 arquivos de código\. Projeto pequeno/);
  assert.match(t, /não tem CLAUDE\.md/);
  assert.match(t, /Falta \.claude\/verificador-comandos\.txt/);
});

test('boletim: plano em andamento e conversa compactada', () => {
  const raiz = projetoGrande();
  escrever(path.join(raiz, '.revisao', 'plano.md'), '# Plano\n- [x] passo 1\n- [ ] passo 2\n');
  let t = rodar(BOLETIM, { cwd: raiz, source: 'startup' });
  assert.match(t, /1 de 2 passos marcados como feitos/);
  t = rodar(BOLETIM, { cwd: raiz, source: 'compact' });
  assert.match(t, /compactada: releia o plano/);
});

test('boletim: fora de um repositório git, nada', () => {
  assert.equal(rodar(BOLETIM, { cwd: tmp('solto'), source: 'startup' }), '');
});

test('boletim: avisa versão nova da equipe só quando a instalada ficou para trás', () => {
  const raiz = projetoGrande();
  const equipe = tmp('equipe');
  git(equipe, 'init', '-q');
  escrever(path.join(equipe, 'a.txt'), '1');
  git(equipe, 'add', '-A');
  git(equipe, 'commit', '-q', '-m', 'um');
  const c1 = git(equipe, 'rev-parse', 'HEAD');
  escrever(path.join(equipe, 'a.txt'), '2');
  git(equipe, 'commit', '-q', '-am', 'dois');
  const c2 = git(equipe, 'rev-parse', 'HEAD');
  git(equipe, 'update-ref', 'refs/remotes/origin/main', c2);

  const claude = tmp('claude-versao');
  escrever(path.join(claude, 'equipe-versao.json'), JSON.stringify({ commit: c1, pasta: equipe }));
  let t = rodar(BOLETIM, { cwd: raiz, source: 'startup' }, { EQUIPE_PASTA_CLAUDE: claude });
  assert.match(t, new RegExp(`versão nova da equipe no GitHub \\(instalada ${c1.slice(0, 7)}, disponível ${c2.slice(0, 7)}\\)`));
  t = rodar(BOLETIM, { cwd: raiz, source: 'compact' }, { EQUIPE_PASTA_CLAUDE: claude });
  assert.doesNotMatch(t, /versão nova/);
  escrever(path.join(claude, 'equipe-versao.json'), JSON.stringify({ commit: c2, pasta: equipe }));
  t = rodar(BOLETIM, { cwd: raiz, source: 'startup' }, { EQUIPE_PASTA_CLAUDE: claude });
  assert.doesNotMatch(t, /versão nova/);
});

test('boletim: lembra a retrospectiva depois de 10 sessões e some depois dela', () => {
  const raiz = projetoGrande();
  const claude = tmp('claude-retro');
  for (let i = 0; i < 10; i++) escrever(path.join(claude, 'projects', 'p', `s${i}.jsonl`), '{}\n');
  let t = rodar(BOLETIM, { cwd: raiz, source: 'startup' }, { EQUIPE_PASTA_CLAUDE: claude });
  assert.match(t, /Retrospectiva da equipe: nunca foi feita, e houve 10 sessões/);
  escrever(path.join(claude, 'equipe-diario', 'ultima-retro.json'), JSON.stringify({ data: new Date().toISOString() }));
  t = rodar(BOLETIM, { cwd: raiz, source: 'startup' }, { EQUIPE_PASTA_CLAUDE: claude });
  assert.doesNotMatch(t, /Retrospectiva/);
});

// ---------- medidor ----------

const agora = Date.now();
const iso = (minutos) => new Date(agora - 60 * 60000 + minutos * 60000).toISOString();
const linha = (o) => JSON.stringify(o);

function sessoesFalsas() {
  const claude = tmp('claude-medir');
  const projetos = path.join(claude, 'projects');
  const sid = 'sessao-1';
  const cwd = path.join(os.tmpdir(), 'meu-app');
  const uso = (input, output, cacheRead = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 });
  // Parte 1 da sessão (primeira pasta de projeto).
  escrever(path.join(projetos, '-pasta-a', `${sid}.jsonl`), [
    linha({ type: 'user', uuid: 'u0', timestamp: iso(0), cwd, message: { role: 'user', content: 'meu pedido com SEGREDO-123' } }),
    linha({ type: 'assistant', uuid: 'a1', timestamp: iso(1), cwd, message: { id: 'm1', model: 'claude-opus-5-5', usage: uso(10, 100, 1000), content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { subagent_type: 'Explore', model: 'sonnet', prompt: 'SEGREDO-123' } }] } }),
    // Mesmo id de mensagem em outra linha (outro bloco): o uso não pode contar duas vezes.
    linha({ type: 'assistant', uuid: 'a1b', timestamp: iso(1), cwd, message: { id: 'm1', model: 'claude-opus-5-5', usage: uso(10, 100, 1000), content: [{ type: 'text', text: 'texto do mestre SEGREDO-123' }] } }),
    linha({ type: 'user', uuid: 'u1', timestamp: iso(3), cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'relatório' }] }, toolUseResult: { agentId: 'a1' } }),
    linha({ type: 'assistant', uuid: 'a2', timestamp: iso(4), cwd, message: { id: 'm2', model: 'claude-opus-5-5', usage: uso(0, 0), content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: {} }] } }),
    linha({ type: 'user', uuid: 'u2', timestamp: iso(9), cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } }),
    linha({ type: 'system', uuid: 's1', subtype: 'compact_boundary', timestamp: iso(10), cwd, compactMetadata: { trigger: 'auto', preTokens: 500000 } }),
    linha({ type: 'cost-state', sessionId: sid, totalCostUSD: 1.23, startTime: agora - 2 * 3600000 }),
  ].join('\n') + '\n');
  // Parte 2 da mesma sessão (a pasta do projeto mudou).
  escrever(path.join(projetos, '-pasta-b', `${sid}.jsonl`), [
    linha({ type: 'assistant', uuid: 'a3', timestamp: iso(20), cwd, message: { id: 'm3', model: 'claude-opus-5-5', usage: uso(0, 0), content: [{ type: 'tool_use', id: 't3', name: 'AskUserQuestion', input: {} }, { type: 'tool_use', id: 't4', name: 'Read', input: {} }] } }),
    linha({ type: 'user', uuid: 'u3', timestamp: iso(22), cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'resposta' }, { type: 'tool_result', tool_use_id: 't4', content: 'Bloqueado pela guarda (explore): citado num arquivo lido' }] } }),
    linha({ type: 'user', uuid: 'u4', timestamp: iso(23), cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tx', is_error: true, content: "The user doesn't want to proceed with this tool use. The tool use was rejected." }] } }),
  ].join('\n') + '\n');
  // Subagentes da sessão.
  const sub = path.join(projetos, '-pasta-a', sid, 'subagents');
  escrever(path.join(sub, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore' }));
  escrever(path.join(sub, 'agent-a1.jsonl'), [
    linha({ type: 'assistant', uuid: 'e1', isSidechain: true, timestamp: iso(1), message: { id: 'x1', model: 'claude-haiku-5-5', usage: uso(150000, 50), content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: {} }, { type: 'tool_use', id: 'b2', name: 'mcp__codebase-memory__search_graph', input: {} }] } }),
    linha({ type: 'user', uuid: 'e2', isSidechain: true, timestamp: iso(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', is_error: true, content: 'PreToolUse:Bash hook error: Bloqueado pela guarda (explore): sem pipe, redirecionamento.")' }, { type: 'tool_result', tool_use_id: 'b2', content: '[]' }] } }),
    linha({ type: 'assistant', uuid: 'e3', isSidechain: true, timestamp: iso(3), message: { id: 'x2', model: 'claude-haiku-5-5', usage: uso(1000, 50), content: [{ type: 'text', text: 'Resposta com SEGREDO-123. Ferramentas: usei o mapa.' }] } }),
  ].join('\n') + '\n');
  escrever(path.join(sub, 'agent-a2.meta.json'), JSON.stringify({ agentType: 'revisor' }));
  escrever(path.join(sub, 'agent-a2.jsonl'), [
    linha({ type: 'assistant', uuid: 'r1', isSidechain: true, timestamp: iso(5), message: { id: 'y1', model: 'claude-sonnet-5-5', usage: uso(2000, 300), content: [{ type: 'text', text: '- **Veredito**: REPROVADO\n- Achados: SEGREDO-123' }] } }),
  ].join('\n') + '\n');
  // Sessão antiga, fora do período.
  const velho = path.join(projetos, '-pasta-a', 'velha.jsonl');
  escrever(velho, linha({ type: 'assistant', uuid: 'v1', timestamp: new Date(agora - 30 * 86400000).toISOString(), cwd, message: { id: 'v', model: 'claude-opus-5-5', usage: uso(1, 1), content: [] } }) + '\n');
  const antigo = new Date(agora - 30 * 86400000);
  fs.utimesSync(velho, antigo, antigo);
  return { claude, projetos };
}

function medir(claude, ...args) {
  return execFileSync(process.execPath, [MEDIR, ...args], {
    encoding: 'utf8', env: { ...process.env, EQUIPE_PASTA_CLAUDE: claude },
  });
}

test('medidor: junta a sessão espalhada, deduplica o uso e lê só os sinais certos', () => {
  const { claude } = sessoesFalsas();
  const r = JSON.parse(medir(claude, '--json', '--dias', '7'));
  assert.equal(r.sessoes, 1);
  assert.ok(Math.abs(r.custo.mestre - (10 * 4 + 100 * 20 + 1000 * 0.2) / 1e6) < 1e-9, `custo do mestre ${r.custo.mestre}`);
  assert.equal(r.custo.registradoPeloClaudeCode, 1.23);
  assert.equal(r.porTipo.Explore.chamadas, 1);
  assert.equal(r.porTipo.Explore.consultouMapa, 1);
  assert.equal(r.porTipo.Explore.passosAcima100k, 1);
  assert.equal(r.porTipo.revisor.status.reprovado, 1);
  assert.deepEqual(r.bloqueios, { 'explore: sem pipe, redirecionamento.': 1 });
  // Sessão sem os campos de decisão (versão antiga): espera estimada pela demora.
  assert.equal(r.aprovacoes.Edit.vezes, 1);
  assert.equal(r.estimado, true);
  assert.equal(r.perguntas, 1);
  assert.equal(r.recusas, 1);
  assert.equal(r.compactacoes, 1);
  assert.deepEqual(r.subidas, { 'Explore em sonnet': 1 });
  assert.equal(r.mestre.leituras, 1);
});

test('medidor: nada do conteúdo das conversas vai para a saída', () => {
  const { claude } = sessoesFalsas();
  assert.doesNotMatch(medir(claude, '--dias', '7'), /SEGREDO/);
  assert.doesNotMatch(medir(claude, '--json', '--dias', '7'), /SEGREDO/);
});

test('medidor: retrospectiva guarda a base, compara e mostra as propostas da anterior', () => {
  const { claude } = sessoesFalsas();
  let t = medir(claude, '--retro');
  assert.match(t, /Primeira retrospectiva/);
  const estado = () => JSON.parse(fs.readFileSync(path.join(claude, 'equipe-diario', 'ultima-retro.json'), 'utf8'));
  assert.ok(fs.existsSync(estado().pendente.medicao), 'a medição fica pendente até as propostas');
  assert.equal(estado().data, undefined, 'sem propostas, a retrospectiva não está concluída');
  const propostas = path.join(tmp('propostas'), 'retro-propostas.md');
  escrever(propostas, '1. Dividir as perguntas do Explore. Indicador: tokens por chamada.\n');
  medir(claude, '--guardar-propostas', propostas);
  assert.ok(fs.existsSync(estado().medicao), 'com as propostas, a medição vira a base');
  assert.equal(estado().pendente, null);
  t = medir(claude, '--retro');
  assert.match(t, /Desde a última retrospectiva/);
  assert.match(t, /\| Custo por sessão \|/);
  assert.match(t, /Dividir as perguntas do Explore/);
  t = medir(claude, '--ultima');
  assert.match(t, /Última retrospectiva/);
});

test('medidor: sem sessões, diz onde procurou', () => {
  const claude = tmp('claude-sem');
  assert.match(medir(claude), /Nenhuma sessão encontrada/);
});

test('comparação marca o que melhorou e o que piorou', async () => {
  // No Windows, import() precisa de URL file://, não de caminho com letra de unidade.
  const { comparacao } = await import(pathToFileURL(MEDIR).href);
  const t = comparacao({ custo_por_sessao: 2, explore_mapa_pct: 10 }, { custo_por_sessao: 1, explore_mapa_pct: 5 });
  assert.match(t, /Custo por sessão \| US\$ 2,00 \| US\$ 1,00 \| melhorou/);
  assert.match(t, /consultaram o mapa \| 10% \| 5% \| piorou/);
});


// ---------- concordância com a guarda e casos que a revisão apontou ----------

function powershell() {
  for (const exe of process.platform === 'win32' ? ['powershell', 'pwsh'] : ['pwsh']) {
    const r = spawnSync(exe, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' });
    if (r.status === 0) return exe;
  }
  return null;
}
const PS = powershell();

function guardaLibera(cwd, projeto, comando) {
  const r = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', GUARDA, '-Perfil', 'verificador'], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: comando }, cwd }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: projeto },
    encoding: 'utf8',
  });
  return r.status === 0;
}

test('hook e guarda concordam: projeto numa subpasta do repositório', { skip: !PS && 'sem PowerShell' }, () => {
  const repo = tmp('mono');
  git(repo, 'init', '-q');
  const app = path.join(repo, 'app');
  for (let i = 0; i < 3; i++) escrever(path.join(app, 'lib', `a${i}.dart`), '//\n');
  escrever(path.join(app, 'CLAUDE.md'), '## Comandos\n\n- Testar: `flutter test`\n\n## Regras deste projeto\n\n- Produção: projeto XYZ.\n');
  escrever(path.join(app, '.claude', 'verificador-comandos.txt'), 'flutter test\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'x');
  assert.equal(guardaLibera(app, app, 'flutter test'), true, 'a guarda deveria liberar');
  const env = { CLAUDE_PROJECT_DIR: app };
  const v = rodar(CONTEXTO, { agent_type: 'verificador', cwd: app }, env);
  assert.match(v, /- flutter test/);
  assert.match(v, /\(em commit\)/);
  const b = rodar(BOLETIM, { cwd: app, source: 'startup' }, env);
  assert.doesNotMatch(b, /não tem CLAUDE\.md|Projeto sem configuração/);
  assert.match(rodar(CONTEXTO, { agent_type: 'revisor', cwd: app }, env), /Produção: projeto XYZ/);
});

test('hook e guarda concordam: .claude/ no .gitignore', { skip: !PS && 'sem PowerShell' }, () => {
  const raiz = tmp('ignorado');
  git(raiz, 'init', '-q');
  escrever(path.join(raiz, '.gitignore'), '.claude/\n');
  escrever(path.join(raiz, 'main.py'), 'print(1)\n');
  escrever(path.join(raiz, '.claude', 'verificador-comandos.txt'), 'pytest\n');
  git(raiz, 'add', '-A');
  git(raiz, 'commit', '-q', '-m', 'x');
  assert.equal(guardaLibera(raiz, raiz, 'pytest'), true, 'a guarda deveria liberar');
  const v = rodar(CONTEXTO, { agent_type: 'verificador', cwd: raiz }, { CLAUDE_PROJECT_DIR: raiz });
  assert.match(v, /- pytest/);
  assert.match(v, /\(em commit\)/);
  // Lista nova, fora do git e não ignorada: os dois bloqueiam.
  const outro = tmp('naoignorado');
  git(outro, 'init', '-q');
  escrever(path.join(outro, 'main.py'), 'print(1)\n');
  escrever(path.join(outro, '.claude', 'verificador-comandos.txt'), 'pytest\n');
  assert.equal(guardaLibera(outro, outro, 'pytest'), false, 'a guarda deveria bloquear');
  assert.match(rodar(CONTEXTO, { agent_type: 'verificador', cwd: outro }, { CLAUDE_PROJECT_DIR: outro }), /fora de commit/);
});

test('notas de área: pastas de exemplo e modelos sem preencher ficam de fora', () => {
  const raiz = tmp('notas');
  git(raiz, 'init', '-q');
  escrever(path.join(raiz, 'a.js'), '//\n');
  escrever(path.join(raiz, 'lib', 'pagamento', 'CLAUDE.md'), '# Pagamento\n\n## Armadilhas\n\n- o valor vem em centavos.\n');
  escrever(path.join(raiz, 'exemplos', 'app', 'CLAUDE.md'), '# Exemplo\n');
  escrever(path.join(raiz, 'projeto', 'CLAUDE.md'), '# CLAUDE.md\n\n- O que é: <uma frase>\n');
  git(raiz, 'add', '-A');
  git(raiz, 'commit', '-q', '-m', 'x');
  const t = rodar(BOLETIM, { cwd: raiz, source: 'startup' });
  assert.match(t, /Notas de área: lib\/pagamento\/CLAUDE\.md\./);
  assert.doesNotMatch(t, /exemplos\/app|projeto\/CLAUDE/);
});

test('sem tempo para o git, os hooks saem em silêncio e rápido', () => {
  const raiz = projetoGrande();
  const inicio = Date.now();
  assert.equal(rodar(BOLETIM, { cwd: raiz, source: 'startup' }, { EQUIPE_ORCAMENTO_MS: '1' }), '');
  assert.equal(rodar(CONTEXTO, { agent_type: 'Explore', cwd: raiz }, { EQUIPE_ORCAMENTO_MS: '1' }), '');
  assert.ok(Date.now() - inicio < 5000, 'demorou demais');
});

function sessaoComDecisoes() {
  const claude = tmp('claude-decisoes');
  const cwd = path.join(os.tmpdir(), 'outro-app');
  const uso = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const assistente = (uuid, min, id, nome) => linha({ type: 'assistant', uuid, timestamp: iso(min), cwd, message: { id: `m-${uuid}`, model: 'claude-opus-5-5', usage: uso, content: [{ type: 'tool_use', id, name: nome, input: {} }] } });
  const resultado = (uuid, min, id, extra, conteudo = 'ok', erro = false) => linha({ type: 'user', uuid, timestamp: iso(min), cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: conteudo, is_error: erro }] }, ...extra });
  escrever(path.join(claude, 'projects', '-novo', 's2.jsonl'), [
    assistente('a1', 0, 't1', 'WebFetch'),
    resultado('u1', 3, 't1', { permissionDecision: { decision: 'accept', source: 'user_temporary', reasonType: 'rule' } }),
    assistente('a2', 4, 't2', 'Bash'),
    resultado('u2', 4, 't2', { toolDenialKind: 'automode-blocked', permissionDecision: { decision: 'reject', source: 'config', reasonType: 'classifier' } }, 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: x', true),
    assistente('a3', 5, 't3', 'Edit'),
    resultado('u3', 9, 't3', { toolDenialKind: 'user-rejected' }, "The user doesn't want to proceed with this tool use.", true),
    assistente('a4', 10, 't4', 'Bash'),
    resultado('u4', 10, 't4', { permissionDecision: { decision: 'accept', source: 'config', reasonType: 'rule' } }, 'git@github.com: Permission denied (publickey).', true),
    assistente('a5', 11, 't5', 'Bash'),
    resultado('u5', 11, 't5', {}, "PreToolUse:Bash hook error: Bloqueado pela guarda (verificador): comando 'rm -rf segredo' fora da lista.", true),
  ].join('\n') + '\n');
  return claude;
}

test('medidor: usa os campos de decisão da sessão (aprovação, modo Auto, recusa)', () => {
  const claude = sessaoComDecisoes();
  const r = JSON.parse(medir(claude, '--json'));
  assert.deepEqual(Object.keys(r.aprovacoes), ['WebFetch']);
  assert.equal(r.aprovacoes.WebFetch.vezes, 1);
  assert.equal(Math.round(r.aprovacoes.WebFetch.segundos), 180);
  assert.deepEqual(r.barrados, { Bash: 1 });
  assert.equal(r.recusas, 1, 'o "Permission denied (publickey)" do git não é recusa');
  assert.equal(r.estimado, false);
});

test('medidor: o motivo do bloqueio da guarda sai sem o que estava entre aspas', () => {
  const claude = sessaoComDecisoes();
  const t = medir(claude);
  assert.match(t, /verificador: comando '…' fora da lista/);
  assert.doesNotMatch(t, /segredo/);
});

test('medidor: status do verificador pelo número de falhas', async () => {
  const claude = tmp('claude-verif');
  const dir = path.join(claude, 'projects', '-p');
  escrever(path.join(dir, 's.jsonl'), linha({ type: 'assistant', uuid: 'x', timestamp: iso(0), cwd: '/p', message: { id: 'mx', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [] } }) + '\n');
  const relatorios = { v1: '42 passed, 0 failed', v2: 'flutter test: 3 falharam', v3: 'Nenhum teste falhou.', v4: 'O teste de login falhou.' };
  for (const [id, texto] of Object.entries(relatorios)) {
    escrever(path.join(dir, 's', 'subagents', `agent-${id}.meta.json`), JSON.stringify({ agentType: 'verificador' }));
    escrever(path.join(dir, 's', 'subagents', `agent-${id}.jsonl`), linha({ type: 'assistant', uuid: id, isSidechain: true, timestamp: iso(1), message: { id: `m${id}`, model: 'claude-haiku-5-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: texto }] } }) + '\n');
  }
  const r = JSON.parse(medir(claude, '--json'));
  assert.deepEqual(r.porTipo.verificador.status, { passou: 2, 'com falha': 2 });
});

// Agente em segundo plano: o resultado da chamada só avisa que o relatório foi entregue como
// mensagem; o texto está na fila da sessão principal (anexo e linha "enqueue", mesmo texto).
function mensagemDeRelatorio(agente, relatorio) {
  const cabecalho = '[Subagent hand-back] Este agente terminou. Texto fixo do cabeçalho, com a palavra status e veredito: aprovado. The report follows:\n';
  return '<agent-message from="' + agente + '">\n' + cabecalho + relatorio.split('\n').map((l) => '  ' + l).join('\n');
}

test('medidor: lê o relatório de agente em segundo plano pela mensagem na fila da sessão', () => {
  const claude = tmp('claude-handback');
  const dir = path.join(claude, 'projects', '-p');
  const cwd = path.join(os.tmpdir(), 'app-fila');
  const uso = { input_tokens: 1, output_tokens: 1 };
  const chamada = (uuid, min, id, tipo) => linha({ type: 'assistant', uuid, timestamp: iso(min), cwd, message: { id: 'm' + uuid, model: 'claude-opus-5-5', usage: uso, content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: tipo } }] } });
  const aviso = (uuid, min, id, agente) => linha({ type: 'user', uuid, timestamp: iso(min), cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'This agent\'s report was delivered to you as a message from "' + agente + '" (its SubagentHandback call).' }] }, toolUseResult: { agentId: agente } });
  const entrega = (uuid, min, texto) => [
    linha({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(min), content: texto }),
    linha({ type: 'attachment', uuid, timestamp: iso(min), cwd, attachment: { type: 'queued_command', prompt: texto } }),
  ];
  escrever(path.join(dir, 's.jsonl'), [
    chamada('c1', 0, 't1', 'implementador'),
    chamada('c2', 0, 't2', 'revisor'),
    aviso('r1', 2, 't1', 'agimpl'),
    aviso('r2', 2, 't2', 'agrev'),
    ...entrega('q1', 3, mensagemDeRelatorio('agimpl', '- **Status**: feito com ressalvas\n- Arquivos: um.txt')),
    // O revisor foi retomado: vale o último relatório. Depois dele, mensagens que não são
    // relatório (sem o marcador de hand-back, ou sem "The report follows:") não podem trocá-lo.
    ...entrega('q2', 4, mensagemDeRelatorio('agrev', '- Veredito: aprovado')),
    ...entrega('q3', 5, mensagemDeRelatorio('agrev', 'Veredito: reprovado\nAchados: nenhum')),
    ...entrega('q4', 6, '<agent-message from="agrev">\nconversa comum, sem relatório. Veredito: aprovado\n'),
    ...entrega('q5', 7, '<agent-message from="agrev">\n[Subagent hand-back] cabeçalho novo, sem o marcador. Veredito: aprovado\n'),
  ].join('\n') + '\n');
  // Só o implementador é achado pelo mapa de agentes da sessão; o revisor, pelo .meta.json.
  // Os dois arquivos de agente não têm status no último texto (o relatório não passa por ali).
  const sub = path.join(dir, 's', 'subagents');
  for (const id of ['agimpl', 'agrev']) {
    if (id === 'agrev') escrever(path.join(sub, 'agent-agrev.meta.json'), JSON.stringify({ agentType: 'revisor' }));
    escrever(path.join(sub, 'agent-' + id + '.jsonl'), linha({ type: 'assistant', uuid: 'x' + id, isSidechain: true, timestamp: iso(1), message: { id: 'mx' + id, model: 'claude-sonnet-5-5', usage: uso, content: [{ type: 'text', text: 'Terminei, o relatório vai por mensagem.' }] } }) + '\n');
  }
  const r = JSON.parse(medir(claude, '--json'));
  assert.deepEqual(r.porTipo.implementador.status, { 'feito com ressalvas': 1 });
  assert.deepEqual(r.porTipo.revisor.status, { reprovado: 1 });
  assert.doesNotMatch(medir(claude), /um\.txt|Achados/);
});

// Formato atual do Claude Code: o subagente termina chamando SubagentHandback com o relatório
// em "message" (primeiro e segundo plano). O último texto do agente não é o relatório.
test('medidor: lê o status do relatório entregue pelo SubagentHandback', () => {
  const claude = tmp('claude-entrega');
  const dir = path.join(claude, 'projects', '-p');
  const uso = { input_tokens: 1, output_tokens: 1 };
  escrever(path.join(dir, 's.jsonl'), linha({ type: 'assistant', uuid: 'x', timestamp: iso(0), cwd: '/p', message: { id: 'mx', model: 'claude-opus-5-5', usage: uso, content: [] } }) + '\n');
  const sub = path.join(dir, 's', 'subagents');
  let n = 0;
  const texto = (min, t) => linha({ type: 'assistant', uuid: `t${++n}`, isSidechain: true, timestamp: iso(min), message: { id: `mt${n}`, model: 'claude-sonnet-5-5', usage: uso, content: [{ type: 'text', text: t }] } });
  const entrega = (min, relatorio) => [
    linha({ type: 'assistant', uuid: `e${++n}`, isSidechain: true, timestamp: iso(min), message: { id: `me${n}`, model: 'claude-sonnet-5-5', usage: uso, content: [{ type: 'tool_use', id: `h${n}`, name: 'SubagentHandback', input: { message: relatorio } }] } }),
    linha({ type: 'user', uuid: `u${n}`, isSidechain: true, timestamp: iso(min), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `h${n}`, content: [{ type: 'text', text: '{"success":true,"message":"Report delivered to your caller."}' }] }] } }),
  ];
  const agentes = {
    // O texto intermediário cita outro status; vale o da entrega.
    imp: ['implementador', [texto(1, 'Vou rodar os testes. Status: parcial por enquanto.'), ...entrega(2, '- **Status**: feito\n- Arquivos: SEGREDO-imp.txt')]],
    // Revisor retomado: entregou duas vezes, vale a última.
    rev: ['revisor', [...entrega(1, '- **Veredito**: REPROVADO\n- Achados: SEGREDO-rev'), ...entrega(3, '- **Veredito**: APROVADO COM RESSALVAS')]],
    ver: ['verificador', [texto(1, 'Rodando a lista.'), ...entrega(2, 'flutter test: 41 passed, 2 failed')]],
    // Sem entrega nem texto: não pode virar "passou".
    mudo: ['verificador', [linha({ type: 'assistant', uuid: 'm1', isSidechain: true, timestamp: iso(1), message: { id: 'mm1', model: 'claude-haiku-5-5', usage: uso, content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'flutter test' } }] } })]],
  };
  for (const [id, [tipo, linhas]] of Object.entries(agentes)) {
    escrever(path.join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType: tipo }));
    escrever(path.join(sub, `agent-${id}.jsonl`), linhas.join('\n') + '\n');
  }
  const r = JSON.parse(medir(claude, '--json'));
  assert.deepEqual(r.porTipo.implementador.status, { feito: 1 });
  assert.deepEqual(r.porTipo.revisor.status, { 'aprovado com ressalvas': 1 });
  assert.deepEqual(r.porTipo.verificador.status, { 'com falha': 1, 'sem status': 1 });
  assert.doesNotMatch(medir(claude), /SEGREDO/);
});

test('medidor: repetir a retrospectiva não apaga a base nem as propostas', () => {
  const { claude } = sessoesFalsas();
  medir(claude, '--retro');
  const propostas = path.join(tmp('prop'), 'p.md');
  escrever(propostas, 'Proposta A. Indicador: tokens.\n');
  medir(claude, '--guardar-propostas', propostas);
  const estado1 = JSON.parse(fs.readFileSync(path.join(claude, 'equipe-diario', 'ultima-retro.json'), 'utf8'));
  // Outra rodada com outro período e outra sem guardar propostas: a base continua.
  let t = medir(claude, '--retro', '--dias', '3');
  assert.match(t, /usou outro período ou outro projeto/);
  assert.match(t, /Proposta A/);
  t = medir(claude, '--retro');
  assert.match(t, /Desde a última retrospectiva/);
  assert.match(t, /Proposta A/);
  const estado2 = JSON.parse(fs.readFileSync(path.join(claude, 'equipe-diario', 'ultima-retro.json'), 'utf8'));
  assert.equal(estado2.medicao, estado1.medicao);
  assert.equal(estado2.propostas, estado1.propostas);
  assert.ok(estado2.pendente && estado2.pendente.medicao !== estado1.medicao);
});

test('medidor: roda também quando chamado por um atalho (symlink)', (t) => {
  const pasta = tmp('atalho');
  const atalho = path.join(pasta, 'hooks');
  try {
    fs.symlinkSync(HOOKS, atalho, 'junction');
  } catch {
    t.skip('sem permissão para criar atalho');
    return;
  }
  const saida = execFileSync(process.execPath, [path.join(atalho, 'equipe-medir.mjs')], {
    encoding: 'utf8', env: { ...process.env, EQUIPE_PASTA_CLAUDE: tmp('claude-atalho') },
  });
  assert.match(saida, /Nenhuma sessão encontrada/);
});

// ---------- hook de SQL: leitura não vai pela conexão que escreve ----------
const SQL = path.join(HOOKS, 'equipe-sql.mjs');

// Roda um hook de decisão (PreToolUse) e devolve o JSON da saída, ou null se ficou calado.
function decisao(script, entrada, env = {}) {
  const r = spawnSync(process.execPath, [script], {
    input: typeof entrada === 'string' ? entrada : JSON.stringify(entrada),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: '', ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

test('sql: separa consulta só de leitura do resto', async () => {
  const { somenteLeitura } = await import(pathToFileURL(SQL).href);
  const leitura = [
    'select * from pedidos',
    "  SELECT count(*) FROM pedidos WHERE status = 'delete' -- update depois\n",
    'with x as (select 1 as a) select * from x',
    'explain select * from t',
    "select jsonb_set(dados, '{a}', '1') from t",
    '/* insert */ select 1; select 2;',
    'show search_path',
    'select "update" from t',
    'select $$delete from t$$',
  ];
  const resto = [
    '', '   ', null,
    'insert into t values (1)',
    'update t set a = 1',
    'delete from t',
    'with d as (delete from t returning *) select * from d',
    'select * into novo from t',
    'explain analyze delete from t',
    'explain (analyze, buffers) select 1',
    'select 1; drop table t',
    'create table x (a int)',
    'select * from t for update',
    'select * from t for no key update',
    'select * from t for share',
    "select nextval('seq')",
    'select pg_terminate_backend(1)',
    "select set_config('role', 'x', false)",
    'do $$ begin delete from t; end $$',
    'vacuum', 'set role postgres', 'truncate t', 'grant all on t to x', 'call proc()', 'copy t to stdout',
  ];
  for (const s of leitura) assert.equal(somenteLeitura(s), true, `devia ser leitura: ${s}`);
  for (const s of resto) assert.equal(somenteLeitura(s), false, `não devia ser leitura: ${s}`);
});

test('sql: barra leitura pela conexão que escreve e diz o caminho certo', () => {
  const raiz = tmp('sql-proj');
  const casa = tmp('sql-casa');
  const env = { CLAUDE_PROJECT_DIR: raiz, HOME: casa, USERPROFILE: casa, CLAUDE_CONFIG_DIR: '' };
  const chamada = (tool_name, query) => ({ hook_event_name: 'PreToolUse', cwd: raiz, tool_name, tool_input: { project_id: 'abc', query } });

  // Sem a conexão de leitura configurada: barra e manda configurar.
  let d = decisao(SQL, chamada('mcp__Supabase__execute_sql', 'select * from tabela_secreta'), env);
  assert.equal(d.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /mcp__supabase-leitura__execute_sql/);
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /ainda não tem a conexão/);
  // O SQL nunca vai para a mensagem.
  assert.doesNotMatch(d.hookSpecificOutput.permissionDecisionReason, /tabela_secreta/);

  // Com a conexão declarada no .mcp.json do projeto: manda autenticar.
  escrever(path.join(raiz, '.mcp.json'), JSON.stringify({ mcpServers: { 'supabase-leitura': { type: 'http', url: 'https://exemplo' } } }));
  d = decisao(SQL, chamada('mcp__claude_ai_Supabase__execute_sql', 'with a as (select 1) select * from a'), env);
  assert.equal(d.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /falta autenticar/);

  // Declarada no .claude.json do usuário, para este projeto.
  fs.rmSync(path.join(raiz, '.mcp.json'));
  escrever(path.join(casa, '.claude.json'), JSON.stringify({ projects: { [raiz.replace(/\\/g, '/')]: { mcpServers: { 'supabase-leitura': {} } } } }));
  d = decisao(SQL, chamada('mcp__supabase__execute_sql', 'select 1'), env);
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /falta autenticar/);

  // Escrita, a própria conexão de leitura, outra ferramenta e entrada quebrada: calado.
  assert.equal(decisao(SQL, chamada('mcp__Supabase__execute_sql', 'update pedidos set a = 1'), env), null);
  assert.equal(decisao(SQL, chamada('mcp__supabase-leitura__execute_sql', 'select 1'), env), null);
  assert.equal(decisao(SQL, chamada('mcp__Supabase__apply_migration', 'select 1'), env), null);
  assert.equal(decisao(SQL, '{quebrado', env), null);
});

test('boletim: avisa quando o projeto com Supabase não tem a conexão só de leitura', () => {
  const raiz = projetoGrande();
  const casa = tmp('casa-boletim');
  const env = { HOME: casa, USERPROFILE: casa, CLAUDE_CONFIG_DIR: '' };
  let t = rodar(BOLETIM, { source: 'startup', cwd: raiz }, env);
  assert.match(t, /sem a conexão só de leitura \(supabase-leitura\)/);
  // Na retomada não repete.
  t = rodar(BOLETIM, { source: 'resume', cwd: raiz }, env);
  assert.doesNotMatch(t, /sem a conexão só de leitura/);
  // Com a conexão no .mcp.json do projeto, não avisa.
  escrever(path.join(raiz, '.mcp.json'), JSON.stringify({ mcpServers: { 'supabase-leitura': { type: 'http', url: 'https://exemplo' } } }));
  t = rodar(BOLETIM, { source: 'startup', cwd: raiz }, env);
  assert.doesNotMatch(t, /sem a conexão só de leitura/);
});

// ---------- trava de leitura do Explore ----------
const LEITURA = path.join(HOOKS, 'equipe-leitura.mjs');

test('leitura do Explore: arquivo grande só por trecho', () => {
  const claude = tmp('claude-leitura');
  const pasta = tmp('leitura-arquivos');
  const grande = path.join(pasta, 'grande.dart');
  const pequeno = path.join(pasta, 'pequeno.dart');
  escrever(grande, Array.from({ length: 500 }, (_, i) => `linha ${i + 1}`).join('\n') + '\n');
  escrever(pequeno, 'a\nb\nc\n');
  escrever(path.join(pasta, 'foto.png'), 'x'.repeat(10));
  const env = { EQUIPE_PASTA_CLAUDE: claude };
  const ler = (input) => decisao(LEITURA, { tool_name: 'Read', session_id: 's1', tool_input: input }, env);

  const d = ler({ file_path: grande });
  assert.equal(d.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /mais de 300 linhas/);
  assert.equal(ler({ file_path: grande, offset: 100, limit: 120 }), null);
  assert.equal(ler({ file_path: grande, offset: 450 }), null); // só 51 linhas a partir daí
  assert.equal(ler({ file_path: grande, limit: 1000 })?.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(ler({ file_path: pequeno, limit: 1000 }), null);
  assert.equal(ler({ file_path: pequeno }), null);
  assert.equal(ler({ file_path: path.join(pasta, 'foto.png') }), null);
  assert.equal(ler({ file_path: path.join(pasta, 'nao-existe.dart') }), null);
  // Limite configurável.
  assert.equal(decisao(LEITURA, { tool_name: 'Read', tool_input: { file_path: grande } }, { ...env, EQUIPE_EXPLORE_LINHAS: '600' }), null);
  // Outra ferramenta e entrada quebrada: calado.
  assert.equal(decisao(LEITURA, { tool_name: 'Grep', tool_input: { pattern: 'x' } }, env), null);
  assert.equal(decisao(LEITURA, '{quebrado', env), null);
});

test('leitura do Explore: teto de leituras por chamada, contado por agente', () => {
  const claude = tmp('claude-teto');
  const pasta = tmp('teto-arquivos');
  const arq = path.join(pasta, 'a.dart');
  escrever(arq, 'a\n');
  const env = { EQUIPE_PASTA_CLAUDE: claude, EQUIPE_EXPLORE_LEITURAS: '3' };
  const ler = (extra) => decisao(LEITURA, { tool_name: 'Read', session_id: 'sess', tool_input: { file_path: arq }, ...extra }, env);

  // Com o id do agente na entrada.
  for (let i = 0; i < 3; i++) assert.equal(ler({ agent_id: 'ag1' }), null);
  const d = ler({ agent_id: 'ag1' });
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /Teto de 3 leituras/);
  // Outro Explore na mesma sessão tem a própria conta.
  assert.equal(ler({ agent_id: 'ag2' }), null);

  // Sem o id: acha o agente pela transcrição que contém esta chamada de ferramenta.
  const dirProj = path.join(claude, 'projects', '-p');
  const transcricao = path.join(dirProj, 'sess2.jsonl');
  escrever(transcricao, '');
  const sub = path.join(dirProj, 'sess2', 'subagents');
  escrever(path.join(sub, 'agent-x9.jsonl'), linha({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_A', name: 'Read' }, { type: 'tool_use', id: 'toolu_B', name: 'Read' }, { type: 'tool_use', id: 'toolu_C', name: 'Read' }, { type: 'tool_use', id: 'toolu_D', name: 'Read' }] } }) + '\n');
  const porTranscricao = (id) => decisao(LEITURA, { tool_name: 'Read', session_id: 'sess2', transcript_path: transcricao, tool_use_id: id, tool_input: { file_path: arq } }, env);
  assert.equal(porTranscricao('toolu_A'), null);
  assert.equal(porTranscricao('toolu_B'), null);
  assert.equal(porTranscricao('toolu_C'), null);
  assert.match(porTranscricao('toolu_D').hookSpecificOutput.permissionDecisionReason, /Teto de 3/);
  // Sem como saber quem é: não conta (a leitura por trecho continua valendo).
  for (let i = 0; i < 5; i++) assert.equal(decisao(LEITURA, { tool_name: 'Read', session_id: 'sess3', tool_input: { file_path: arq } }, env), null);
});
