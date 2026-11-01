// Entrega do implementador e revisão obrigatória (rodam pelo equipe-pos.mjs e pelo
// equipe-eventos.mjs):
//
// 1. O implementador só entrega depois de verificar: as edições e os comandos de
//    verificação dele ficam anotados; se ele termina tendo editado código depois do último
//    teste, o fim é barrado uma vez ("rode a verificação antes de entregar"). Se insistir,
//    passa e fica registrado como "entregou sem verificar".
// 2. Escopo conferido pelo hook: no início do implementador, a equipe guarda o git status e
//    o hash dos arquivos já modificados; no fim, compara, lê o "Escopo" do briefing e
//    grava a lista em .revisao/escopo.md. Em primeiro plano, o mestre recebe a lista junto
//    com o relatório.
// 3. Revisão obrigatória: no fim da resposta do mestre, se as edições da sessão passam de
//    50 linhas ou tocam área sensível e o revisor não rodou depois delas, o fim é barrado
//    uma vez com o motivo. Não barra sem mudança, com "sem revisão" no pedido, nem duas
//    vezes seguidas.
// Travas de retrabalho: erro ou dúvida deixa passar.
import fs from 'node:fs';
import path from 'node:path';
import { secoes, caminhos } from './equipe-briefing.mjs';
import {
  anotacoes, anotar, apagarEstado, chaveDaChamada, desligada, ehCodigo, git, gravarEstado, lerEstado, lerTexto,
  limparChamada, normalizar, tipoDoAgente,
} from './equipe-comum.mjs';

const LIMITE_LINHAS = 50;

export function chaveDaSessao(entrada) {
  const sessao = String((entrada && entrada.session_id) || '').replace(/[^A-Za-z0-9_-]/g, '');
  return sessao ? `${sessao}-sessao` : null;
}

const raizGit = (cwd) => git(['rev-parse', '--show-toplevel'], cwd || process.cwd());
const posix = (p) => String(p).replace(/\\/g, '/');

// ---------- anotações depois das ferramentas ----------

const TESTE = /\b(flutter|dart)\s+(test|analyze)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|check)\b|\bnpx\s+(vitest|jest|tsc|eslint|playwright)\b|\b(vitest|jest|pytest|mypy|tsc|eslint)\b|\bpython\d*(\.exe)?\s+-m\s+(pytest|unittest|mypy)\b|\bnode(\.exe)?\s+--test\b|\bgo\s+(test|vet)\b|\bcargo\s+(test|check|clippy)\b|\bruff\s+check\b|\bInvoke-Pester\b|\bdotnet\s+(test|build)\b|\bmvn\w*\s+(test|verify)\b|\bgradlew?\w*\s+\S*test/i;

export function ehVerificacao(comando, lista) {
  const c = String(comando || '').replace(/\s+/g, ' ').trim();
  if (!c) return false;
  if ((lista || []).some((l) => l && c.includes(l.replace(/\s+/g, ' ').trim()))) return true;
  return TESTE.test(c);
}

// Depois de Edit, Write e do terminal. lista = comandos do verificador (ou null).
export function anotarFerramenta(entrada, lista) {
  const nome = String(entrada.tool_name || '');
  const tipo = tipoDoAgente(entrada);
  const ti = entrada.tool_input || {};
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(nome)) {
    const arq = String(ti.file_path || ti.notebook_path || '');
    if (!arq) return;
    const absoluto = path.resolve(entrada.cwd || process.cwd(), arq);
    if (tipo === 'implementador') {
      const chave = chaveDaChamada(entrada);
      if (ehCodigo(arq)) anotar(chave, 'editou', Date.now());
      anotar(chave, 'arquivos', absoluto);
    }
    if (tipo === 'implementador' || tipo === 'mestre') {
      const sessao = chaveDaSessao(entrada);
      // Base de cada repositório: o commit de quando a sessão editou nele pela primeira vez.
      const raiz = raizGit(path.dirname(absoluto));
      if (raiz) {
        const bases = lerEstado(sessao, 'base') || {};
        if (!bases[raiz]) {
          bases[raiz] = git(['rev-parse', 'HEAD'], raiz) || 'HEAD';
          gravarEstado(sessao, 'base', bases);
        }
      }
      anotar(sessao, 'edicoes', absoluto);
    }
    return;
  }
  if (/^(Bash|PowerShell)$/.test(nome) && tipo === 'implementador' && ehVerificacao(ti.command, lista)) {
    anotar(chaveDaChamada(entrada), 'verificou', Date.now());
  }
}

