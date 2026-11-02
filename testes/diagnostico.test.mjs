// Testes do diagnóstico da instalação (hooks/equipe-diagnostico.mjs) e das linhas do
// boletim que dependem dele: mapa indexado, revisão de escopo e instalação com problema.
//   node --test testes/diagnostico.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  diagnosticoRapido, lerConfigMapa, projetoIndexado, projetosDoMapa, resumoRapido,
} from '../hooks/equipe-diagnostico.mjs';

const HOOKS = fileURLToPath(new URL('../hooks/', import.meta.url));
const DIAGNOSTICO = path.join(HOOKS, 'equipe-diagnostico.mjs');
const BOLETIM = path.join(HOOKS, 'equipe-boletim.mjs');

const tmp = (nome) => fs.mkdtempSync(path.join(os.tmpdir(), `diag-${nome}-`));
const escrever = (arquivo, texto) => {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, texto);
};
const barras = (p) => p.replace(/\\/g, '/');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@exemplo.com', '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// Programa do mapa falso: responde "config list" e "cli list_projects" com o que vier no
// ambiente e grava as chamadas. Com FALSO_DEMORA, demora (para o teste de tempo).
const mapaFalso = path.join(tmp('mapa'), 'mapa-falso.mjs');
escrever(mapaFalso, [
  "import fs from 'node:fs';",
  'const a = process.argv.slice(2);',
  "if (process.env.FALSO_LOG) fs.appendFileSync(process.env.FALSO_LOG, a.join(' ') + '\\n');",
  'if (process.env.FALSO_DEMORA) { const fim = Date.now() + Number(process.env.FALSO_DEMORA); while (Date.now() < fim) {} }',
  "if (a[0] === 'config') process.stdout.write(process.env.FALSO_CONFIG || '');",
  "else if (a[0] === 'cli' && a[1] === 'list_projects') process.stdout.write(process.env.FALSO_PROJETOS || '');",
  '',
].join('\n'));

const CONFIG_LIGADA = 'Configuration:\n  auto_index                = true      \n  auto_index_limit          = 50000     \n  auto_watch                = true      \n';
const CONFIG_DESLIGADA = 'Configuration:\n  auto_index                = false     \n  auto_index_limit          = 50000     \n  auto_watch                = true      \n';

// Instalação falsa e saudável: hooks no settings.json apontando para scripts que existem,
// Node que existe e agentes com a guarda no caminho certo.
function instalacao() {
  const pasta = tmp('claude');
  const hooks = path.join(pasta, 'hooks');
  escrever(path.join(hooks, 'equipe-comum.mjs'), '// comum\n');
  escrever(path.join(hooks, 'equipe-boletim.mjs'), "import { x } from './equipe-comum.mjs';\n");
  escrever(path.join(hooks, 'equipe-pre.mjs'), "import {\n  a,\n} from './equipe-comum.mjs';\n");
  escrever(path.join(hooks, 'guarda-comandos.ps1'), '# guarda\n');
  const h = (script) => ({ type: 'command', command: process.execPath, args: [`${barras(pasta)}/hooks/${script}`], timeout: 10 });
  escrever(path.join(pasta, 'settings.json'), JSON.stringify({
    permissions: { deny: [] },
    hooks: {
      SessionStart: [{ hooks: [h('equipe-boletim.mjs'), { type: 'command', command: 'echo', args: ['do usuario'] }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [h('equipe-pre.mjs')] }],
    },
  }));
  const guarda = (perfil) => `hooks:\n  PreToolUse:\n    - matcher: "Bash"\n      hooks:\n        - type: command\n          command: "pwsh"\n          args: ["-Command", "try { & '${barras(pasta).replace(/'/g, "''")}/hooks/guarda-comandos.ps1' -Perfil ${perfil}; exit $LASTEXITCODE } catch { exit 2 }"]\n`;
  for (const [nome, perfil] of [['Explore', 'explore'], ['implementador', 'implementador'], ['verificador', 'verificador']]) {
    escrever(path.join(pasta, 'agents', `${nome}.md`), `---\nname: ${nome}\n${guarda(perfil)}---\ntexto\n`);
  }
  escrever(path.join(pasta, 'agents', 'revisor.md'), '---\nname: revisor\n---\ntexto\n');
  escrever(path.join(pasta, 'equipe-aviso.json'), JSON.stringify({ ntfy: 'https://ntfy.sh/equipe-teste' }));
  return pasta;
}

function completo(pasta, env = {}) {
  const r = spawnSync(process.execPath, [DIAGNOSTICO, '--claude-json', path.join(pasta, '.claude.json')], {
    encoding: 'utf8',
    env: { ...process.env, EQUIPE_PASTA_CLAUDE: pasta, EQUIPE_SEM_REDE: '1', EQUIPE_MAPA_BIN: '', CLAUDE_CONFIG_DIR: '', ...env },
  });
  return { codigo: r.status, texto: r.stdout };
}

test('diagnóstico rápido: sem a equipe instalada, nada a dizer', () => {
  const vazia = tmp('vazia');
  assert.deepEqual(diagnosticoRapido(vazia), []);
  assert.equal(resumoRapido(vazia), '');
});

test('diagnóstico rápido: instalação saudável não acusa nada e roda em poucos milissegundos', () => {
  const pasta = instalacao();
  assert.deepEqual(diagnosticoRapido(pasta), []);
  const inicio = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) diagnosticoRapido(pasta);
  const ms = Number(process.hrtime.bigint() - inicio) / 1e6 / 5;
  assert.ok(ms < 50, `levou ${ms.toFixed(1)} ms`);
});

