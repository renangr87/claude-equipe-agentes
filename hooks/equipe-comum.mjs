// Funções comuns aos scripts da equipe que rodam no computador do usuário:
// equipe-boletim.mjs (hook SessionStart), equipe-contexto.mjs (hook SubagentStart)
// e equipe-medir.mjs (medição para a /retro-equipe).
//
// Só biblioteca padrão do Node. Nenhuma função aqui lança erro para fora: um hook
// que quebra não pode atrapalhar a sessão, então tudo devolve null ou vazio.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Pasta de configuração do Claude Code. Instalado, o script fica em <pasta>/hooks/.
// EQUIPE_PASTA_CLAUDE existe para os testes.
export function pastaClaude() {
  if (process.env.EQUIPE_PASTA_CLAUDE) return process.env.EQUIPE_PASTA_CLAUDE;
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  const acima = path.dirname(aqui);
  if (path.basename(aqui) === 'hooks' &&
      (fs.existsSync(path.join(acima, 'settings.json')) || fs.existsSync(path.join(acima, 'projects')))) {
    return acima;
  }
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function pastaDiario() {
  return path.join(pastaClaude(), 'equipe-diario');
}

// Entrada JSON do hook (stdin). Vazia ou inválida: objeto vazio.
export function lerEntrada() {
  try {
    let texto = fs.readFileSync(0, 'utf8');
    if (texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1);
    return texto.trim() ? JSON.parse(texto) : {};
  } catch {
    return {};
  }
}

export function git(args, cwd, timeout = 5000) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', timeout, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024,
    }).replace(/\r?\n$/, '');
  } catch {
    return null;
  }
}

export function lerTexto(arquivo) {
  try {
    let t = fs.readFileSync(arquivo, 'utf8');
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return t;
  } catch {
    return null;
  }
}

export function lerJson(arquivo) {
  const t = lerTexto(arquivo);
  if (t === null) return null;
  try { return JSON.parse(t); } catch { return null; }
}

// Extensões contadas como código (scripts e infraestrutura contam, como diz a regra).
const EXT_CODIGO = new Set([
  'dart', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'py', 'go', 'rs', 'java', 'kt', 'kts',
  'swift', 'm', 'mm', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'fs', 'rb', 'php', 'sql', 'ps1', 'psm1', 'sh',
  'bash', 'lua', 'scala', 'ex', 'exs', 'erl', 'clj', 'tf', 'hcl', 'gradle',
]);
// Código gerado não conta: o mapa e a regra falam do código escrito pelas pessoas.
const GERADO = /\.(g|freezed|mocks|pb|pbenum|pbjson|pbserver|gr|config)\.dart$|\.min\.js$|\.d\.ts$/;
const PASTA_IGNORADA = /(^|\/)(node_modules|vendor|build|dist|\.dart_tool|Pods|\.gradle|coverage)\//;
// Manifestos de módulo: cada pasta com um deles é um módulo (app, backend, pacote).
const MANIFESTO = /(^|\/)(pubspec\.yaml|package\.json|pyproject\.toml|go\.mod|Cargo\.toml|composer\.json|Gemfile|[^/]+\.csproj|supabase\/config\.toml)$/;

// Fatos do projeto em que o hook rodou. null se a pasta não está num repositório git.
export function fatosDoProjeto(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const raiz = git(['rev-parse', '--show-toplevel'], cwd);
  if (!raiz) return null;
  const lista = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], raiz, 15000);
  const arquivos = lista ? lista.split('\0').filter(Boolean) : [];

  let codigo = 0;
  const modulos = new Set();
  const notas = [];
  for (const a of arquivos) {
    if (PASTA_IGNORADA.test(a)) continue;
    const ext = a.includes('.') ? a.slice(a.lastIndexOf('.') + 1).toLowerCase() : '';
    if (EXT_CODIGO.has(ext) && !GERADO.test(a)) codigo++;
    const m = a.match(MANIFESTO);
    if (m) {
      const nome = m[2];
      let pasta = a.slice(0, a.length - nome.length).replace(/\/$/, '');
      // A pasta supabase/ conta como módulo próprio (o backend), mesmo dentro de outra.
      if (nome === 'supabase/config.toml') pasta = pasta ? `${pasta}/supabase` : 'supabase';
      modulos.add(pasta || '.');
    }
    if (/(^|\/)CLAUDE\.md$/.test(a) && a !== 'CLAUDE.md' && !a.startsWith('.claude/')) notas.push(a);
  }
  // Exemplos de pacote (example/) não são módulos do produto.
  const modulosReais = [...modulos].filter((m) => !/(^|\/)(example|examples|test|tests|fixtures)(\/|$)/.test(m)).sort();

  const claudeMd = lerTexto(path.join(raiz, 'CLAUDE.md'));
  const configurado = claudeMd !== null && /^##\s*Comandos/im.test(claudeMd) && !/<comando/.test(claudeMd);

  const caminhoLista = path.join(raiz, '.claude', 'verificador-comandos.txt');
  const textoLista = lerTexto(caminhoLista);
  let comandos = null;
  let listaEmCommit = false;
  if (textoLista !== null) {
    comandos = textoLista.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    const rastreada = git(['ls-files', '--', '.claude/verificador-comandos.txt'], raiz);
    const mudanca = git(['status', '--porcelain', '--', '.claude/verificador-comandos.txt'], raiz);
    listaEmCommit = Boolean(rastreada) && mudanca === '';
  }

  return {
    raiz,
    codigo,
    modulos: modulosReais,
    mapaObrigatorio: codigo > 50 || modulosReais.length > 1,
    notas: notas.sort(),
    claudeMd: claudeMd !== null,
    configurado,
    regras: secao(claudeMd, 'Regras deste projeto'),
    comandos,
    listaEmCommit,
    plano: lerPlano(raiz),
  };
}

