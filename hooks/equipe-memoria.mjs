#!/usr/bin/env node
// Hook da equipe: a memória automática do Claude Code (auto memory) de cada projeto,
// sincronizada entre os seus computadores por um repositório git privado.
//
// - SessionStart: atualiza o repositório (git pull) e traz para este computador o que o
//   outro gravou.
// - Stop e SessionEnd: leva para o repositório o que mudou aqui e envia (commit e push em
//   segundo plano, para não segurar a sessão).
// O projeto é reconhecido pelo endereço do git (origin), igual nos dois computadores, mesmo
// com a pasta em lugar diferente. Configuração: <pasta do Claude>/equipe-memoria.json
// ({"pasta": "<clone do repositório de memória>"}), feita pelo instalador com -Memoria.
// Os dois lados mudaram o mesmo arquivo: fica o daqui, com o do outro acrescentado no fim
// (e, no repositório, os .md se juntam linha a linha: merge=union). Projeto sem origin não
// sincroniza.
// Erro, rede ou login faltando: silêncio; a sessão segue com a memória local.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lerEntrada, lerJson, pastaClaude } from './equipe-comum.mjs';

const ESTADO = '.equipe-sync.json';

function git(args, cwd, limite = 8000) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', timeout: limite, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  }).trim();
}
const tentar = (f) => { try { return f(); } catch { return null; } };

export function configuracao() {
  const cfg = lerJson(path.join(pastaClaude(), 'equipe-memoria.json'));
  const pasta = cfg && typeof cfg.pasta === 'string' ? cfg.pasta : '';
  return pasta && fs.existsSync(path.join(pasta, '.git')) ? pasta : null;
}

// Nome do projeto igual em todo computador: o endereço do origin, sem protocolo e sem login.
export function idDoProjeto(cwd) {
  const raiz = tentar(() => git(['rev-parse', '--show-toplevel'], cwd));
  if (!raiz) return null;
  const origem = tentar(() => git(['remote', 'get-url', 'origin'], raiz));
  // Sem origin não há nome seguro: dois projetos "app" misturariam a memória.
  if (!origem) return null;
  const id = origem.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '').replace(/:\d+\//, '/').replace(/:(?!\d)/, '/').replace(/\.git$/i, '').replace(/\/+$/, '');
  return id.toLowerCase().replace(/[^a-z0-9._-]+/g, '_');
}

// Pasta da memória automática deste projeto neste computador.
export function pastaLocal(entrada) {
  const projetos = path.join(pastaClaude(), 'projects');
  const cwd = entrada.cwd || process.cwd();
  // --git-common-dir vem relativo à pasta atual no git antigo (sem --path-format).
  const comumBruto = tentar(() => git(['rev-parse', '--git-common-dir'], cwd));
  const comum = comumBruto ? path.resolve(cwd, comumBruto) : null;
  const raizPrincipal = comum ? path.dirname(comum) : tentar(() => git(['rev-parse', '--show-toplevel'], cwd));
  // Caminho real e longo: no Windows a pasta temporária pode vir com nome curto (RUNNER~1).
  const codificar = (p) => { let r = path.resolve(p); try { r = fs.realpathSync.native(r); } catch { /* fica */ } return r.replace(/[^A-Za-z0-9]/g, '-'); };
  const candidatas = [];
  if (raizPrincipal) candidatas.push(path.join(projetos, codificar(raizPrincipal), 'memory'));
  if (entrada.transcript_path) candidatas.push(path.join(path.dirname(String(entrada.transcript_path)), 'memory'));
  return candidatas.find((c) => fs.existsSync(c)) || candidatas[0] || null;
}

const hash = (arq) => tentar(() => crypto.createHash('sha1').update(fs.readFileSync(arq)).digest('hex'));
const mds = (pasta) => tentar(() => fs.readdirSync(pasta).filter((n) => n.endsWith('.md'))) || [];

function lerEstado(local) { return lerJson(path.join(local, ESTADO)) || {}; }
function gravarEstado(local, estado) {
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, ESTADO), JSON.stringify(estado, null, 1));
}

// Do repositório para este computador.
export function baixar(local, guardada) {
  const base = lerEstado(local);
  let mudou = false;
  for (const nome of new Set([...mds(local), ...mds(guardada)])) {
    const l = hash(path.join(local, nome));
    const g = hash(path.join(guardada, nome));
    const b = base[nome] || null;
    if (l === g) { if (l) base[nome] = l; else delete base[nome]; continue; }
    if (g === b) continue; // só este computador mudou: sobe no fim
    if (l === b) {
      // Só o outro mudou: traz (ou apaga, se ele apagou).
      if (g) { fs.mkdirSync(local, { recursive: true }); fs.copyFileSync(path.join(guardada, nome), path.join(local, nome)); base[nome] = g; }
      else { fs.rmSync(path.join(local, nome), { force: true }); delete base[nome]; }
      mudou = true;
      continue;
    }
    // Os dois mudaram: fica o daqui, com o do outro no fim, para nada se perder.
    if (g) {
      // Só as linhas do outro que ainda não existem aqui.
      const daqui = new Set(fs.readFileSync(path.join(local, nome), 'utf8').split(/\r?\n/));
      const novas = fs.readFileSync(path.join(guardada, nome), 'utf8').split(/\r?\n/).filter((l) => l.trim() && !daqui.has(l));
      if (novas.length) {
        fs.appendFileSync(path.join(local, nome), `\n<!-- Do outro computador (os dois mudaram ao mesmo tempo) -->\n${novas.join('\n')}\n`);
        mudou = true;
      }
    }
    base[nome] = g || b;
  }
  if (mudou || fs.existsSync(local)) gravarEstado(local, base);
  return mudou;
}