test('diagnóstico rápido: hook sem arquivo, agente com marcador e agente sem guarda', () => {
  const pasta = instalacao();
  fs.rmSync(path.join(pasta, 'hooks', 'equipe-pre.mjs'));
  escrever(path.join(pasta, 'agents', 'Explore.md'), '---\nname: Explore\nhooks: "__NODE__"\n---\n');
  escrever(path.join(pasta, 'agents', 'verificador.md'), '---\nname: verificador\n---\n');
  const p = diagnosticoRapido(pasta);
  const textos = p.map((i) => i.texto).join('\n');
  assert.match(textos, /equipe-pre\.mjs/);
  assert.match(textos, /marcador não trocado.*Explore/);
  assert.match(textos, /sem a guarda de terminal: (Explore, )?verificador/);
  assert.ok(p.every((i) => i.nivel === 'erro'));
  const linha = resumoRapido(pasta);
  assert.match(linha, /^Instalação da equipe com problema: Hook da equipe aponta para arquivo que não existe: .*equipe-pre\.mjs \(e mais \d+\); rode node .*\/hooks\/equipe-diagnostico\.mjs$/);
});

test('diagnóstico rápido: script importado que falta e Node que sumiu', () => {
  const pasta = instalacao();
  fs.rmSync(path.join(pasta, 'hooks', 'equipe-comum.mjs'));
  const s = JSON.parse(fs.readFileSync(path.join(pasta, 'settings.json'), 'utf8'));
  s.hooks.PreToolUse[0].hooks[0].command = path.join(pasta, 'nao-existe', 'node.exe');
  fs.writeFileSync(path.join(pasta, 'settings.json'), JSON.stringify(s));
  const textos = diagnosticoRapido(pasta).map((i) => i.texto).join('\n');
  assert.match(textos, /Faltam scripts que os hooks usam: equipe-comum\.mjs/);
  assert.match(textos, /O Node\.js registrado nos hooks não existe mais/);
});

test('diagnóstico rápido: aviso e memória mal configurados viram aviso', () => {
  const pasta = instalacao();
  escrever(path.join(pasta, 'equipe-aviso.json'), '{"ntfy": 3}');
  escrever(path.join(pasta, 'equipe-memoria.json'), JSON.stringify({ pasta: path.join(pasta, 'sem-clone') }));
  const p = diagnosticoRapido(pasta);
  assert.equal(p.length, 2);
  assert.ok(p.every((i) => i.nivel === 'aviso'));
});

test('diagnóstico completo: instalação saudável sai com 0; servidores ausentes são só informação', () => {
  const pasta = instalacao();
  const r = completo(pasta);
  assert.equal(r.codigo, 0, r.texto);
  assert.match(r.texto, /ok {4}Hooks da equipe: 2 registro\(s\)/);
  assert.match(r.texto, /info {2}Servidor codebase-memory \(mapa do código\) não registrado/);
  assert.match(r.texto, /info {2}Servidor dart/);
  assert.match(r.texto, /Aviso no celular ligado/);
  assert.doesNotMatch(r.texto, /equipe-teste/, 'o tópico do aviso é a senha: não aparece');
  assert.match(r.texto, /Resumo: tudo certo/);
});