// Texto de uma seção "## Título" de um Markdown, sem o título, até a próxima seção de
// mesmo nível. Limitado para o contexto não crescer.
export function secao(texto, titulo, maxLinhas = 30) {
  if (!texto) return null;
  const linhas = texto.split(/\r?\n/);
  const alvo = titulo.toLowerCase();
  const inicio = linhas.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, '').trim().toLowerCase() === alvo);
  if (inicio < 0) return null;
  const corpo = [];
  for (let i = inicio + 1; i < linhas.length; i++) {
    if (/^##?\s+/.test(linhas[i])) break;
    corpo.push(linhas[i]);
  }
  // Linhas que ainda são do modelo (com "<texto a preencher>") não valem como regra.
  const preenchidas = corpo.filter((l) => !/<[^<>\n`]*\s[^<>\n`]*>/.test(l.replace(/`[^`]*`/g, '')));
  const limpo = preenchidas.join('\n').trim();
  if (!limpo) return null;
  const cortado = limpo.split('\n').slice(0, maxLinhas).join('\n');
  return cortado.length > 2500 ? cortado.slice(0, 2500) + ' [...]' : cortado;
}

// Plano em .revisao/plano.md: passos com caixa de marcar e idade do arquivo.
function lerPlano(raiz) {
  const arquivo = path.join(raiz, '.revisao', 'plano.md');
  const texto = lerTexto(arquivo);
  if (texto === null) return null;
  const feitos = (texto.match(/^\s*[-*]\s*\[[xX]\]/gm) || []).length;
  const abertos = (texto.match(/^\s*[-*]\s*\[ \]/gm) || []).length;
  let dias = null;
  try { dias = Math.floor((Date.now() - fs.statSync(arquivo).mtimeMs) / 86400000); } catch { /* sem data */ }
  return { feitos, abertos, dias };
}

// Versão instalada da equipe e se o GitHub tem uma mais nova. Não usa a rede aqui:
// compara com o último fetch e, se ele tiver mais de 20 horas, dispara outro em
// segundo plano (o resultado aparece no boletim seguinte).
export function versaoDaEquipe({ semRede = false } = {}) {
  const info = lerJson(path.join(pastaClaude(), 'equipe-versao.json'));
  if (!info || !info.commit || !info.pasta || !fs.existsSync(path.join(info.pasta, '.git'))) return null;
  const remoto = git(['rev-parse', '--verify', '-q', 'origin/main'], info.pasta);
  if (!semRede && !process.env.EQUIPE_SEM_REDE) {
    let idade = Infinity;
    try { idade = Date.now() - fs.statSync(path.join(info.pasta, '.git', 'FETCH_HEAD')).mtimeMs; } catch { /* nunca buscou */ }
    if (idade > 20 * 3600 * 1000) {
      try {
        const filho = spawn('git', ['-C', info.pasta, 'fetch', '-q', 'origin', 'main'], {
          detached: true, stdio: 'ignore', windowsHide: true,
        });
        filho.on('error', () => {});
        filho.unref();
      } catch { /* sem git: fica para a próxima */ }
    }
  }
  let atrasada = false;
  if (remoto && remoto !== info.commit) {
    // Só avisa se a instalada é ancestral da remota: commit local à frente não é atraso.
    const r = git(['merge-base', '--is-ancestor', info.commit, remoto], info.pasta);
    atrasada = r !== null;
  }
  return { instalada: info.commit, remota: remoto, atrasada, pasta: info.pasta };
}

// Sessões gravadas (arquivos .jsonl da sessão principal) depois de uma data.
export function sessoesDesde(desdeMs, limite = 20000) {
  const projetos = path.join(pastaClaude(), 'projects');
  let total = 0;
  let pastas = [];
  try { pastas = fs.readdirSync(projetos, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return 0; }
  for (const p of pastas) {
    let nomes = [];
    try { nomes = fs.readdirSync(path.join(projetos, p.name)); } catch { continue; }
    for (const n of nomes) {
      if (!n.endsWith('.jsonl')) continue;
      try {
        if (fs.statSync(path.join(projetos, p.name, n)).mtimeMs >= desdeMs) total++;
      } catch { /* sumiu */ }
      if (total >= limite) return total;
    }
  }
  return total;
}

export function saidaContexto(evento, texto) {
  if (!texto) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: evento, additionalContext: texto } }));
}