// Deste computador para o repositório. Devolve true se algo mudou.
export function subir(local, guardada) {
  const base = lerEstado(local);
  let mudou = false;
  for (const nome of new Set([...mds(local), ...Object.keys(base)])) {
    const l = hash(path.join(local, nome));
    // Não mudou aqui desde a última sincronização: o que estiver no repositório (talvez a
    // versão nova do outro computador) fica, e chega no próximo início de sessão.
    if (l === (base[nome] || null)) continue;
    if (l) {
      fs.mkdirSync(guardada, { recursive: true });
      fs.copyFileSync(path.join(local, nome), path.join(guardada, nome));
      base[nome] = l;
    } else {
      fs.rmSync(path.join(guardada, nome), { force: true });
      delete base[nome];
    }
    mudou = true;
  }
  if (mudou) gravarEstado(local, base);
  return mudou;
}

const ID_GIT = ['-c', 'user.name=Claude Code', '-c', 'user.email=noreply@anthropic.com'];

// Junta o que o outro computador enviou. Arquivo .md mudado dos dois lados junta as duas
// versões (merge=union): nada se perde. Repositório recém-criado: une históricos sem relação.
export function atualizar(repo) {
  tentar(() => git(['fetch', '-q', 'origin'], repo, 20000));
  if (tentar(() => git(['rev-parse', '-q', '--verify', 'refs/remotes/origin/main'], repo)) === null) return;
  if (tentar(() => git(['rev-parse', '-q', '--verify', 'HEAD'], repo)) === null) {
    tentar(() => git(['checkout', '-q', '-B', 'main', 'origin/main'], repo));
    return;
  }
  tentar(() => git([...ID_GIT, 'merge', '-q', '--no-edit', '--allow-unrelated-histories', 'origin/main'], repo, 20000));
}

// Há algo daqui ainda não enviado (commit à frente ou arquivo fora de commit)?
function pendente(repo) {
  const st = tentar(() => git(['status', '--porcelain', '-b'], repo)) || '';
  return /\[ahead /.test(st) || st.split('\n').slice(1).some((l) => l.trim());
}

export function enviar(repo) {
  const atr = path.join(repo, '.gitattributes');
  // -text: o git não troca o fim de linha (o Windows traria \r\n e a memória mudaria sozinha).
  if (!fs.existsSync(atr)) fs.writeFileSync(atr, '* -text\n*.md merge=union\n');
  git(['add', '-A'], repo);
  if (tentar(() => git(['rev-parse', '-q', '--verify', 'HEAD'], repo)) === null) git(['checkout', '-q', '-B', 'main'], repo);
  if (git(['status', '--porcelain'], repo)) git([...ID_GIT, 'commit', '-q', '-m', `memória (${os.hostname()})`], repo);
  atualizar(repo);
  git(['push', '-q', '-u', 'origin', 'HEAD:main'], repo, 30000);
}

export function tratar(entrada) {
  const repo = configuracao();
  if (!repo) return null;
  const id = idDoProjeto(entrada.cwd || process.cwd());
  const local = pastaLocal(entrada);
  if (!id || !local) return null;
  const guardada = path.join(repo, 'projetos', id);
  tentar(() => git(['config', 'core.autocrlf', 'false'], repo));
  const evento = String(entrada.hook_event_name || '');
  if (evento === 'SessionStart') {
    atualizar(repo);
    return baixar(local, guardada) ? 'baixou' : 'em dia';
  }
  if (evento === 'Stop' || evento === 'SessionEnd') {
    // Envia o que mudou agora e também o que ficou para trás num envio que falhou.
    if (!subir(local, guardada) && !pendente(repo)) return 'sem mudança';
    if (process.env.EQUIPE_MEMORIA_SINCRONO) { enviar(repo); return 'enviou'; }
    // Em segundo plano: o push pode demorar e a sessão não espera.
    const p = spawn(process.execPath, [fileURLToPath(import.meta.url), '--enviar', repo], { detached: true, stdio: 'ignore', windowsHide: true });
    p.unref();
    return 'enviando';
  }
  return null;
}

function principal() {
  const i = process.argv.indexOf('--enviar');
  if (i > 0) { tentar(() => enviar(process.argv[i + 1])); return; }
  tentar(() => tratar(lerEntrada()));
}

const real = (p) => {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch { /* fica o caminho dado */ }
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) principal();