test('diagnóstico completo: erro sai com 1 e diz o que fazer', () => {
  const pasta = instalacao();
  fs.rmSync(path.join(pasta, 'agents', 'revisor.md'));
  const r = completo(pasta);
  assert.equal(r.codigo, 1);
  assert.match(r.texto, /ERRO {2}Agente\(s\) da equipe não instalado\(s\): revisor/);
  assert.match(r.texto, /O que fazer: Rode o instalador da equipe de novo/);
  assert.match(r.texto, /Resumo: 1 erro\(s\)/);
});

test('diagnóstico completo: servidores registrados e indexação automática do mapa', () => {
  const pasta = instalacao();
  escrever(path.join(pasta, '.claude.json'), JSON.stringify({ mcpServers: { 'codebase-memory': { command: mapaFalso }, 'apoio-local': { command: path.join(pasta, 'sumiu', 'python.exe') } } }));
  const log = path.join(pasta, 'chamadas.log');
  let r = completo(pasta, { EQUIPE_MAPA_BIN: mapaFalso, FALSO_CONFIG: CONFIG_DESLIGADA, FALSO_LOG: log });
  assert.match(r.texto, /ok {4}Servidor codebase-memory \(mapa do código\) registrado/);
  assert.match(r.texto, /aviso Servidor apoio-local registrado com um programa que não existe/);
  assert.match(r.texto, /aviso Mapa sem indexação automática/);
  assert.match(r.texto, /config set auto_index true/);
  assert.equal(fs.readFileSync(log, 'utf8').trim(), 'config list', 'o diagnóstico só lê a configuração');
  r = completo(pasta, { EQUIPE_MAPA_BIN: mapaFalso, FALSO_CONFIG: CONFIG_LIGADA });
  assert.match(r.texto, /ok {4}Mapa com indexação automática \(auto_index true, limite 50000 arquivos\)/);
  r = completo(pasta, { EQUIPE_MAPA_BIN: mapaFalso, FALSO_CONFIG: CONFIG_LIGADA.replace('auto_watch                = true', 'auto_watch = false') });
  assert.match(r.texto, /config set auto_watch true/);
  // Sem o programa: não diz nada sobre a configuração do mapa.
  r = completo(pasta, { EQUIPE_MAPA_BIN: '' });
  assert.doesNotMatch(r.texto, /indexação automática/);
});

test('diagnóstico completo: memória com envio pendente e em dia', () => {
  const pasta = instalacao();
  const remoto = tmp('remoto');
  git(remoto, 'init', '-q', '--bare');
  const clone = tmp('clone');
  git(clone, 'init', '-q');
  git(clone, 'remote', 'add', 'origin', remoto);
  escrever(path.join(clone, 'a.md'), 'um\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'um');
  git(clone, 'push', '-q', '-u', 'origin', 'HEAD:main');
  git(clone, 'branch', '-q', '--set-upstream-to=origin/main');
  escrever(path.join(pasta, 'equipe-memoria.json'), JSON.stringify({ pasta: clone }));
  let r = completo(pasta);
  assert.match(r.texto, /ok {4}Memória entre computadores em dia/);
  escrever(path.join(clone, 'b.md'), 'dois\n');
  r = completo(pasta);
  assert.match(r.texto, /aviso O último envio da memória não saiu/);
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'dois');
  r = completo(pasta);
  assert.match(r.texto, /aviso O último envio da memória não saiu/);
  assert.match(r.texto, /git -C ".*" push/);
  assert.equal(r.codigo, 0, 'aviso não é erro');
});

test('diagnóstico completo: versão instalada atrás da do GitHub vira aviso', () => {
  const pasta = instalacao();
  const equipe = tmp('equipe');
  git(equipe, 'init', '-q');
  escrever(path.join(equipe, 'a.txt'), '1');
  git(equipe, 'add', '-A');
  git(equipe, 'commit', '-q', '-m', 'um');
  const c1 = git(equipe, 'rev-parse', 'HEAD');
  escrever(path.join(equipe, 'a.txt'), '2');
  git(equipe, 'commit', '-q', '-am', 'dois');
  git(equipe, 'update-ref', 'refs/remotes/origin/main', git(equipe, 'rev-parse', 'HEAD'));
  escrever(path.join(pasta, 'equipe-versao.json'), JSON.stringify({ commit: c1, pasta: equipe }));
  const r = completo(pasta);
  assert.match(r.texto, /aviso Há versão nova da equipe no GitHub/);
  // A cópia da equipe não tem agents/: vale a lista de reserva, e a instalação segue saudável.
  assert.match(r.texto, /ok {4}Agentes da equipe/);
});