// ---------- foto do começo e escopo (implementador) ----------

function statusDe(raiz) {
  const s = git(['status', '--porcelain', '--untracked-files=all', '-z'], raiz, 4000);
  if (s === null) return null;
  const r = {};
  const partes = s.split('\0');
  for (let i = 0; i < partes.length; i++) {
    const p = partes[i];
    if (p.length < 4) continue;
    const cod = p.slice(0, 2);
    r[p.slice(3)] = cod;
    if (/[RC]/.test(cod)) i++; // o nome antigo vem em seguida
  }
  return r;
}

function hashes(raiz, nomes) {
  const r = {};
  const existentes = nomes.filter((n) => fs.existsSync(path.join(raiz, n))).slice(0, 2000);
  if (!existentes.length) return r;
  const saida = git(['hash-object', '--', ...existentes], raiz, 4000);
  if (saida === null) return r;
  saida.split(/\r?\n/).forEach((h, i) => { if (existentes[i]) r[existentes[i]] = h.trim(); });
  return r;
}

export function fotoInicial(entrada) {
  const chave = chaveDaChamada(entrada);
  const raiz = raizGit(entrada.cwd);
  if (!chave || !raiz) return false;
  const status = statusDe(raiz);
  if (!status) return false;
  gravarEstado(chave, 'foto', { raiz, status, hashes: hashes(raiz, Object.keys(status)) });
  return true;
}

// Arquivos alterados desde a foto: entraram ou saíram do status, ou já estavam
// modificados e mudaram de hash.
export function alteradosDesde(foto) {
  const agora = statusDe(foto.raiz);
  if (!agora) return null;
  const alterados = new Set();
  for (const n of new Set([...Object.keys(agora), ...Object.keys(foto.status)])) {
    if (!(n in foto.status) || !(n in agora)) alterados.add(n);
  }
  const antes = Object.keys(foto.status).filter((n) => n in agora);
  const depois = hashes(foto.raiz, antes);
  for (const n of antes) if ((foto.hashes[n] || null) !== (depois[n] || null)) alterados.add(n);
  return [...alterados].sort();
}

// Escopo do briefing, lido da primeira mensagem da transcrição do subagente.
export function escopoDoBriefing(arquivoTranscricao) {
  const texto = lerTexto(String(arquivoTranscricao || ''));
  if (!texto) return null;
  for (const linha of texto.split('\n')) {
    let j;
    try { j = JSON.parse(linha); } catch { continue; }
    if (!j || j.type !== 'user' || !j.message) continue;
    const c = j.message.content;
    const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n') : '';
    if (!t.trim()) continue;
    const s = secoes(t);
    if (!s.escopo) return [];
    // Só o que pode tocar: a parte depois de "fora do escopo" não conta.
    const pode = s.escopo.split(/fora(?: do escopo)?\s*[:\-–]|nao (?:pode|toque|mexa)/)[0];
    return caminhos(pode);
  }
  return null;
}

