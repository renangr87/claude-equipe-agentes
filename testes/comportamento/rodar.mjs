#!/usr/bin/env node
// Testes de comportamento: roda o Claude Code de verdade (modo sem tela, com a sua conta)
// em tarefas fixas, num projeto de exemplo criado numa pasta temporária, e confere na
// transcrição se a equipe fez o que deve: delegar a busca, ler por trecho, não gravar
// segredo, não aplicar no banco sem OK, terminar a tarefa sem pedir licença à toa, usar o
// mapa do código.
//
// Gasta um pouco do limite da assinatura (algo como 5 a 15 minutos de uso ao todo).
// Uso, na pasta da equipe:
//   node testes/comportamento/rodar.mjs              todas as tarefas
//   node testes/comportamento/rodar.mjs --so segredo  só as que têm "segredo" no nome
//   node testes/comportamento/rodar.mjs --manter      não apaga as pastas temporárias
// Precisa do Claude Code de linha de comando (claude) logado na sua conta. Se ele não
// estiver no PATH, passe o caminho em CLAUDE_BIN.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AVALIACOES, conferir, criarProjeto, lerSessao } from './avaliacoes.mjs';
import { pastaClaude, pastaDiario } from '../../hooks/equipe-comum.mjs';

const args = process.argv.slice(2);
const filtro = args.includes('--so') ? String(args[args.indexOf('--so') + 1] || '') : '';
const manter = args.includes('--manter');
const LIMITE_MS = 15 * 60000;

function acharClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
  const achado = r.status === 0 ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  return achado.find((p) => /\.(cmd|exe)$/i.test(p)) || achado[0] || null;
}

const git = (a, cwd) => spawnSync('git', a, { cwd, encoding: 'utf8' });

// Chave service_role falsa, montada na hora (nada de chave inteira no repositório).
function chaveFalsa() {
  const parte = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return [parte({ alg: 'HS256', typ: 'JWT' }), parte({ iss: 'supabase', ref: 'lojaexemplo', role: 'service' + '_role', iat: 1767225600 }), 'Q'.repeat(43)].join('.');
}

function sessaoDoClaude(cwd, id) {
  const projetos = path.join(pastaClaude(), 'projects');
  const direto = path.join(projetos, fs.realpathSync.native(cwd).replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`);
  if (fs.existsSync(direto)) return direto;
  for (const d of fs.readdirSync(projetos)) {
    const a = path.join(projetos, d, `${id}.jsonl`);
    if (fs.existsSync(a)) return a;
  }
  return null;
}

function rodarUma(claude, av) {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), `equipe-comportamento-${av.nome}-`));
  criarProjeto(pasta, (a, cwd) => { const r = git(a, cwd); if (r.status !== 0) throw new Error(`git ${a[0]} falhou`); });
  const chave = chaveFalsa();
  const pedido = av.pedido.replace('{{CHAVE_SERVICE_ROLE}}', chave);
  const inicio = Date.now();
  // O pedido vai pela entrada padrão: os argumentos são fixos (seguro com shell no Windows).
  const comShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(claude);
  // Com shell (o .cmd do npm no Windows), o caminho vai entre aspas por causa dos espaços.
  const r = spawnSync(comShell ? `"${claude}"` : claude, ['-p', '--output-format', 'stream-json', '--verbose'], {
    cwd: pasta, input: pedido, encoding: 'utf8', timeout: LIMITE_MS, maxBuffer: 256 * 1024 * 1024,
    shell: comShell,
  });
  const eventos = (r.stdout || '').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = eventos.find((e) => e.type === 'system' && e.subtype === 'init') || {};
  const temMapa = Array.isArray(init.tools) && init.tools.some((t) => String(t).startsWith('mcp__codebase-memory__'));
  const resultado = { nome: av.nome, segundos: Math.round((Date.now() - inicio) / 1000), checagens: [] };
  if (av.soComMapa && !temMapa) { resultado.pulada = 'o mapa do código não está nesta instalação'; return { resultado, pasta }; }
  const arq = init.session_id ? sessaoDoClaude(pasta, init.session_id) : null;
  if (!arq) {
    resultado.erro = r.error ? `o claude não rodou (${r.error.code || r.error.message})` : 'não achei a transcrição da sessão';
    return { resultado, pasta };
  }
  const ctx = {
    chave,
    arquivoContem: (rel, texto) => { try { return fs.readFileSync(path.join(pasta, rel), 'utf8').includes(texto); } catch { return false; } },
    testesPassam: () => spawnSync(process.execPath, ['--test'], { cwd: pasta, encoding: 'utf8', timeout: 120000 }).status === 0,
  };
  resultado.checagens = conferir(av, lerSessao(arq), ctx);
  return { resultado, pasta };
}

function principal() {
  const claude = acharClaude();
  if (!claude) {
    console.log('Não achei o Claude Code de linha de comando (claude).');
    console.log('Instale com: npm install -g @anthropic-ai/claude-code');
    console.log('Depois rode "claude" uma vez para entrar com a sua conta e rode este teste de novo.');
    process.exit(2);
  }
  const lista = AVALIACOES.filter((a) => !filtro || a.nome.includes(filtro));
  console.log(`Testes de comportamento: ${lista.length} tarefa(s), com ${claude}. Cada uma leva alguns minutos.\n`);
  const resultados = [];
  for (const av of lista) {
    process.stdout.write(`- ${av.nome}... `);
    const { resultado, pasta } = rodarUma(claude, av);
    resultados.push(resultado);
    if (resultado.pulada) console.log(`pulada: ${resultado.pulada}`);
    else if (resultado.erro) console.log(`ERRO: ${resultado.erro}`);
    else {
      const falhas = resultado.checagens.filter((c) => !c.ok);
      console.log(falhas.length ? `FALHOU (${resultado.segundos} s)` : `ok (${resultado.segundos} s)`);
      for (const c of resultado.checagens) console.log(`    ${c.ok ? 'ok   ' : 'FALHA'} ${c.nome} (${c.detalhe})`);
    }
    if (manter) console.log(`    pasta: ${pasta}`);
    else fs.rmSync(pasta, { recursive: true, force: true });
  }
  const total = resultados.flatMap((r) => r.checagens);
  const certas = total.filter((c) => c.ok).length;
  console.log(`\n${certas} de ${total.length} checagens certas.`);
  fs.mkdirSync(pastaDiario(), { recursive: true });
  const arq = path.join(pastaDiario(), `comportamento-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(arq, JSON.stringify({ data: new Date().toISOString(), resultados }, null, 2));
  console.log(`Resultado guardado em ${arq} (a /retro-equipe lê daqui).`);
  process.exit(certas === total.length && resultados.every((r) => !r.erro) ? 0 : 1);
}

const real = (p) => { try { return fs.realpathSync(path.resolve(p)); } catch { return path.resolve(p); } };
if (process.argv[1] && real(process.argv[1]).toLowerCase() === real(fileURLToPath(import.meta.url)).toLowerCase()) principal();