test('config list do mapa: formato atual, "chave: valor" e JSON', () => {
  assert.deepEqual(lerConfigMapa(CONFIG_DESLIGADA), { auto_index: 'false', auto_index_limit: '50000', auto_watch: 'true' });
  assert.deepEqual(lerConfigMapa('auto_index: TRUE\nauto_watch: false\n'), { auto_index: 'true', auto_watch: 'false' });
  assert.deepEqual(lerConfigMapa('{"auto_index":"true","auto_index_limit":1000}'), { auto_index: 'true', auto_index_limit: '1000' });
  assert.deepEqual(lerConfigMapa(''), {});
});

test('list_projects do mapa: lista, objeto com projects, envelope do MCP e nome do projeto', () => {
  const raiz = tmp('raiz');
  const rb = barras(fs.realpathSync.native(raiz));
  assert.ok(projetoIndexado(projetosDoMapa(JSON.stringify([{ name: 'x', root_path: rb }])), raiz));
  assert.ok(projetoIndexado(projetosDoMapa(JSON.stringify({ projects: [{ name: 'x', root_path: `${rb}/` }], total: 1 })), raiz));
  const envelope = { content: [{ type: 'text', text: JSON.stringify({ projects: [{ name: 'y', root_path: rb }] }) }] };
  assert.ok(projetoIndexado(projetosDoMapa(`aviso antes\n${JSON.stringify(envelope)}`), raiz));
  assert.ok(projetoIndexado(projetosDoMapa(JSON.stringify([{ name: rb.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+/, '') }])), raiz));
  assert.equal(projetoIndexado(projetosDoMapa(JSON.stringify({ projects: [{ name: 'outro', root_path: '/outro/lugar' }] })), raiz), false);
  assert.equal(projetosDoMapa('name  root_path\napp   /x'), null);
  assert.equal(projetosDoMapa(''), null);
});

// ---------- boletim ----------

function projetoGrande() {
  const raiz = tmp('projeto');
  git(raiz, 'init', '-q');
  for (let i = 0; i < 60; i++) escrever(path.join(raiz, 'lib', `arquivo${i}.dart`), `// ${i}\n`);
  escrever(path.join(raiz, 'pubspec.yaml'), 'name: app\n');
  git(raiz, 'add', '-A');
  git(raiz, 'commit', '-q', '-m', 'inicio');
  return raiz;
}

const claudeVazio = tmp('claude-vazio');
function boletim(entrada, env = {}) {
  const r = spawnSync(process.execPath, [BOLETIM], {
    input: JSON.stringify(entrada), encoding: 'utf8',
    env: { ...process.env, EQUIPE_SEM_REDE: '1', EQUIPE_PASTA_CLAUDE: claudeVazio, CLAUDE_PROJECT_DIR: '', EQUIPE_MAPA_BIN: '', ...env },
  });
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
}

test('boletim: diz se esta cópia está no mapa, só em projeto médio ou grande', () => {
  const raiz = projetoGrande();
  const topo = git(raiz, 'rev-parse', '--show-toplevel');
  const log = path.join(tmp('log'), 'chamadas.log');
  let t = boletim({ cwd: raiz, source: 'startup' }, { EQUIPE_MAPA_BIN: mapaFalso, FALSO_LOG: log, FALSO_PROJETOS: JSON.stringify({ projects: [{ name: 'app', root_path: topo }] }) });
  assert.match(t, /- Mapa: esta cópia está indexada\./);
  assert.match(fs.readFileSync(log, 'utf8'), /^cli list_projects \{.*"format":"json".*\}$/m);
  t = boletim({ cwd: raiz, source: 'startup' }, { EQUIPE_MAPA_BIN: mapaFalso, FALSO_PROJETOS: JSON.stringify({ projects: [{ name: 'outro', root_path: '/outro' }] }) });
  assert.match(t, /- Mapa: esta cópia não está indexada \(o Explore indexa na primeira tarefa\)\./);
  // Sem o programa, com saída que não dá para ler ou com tempo esgotado: nada sobre o mapa.
  assert.doesNotMatch(boletim({ cwd: raiz, source: 'startup' }), /Mapa:/);
  assert.doesNotMatch(boletim({ cwd: raiz, source: 'startup' }, { EQUIPE_MAPA_BIN: mapaFalso, FALSO_PROJETOS: 'erro qualquer' }), /Mapa:/);
  const inicio = Date.now();
  assert.doesNotMatch(boletim({ cwd: raiz, source: 'startup' }, { EQUIPE_MAPA_BIN: mapaFalso, FALSO_DEMORA: '6000', FALSO_PROJETOS: '[]' }), /Mapa:/);
  assert.ok(Date.now() - inicio < 5000, 'o boletim não espera o mapa mais que 2 segundos');
  // Projeto pequeno: o mapa é opcional e o boletim nem pergunta.
  const pequeno = tmp('pequeno');
  git(pequeno, 'init', '-q');
  escrever(path.join(pequeno, 'main.py'), 'print(1)\n');
  const log2 = path.join(tmp('log2'), 'chamadas.log');
  assert.doesNotMatch(boletim({ cwd: pequeno, source: 'startup' }, { EQUIPE_MAPA_BIN: mapaFalso, FALSO_LOG: log2, FALSO_PROJETOS: '[]' }), /Mapa:/);
  assert.ok(!fs.existsSync(log2));
});