// O arquivo (relativo à raiz) está no escopo? O escopo pode vir relativo, absoluto (com a
// letra do drive no Windows) ou só com o nome do arquivo. Tudo comparado sem acento e em
// minúsculas, como o texto do briefing.
export function dentroDoEscopo(arquivo, escopo, raiz) {
  const base = normalizar(posix(raiz || '')).replace(/\/+$/, '');
  const a = normalizar(posix(arquivo)).replace(/^\.\//, '');
  return escopo.some((e) => {
    let x = normalizar(posix(e)).replace(/^\.\//, '');
    if (base && x.startsWith(`${base}/`)) x = x.slice(base.length + 1);
    x = x.replace(/\*.*$/, '').replace(/\/+$/, '');
    return Boolean(x) && (a === x || a.startsWith(`${x}/`) || a.endsWith(`/${x}`) || x.endsWith(`/${a}`));
  });
}

function garantirRevisao(raiz) {
  const pasta = path.join(raiz, '.revisao');
  fs.mkdirSync(pasta, { recursive: true });
  const ign = path.join(pasta, '.gitignore');
  if (!fs.existsSync(ign)) fs.writeFileSync(ign, '*\n');
  return pasta;
}

// Lista do escopo no fim do implementador: grava .revisao/escopo.md e devolve o texto.
// "Fora do escopo" só entre os arquivos que ele mesmo editou (pelas ferramentas de edição):
// mudança de outro agente, do mestre ou de um comando aparece à parte, para conferir, e não
// conta como fuga de escopo (com dois implementadores em paralelo, um não acusa o outro).
export function relatorioDeEscopo(entrada) {
  const chave = chaveDaChamada(entrada);
  const foto = lerEstado(chave, 'foto');
  if (!foto || !foto.raiz) return null;
  const alterados = alteradosDesde(foto);
  if (!alterados) return null;
  const chaveRel = (r) => normalizar(posix(r));
  const proprios = new Set(anotacoes(chave, 'arquivos').map((f) => chaveRel(path.relative(foto.raiz, f))));
  const dele = alterados.filter((a) => proprios.has(chaveRel(a)));
  const outros = alterados.filter((a) => !proprios.has(chaveRel(a)));
  const escopo = escopoDoBriefing(entrada.agent_transcript_path);
  const fora = escopo && escopo.length ? dele.filter((a) => !dentroDoEscopo(a, escopo, foto.raiz)) : [];
  const lista = (xs) => `${xs.slice(0, 40).join(', ')}${xs.length > 40 ? ' ...' : ''}`;
  const l = [`Escopo conferido pela equipe (fim do implementador, ${new Date().toISOString().slice(0, 16).replace('T', ' ')}):`];
  l.push(`- Arquivos que o implementador editou (${dele.length}): ${dele.length ? lista(dele) : 'nenhum'}`);
  if (outros.length) l.push(`- Outras mudanças na pasta durante a tarefa (${outros.length}), de outro agente, do mestre ou de um comando: ${lista(outros)}. Confira de quem são antes do commit.`);
  if (escopo === null || !escopo.length) l.push('- O briefing não tinha "Escopo" com caminhos: confira a lista acima com o pedido.');
  else if (fora.length) l.push(`- FORA DO ESCOPO (${fora.length}): ${fora.join(', ')}. Não entram no commit sem o OK do usuário; descartar também só com o OK dele.`);
  else l.push('- Os arquivos que ele editou estão dentro do escopo do briefing.');
  const texto = l.join('\n');
  try { fs.writeFileSync(path.join(garantirRevisao(foto.raiz), 'escopo.md'), `${texto}\n`); } catch { /* segue */ }
  gravarEstado(chaveDaSessao(entrada), 'escopo-ultimo', { em: Date.now(), texto, fora: fora.length });
  return { texto, fora: fora.length };
}

// Depois da ferramenta Agent do mestre: entrega a lista do escopo do implementador que
// acabou de terminar em primeiro plano.
export function escopoParaMestre(entrada) {
  if (tipoDoAgente(entrada) !== 'mestre' || desligada('escopo')) return null;
  const ti = entrada.tool_input || {};
  if (String(ti.subagent_type || '') !== 'implementador' || ti.run_in_background) return null;
  const sessao = chaveDaSessao(entrada);
  const e = lerEstado(sessao, 'escopo-ultimo');
  if (!e || typeof e.em !== 'number' || Date.now() - e.em > 5 * 60000) return null;
  apagarEstado(sessao, 'escopo-ultimo');
  return `${e.texto}\n(A mesma lista está em .revisao/escopo.md.)`;
}

// ---------- fim do implementador ----------

// SubagentStop do implementador: { bloquear, motivo, registro } ou null.
export function fimDoImplementador(entrada) {
  const chave = chaveDaChamada(entrada);
  if (!chave) return null;
  const editou = Math.max(0, ...anotacoes(chave, 'editou').map(Number).filter(Number.isFinite));
  const verificou = Math.max(0, ...anotacoes(chave, 'verificou').map(Number).filter(Number.isFinite));
  const semVerificar = !desligada('verificar') && editou > 0 && verificou < editou;
  if (semVerificar && !entrada.stop_hook_active && !anotacoes(chave, 'cobrou').length) {
    anotar(chave, 'cobrou');
    return {
      bloquear: true,
      motivo: 'Trava da equipe: você editou código depois do último teste. Rode a verificação antes de entregar: os testes afetados pela mudança (ou o comando do "Como verificar" do briefing) e ponha o resultado no relatório. Se não há teste possível, diga por quê no relatório e encerre.',
      registro: 'barrou',
    };
  }
  let escopo = null;
  if (!desligada('escopo')) { try { escopo = relatorioDeEscopo(entrada); } catch { escopo = null; } }
  limparChamada(chave);
  if (semVerificar) return { bloquear: false, registro: 'entregou-sem-verificar', escopo };
  return { bloquear: false, registro: escopo && escopo.fora ? 'fora-do-escopo' : 'passou', escopo };
}

// ---------- revisão obrigatória (fim da resposta do mestre) ----------

const SENSIVEL_PADRAO = [
  // Pastas da área (auth/, payments/, ...) e arquivos com o nome dela (auth_service.dart).
  /(^|\/)(auth|autenticacao|authz|authn|authorization|autorizacao|security|seguranca|permissions?|permissoes|policies|politicas|rbac|acl|crypto|criptografia|payments?|pagamentos?|billing|cobranca)\//i,
  /(^|\/)(auth|authorization|autorizacao|permissions?|permissoes|payments?|pagamentos?|billing|crypto|criptografia)([._-][^/]*)?\.[a-z0-9]+$/i,
  /(^|\/)supabase\//i,
  /(^|\/)(migrations?|migracoes)\//i,
  /(^|\/)(infra|infrastructure|terraform|k8s|helm)\//i,
  /\.tf$/i,
  /(^|\/)\.github\/workflows\//i,
  /(^|\/)(\.gitlab-ci\.yml|azure-pipelines\.yml|Jenkinsfile|bitbucket-pipelines\.yml)$/i,
  /(^|\/)(firestore|storage|database)\.rules$/i,
];

// Áreas sensíveis do projeto: caminhos entre crases numa seção ou linha "Áreas sensíveis"
// do CLAUDE.md da raiz.
export function areasDoProjeto(raiz) {
  const t = lerTexto(path.join(raiz, 'CLAUDE.md'));
  if (!t) return [];
  const r = [];
  let naSecao = false;
  for (const linha of t.split(/\r?\n/)) {
    const n = normalizar(linha);
    if (/^#{1,6}\s/.test(linha)) { naSecao = /areas? sensive(l|is)/.test(n); continue; }
    if (naSecao || /areas? sensive(l|is)/.test(n)) for (const m of linha.matchAll(/`([^`\s]+)`/g)) r.push(posix(m[1]).replace(/^\.\//, ''));
  }
  return r;
}

export function ehSensivel(rel, areas) {
  const a = posix(rel);
  return SENSIVEL_PADRAO.some((re) => re.test(a)) || areas.some((x) => a === x || a.startsWith(x.endsWith('/') ? x : `${x}/`));
}

// Linhas mudadas (acrescentadas + tiradas) por arquivo desde a base, só nos arquivos dados.
function linhasPorArquivo(raiz, base, arquivos) {
  const r = {};
  if (!arquivos.length) return r;
  const saida = git(['diff', '--numstat', '--no-color', '--no-ext-diff', base || 'HEAD', '--', ...arquivos], raiz, 4000);
  for (const l of String(saida || '').split(/\r?\n/)) {
    const m = l.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (m) r[m[3]] = (Number(m[1]) || 0) + (Number(m[2]) || 0);
  }
  // Arquivo novo (fora do git e não ignorado, como o .env): todas as linhas contam.
  for (const a of arquivos) {
    if (a in r) continue;
    if (git(['ls-files', '--error-unmatch', '--', a], raiz) !== null) continue;
    if (git(['check-ignore', '-q', '--', a], raiz) !== null) continue;
    const t = lerTexto(path.join(raiz, a));
    if (t !== null) r[a] = t.split('\n').length;
  }
  return r;
}

// Edições da sessão agrupadas por repositório (um worktree é um repositório à parte), com
// as linhas mudadas de cada arquivo desde a base daquele repositório.
function estadoDaRevisao(entrada) {
  const sessao = chaveDaSessao(entrada);
  const edicoes = [...new Set(anotacoes(sessao, 'edicoes'))];
  if (!edicoes.length) return null;
  const bases = lerEstado(sessao, 'base') || {};
  const raizDaPasta = new Map();
  const porRaiz = new Map();
  for (const e of edicoes) {
    const pasta = path.dirname(e);
    if (!raizDaPasta.has(pasta)) {
      if (raizDaPasta.size >= 200) continue;
      raizDaPasta.set(pasta, fs.existsSync(pasta) ? raizGit(pasta) : null);
    }
    const raiz = raizDaPasta.get(pasta);
    if (!raiz) continue;
    const rel = posix(path.relative(raiz, e));
    if (!rel || rel.startsWith('..') || /^\.revisao\//.test(rel)) continue;
    if (!porRaiz.has(raiz)) porRaiz.set(raiz, []);
    porRaiz.get(raiz).push(rel);
  }
  const agora = {};
  const arquivos = [];
  for (const [raiz, rels] of porRaiz) {
    const linhas = linhasPorArquivo(raiz, typeof bases[raiz] === 'string' ? bases[raiz] : 'HEAD', rels);
    const areas = areasDoProjeto(raiz);
    for (const [rel, n] of Object.entries(linhas)) {
      agora[`${raiz}|${rel}`] = n;
      arquivos.push({ chave: `${raiz}|${rel}`, rel, sensivel: ehSensivel(rel, areas) });
    }
  }
  return { sessao, agora, arquivos };
}

// O revisor terminou: guarda as linhas de agora, para medir o que mudou depois dele.
export function anotarRevisao(entrada) {
  const e = estadoDaRevisao(entrada);
  if (!e) return false;
  gravarEstado(e.sessao, 'revisado', { em: Date.now(), linhas: e.agora });
  return true;
}

// Stop do mestre: { bloquear, motivo, registro } ou null.
export function revisaoNoFim(entrada) {
  if (desligada('revisao') || tipoDoAgente(entrada) !== 'mestre') return null;
  const e = estadoDaRevisao(entrada);
  if (!e) return null;
  const antes = (lerEstado(e.sessao, 'revisado') || {}).linhas || {};
  let linhas = 0;
  const sensiveis = [];
  for (const a of e.arquivos) {
    const d = Math.abs((e.agora[a.chave] || 0) - (antes[a.chave] || 0));
    if (!d) continue;
    linhas += d;
    if (a.sensivel) sensiveis.push(a.rel);
  }
  for (const k of Object.keys(antes)) if (!(k in e.agora)) linhas += antes[k] || 0;
  // Dispensada ou já cobrada nesta resposta: o que está aí conta como visto, e a trava não
  // volta nas respostas seguintes pelas mesmas linhas.
  const dispensar = (registro) => {
    gravarEstado(e.sessao, 'revisado', { em: Date.now(), linhas: e.agora, dispensada: true });
    return registro ? { bloquear: false, registro } : null;
  };
  const pedido = lerEstado(chaveDaChamada(entrada), 'pedido');
  if (pedido && pedido.semRevisao) return linhas ? dispensar('dispensada') : null;
  if (linhas <= LIMITE_LINHAS && !sensiveis.length) return null;
  if (entrada.stop_hook_active) return dispensar('concluiu-sem-revisao');
  const motivos = [];
  if (linhas > LIMITE_LINHAS) motivos.push(`${linhas} linhas mudadas sem revisão`);
  if (sensiveis.length) motivos.push(`área sensível: ${[...new Set(sensiveis)].slice(0, 5).join(', ')}`);
  return {
    bloquear: true,
    motivo: `Trava da equipe: chame o revisor antes de concluir (${motivos.join('; ')}). Grave o diff com git diff HEAD --output=.revisao/diff.patch e passe o caminho e os arquivos novos no briefing${sensiveis.length ? ', com model opus' : ''}. Se você ainda não terminou (vai perguntar algo ao usuário ou esperar uma resposta), diga isso e encerre de novo: a trava não volta por estas linhas. Se o usuário disse "sem revisão", ela também não vale.`,
    registro: 'barrou',
  };
}
