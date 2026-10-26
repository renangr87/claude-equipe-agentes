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