test('boletim: revisão de escopo recente com FORA DO ESCOPO pede leitura antes do commit', () => {
  const raiz = projetoGrande();
  const escopo = path.join(raiz, '.revisao', 'escopo.md');
  escrever(escopo, '# Escopo\n- lib/x.dart: FORA DO ESCOPO (não foi pedido)\n');
  assert.match(boletim({ cwd: raiz, source: 'startup' }), /\.revisao\/escopo\.md .*FORA DO ESCOPO: leia antes do commit/);
  const velho = new Date(Date.now() - 2 * 86400000);
  fs.utimesSync(escopo, velho, velho);
  assert.doesNotMatch(boletim({ cwd: raiz, source: 'startup' }), /escopo\.md/);
  escrever(escopo, '# Escopo\n- tudo dentro do pedido\n');
  assert.doesNotMatch(boletim({ cwd: raiz, source: 'startup' }), /escopo\.md/);
});

test('boletim: instalação com problema vira uma linha, só no início de sessão nova', () => {
  const raiz = projetoGrande();
  const pasta = instalacao();
  assert.doesNotMatch(boletim({ cwd: raiz, source: 'startup' }, { EQUIPE_PASTA_CLAUDE: pasta }), /com problema/);
  fs.rmSync(path.join(pasta, 'hooks', 'equipe-pre.mjs'));
  const t = boletim({ cwd: raiz, source: 'startup' }, { EQUIPE_PASTA_CLAUDE: pasta });
  const linhas = t.split('\n').filter((l) => /com problema/.test(l));
  assert.equal(linhas.length, 1);
  assert.ok(linhas[0].endsWith(`rode node ${barras(pasta)}/hooks/equipe-diagnostico.mjs`), linhas[0]);
  assert.doesNotMatch(boletim({ cwd: raiz, source: 'compact' }, { EQUIPE_PASTA_CLAUDE: pasta }), /com problema/);
});

test('diagnóstico: as travas estão rodando? registro vazio com sessões, e sem o tipo do agente', () => {
  const pasta = instalacao();
  // Sessões recentes e nenhum registro: os hooks podem não estar rodando.
  for (const n of ['a', 'b', 'c']) escrever(path.join(pasta, 'projects', '-p', `${n}.jsonl`), '{}\n');
  assert.match(resumoRapido(pasta), /hooks da equipe não registraram nada/);
  // Registro com fins de subagente, todos sem o tipo: o Claude Code não manda o tipo.
  const agora = new Date().toISOString();
  const reg = (tipo) => [agora, 'eventos', 'SubagentStop', '20', tipo, 's-x'].join('\t');
  const arq = path.join(pasta, 'equipe-diario', `travas-${agora.slice(0, 7)}.log`);
  escrever(arq, [reg('mestre'), reg('mestre'), reg('mestre'), [agora, 'pre', 'passou', '30', 'mestre', 's-mestre'].join('\t')].join('\n') + '\n');
  assert.match(resumoRapido(pasta), /não está mandando aos hooks o tipo do agente/);
  // Com o tipo: tudo certo.
  escrever(arq, [reg('Explore'), reg('implementador'), reg('mestre')].join('\n') + '\n');
  assert.equal(resumoRapido(pasta), '');
  assert.match(completo(pasta).texto, /Travas rodando: 3 decisões/);
});
