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
  anotacoes, anotar, apagarEstado, briefingDaTranscricao, caminhoReal, chaveDaChamada, desligada, ehAgenteDeRevisao, ehCodigo, git,
  gravarEstado, lerEstado, lerTexto, limparChamada, marcaDoTexto, normalizar, relatorioDaChamada, statusDoRelatorio,
  tipoDoAgente, ultimaFalaDoMestre,
} from './equipe-comum.mjs';

const LIMITE_LINHAS = 50;
// Não é código, mas muda o que roda: dependências e configuração do analisador e dos tipos.
export const CONTA_COMO_CODIGO = /(^|\/)(pubspec\.yaml|package\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|Cargo\.toml|Gemfile|[^/]+\.csproj|analysis_options\.yaml|tsconfig[^/]*\.json|\.eslintrc[^/]*|Dockerfile|docker-compose[^/]*\.ya?ml|AndroidManifest\.xml|Info\.plist)$|\.(prisma|graphql|gql|proto|html?|css|scss|sass|less|xml)$/i;
// Teste volta com um clique: não pede revisor (a não ser em área sensível).
const ARQUIVO_DE_TESTE = /(^|\/)(test|tests|spec|specs|__tests__|testes|integration_test)\/|[._-](test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]*$/i;
// Mais que isto mudado desde a base (troca de branch, por exemplo): vale só o que a sessão
// editou pelas ferramentas.
const MAX_MUDADOS = 400;

export function chaveDaSessao(entrada) {
  const sessao = String((entrada && entrada.session_id) || '').replace(/[^A-Za-z0-9_-]/g, '');
  return sessao ? `${sessao}-sessao` : null;
}

export const raizGit = (cwd) => git(['rev-parse', '--show-toplevel'], cwd || process.cwd());
const posix = (p) => String(p).replace(/\\/g, '/');
const espacos = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// ---------- anotações depois das ferramentas ----------

const TESTE = /\b(flutter|dart)\s+(test|analyze)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|check)\b|\bnpx\s+(vitest|jest|tsc|eslint|playwright)\b|\b(vitest|jest|pytest|mypy|tsc|eslint)\b|\bpython\d*(\.exe)?\s+-m\s+(pytest|unittest|mypy)\b|\bnode(\.exe)?\s+--test\b|\bgo\s+(test|vet)\b|\bcargo\s+(test|check|clippy)\b|\bruff\s+check\b|\bInvoke-Pester\b|\bdotnet\s+(test|build)\b|\bmvn\w*\s+(test|verify)\b|\bgradlew?\w*\s+\S*test/i;
// O programa de teste tem de ser o comando, não um argumento: "cat jest.config.js" e
// "grep -rn pytest ." não são verificação. Aceita npx, pnpm exec e caminho (./gradlew).
const TESTE_NO_INICIO = new RegExp(`^(?:(?:npx|bunx|pnpm\\s+(?:exec|dlx)|yarn(?:\\s+run)?|uv\\s+run|poetry\\s+run)\\s+)?(?:\\S*[\\\\/])?(?:${TESTE.source})`, 'i');

export function ehVerificacao(comando, lista) {
  const c = espacos(comando);
  if (!c) return false;
  const linhas = (lista || []).map(espacos).filter(Boolean);
  const daLista = (s) => linhas.some((l) => s === l || s.startsWith(`${l} `));
  if (daLista(c)) return true;
  for (const parte of c.split(/\s*(?:&&|\|\||;|\|)\s*/)) {
    // Variáveis antes do comando (CI=1 npm test) não contam.
    const seg = parte.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '').trim();
    if (seg && (daLista(seg) || TESTE_NO_INICIO.test(seg))) return true;
  }
  return false;
}

// Depois de Edit, Write e do terminal. lista = comandos do verificador (ou null).
export function anotarFerramenta(entrada, lista) {
  const nome = String(entrada.tool_name || '');
  const tipo = tipoDoAgente(entrada);
  const ti = entrada.tool_input || {};
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(nome)) {
    const arq = String(ti.file_path || ti.notebook_path || '');
    if (!arq) return;
    // Caminho real: no Windows, o mesmo lugar vem com nome curto (RUNNER~1) de um lado e
    // longo do git, do outro.
    const absoluto = caminhoReal(path.resolve(entrada.cwd || process.cwd(), arq));
    if (tipo === 'implementador') {
      const chave = chaveDaChamada(entrada);
      if (ehCodigo(arq)) anotar(chave, 'editou', Date.now());
      anotar(chave, 'arquivos', absoluto);
    }
    if (tipo === 'implementador' || tipo === 'mestre') {
      const sessao = chaveDaSessao(entrada);
      // Base do repositório (se o envio do pedido ainda não a gravou): o commit de agora e o
      // que já estava mudado, fora o arquivo que a sessão acabou de editar.
      const raiz = raizGit(path.dirname(absoluto));
      if (raiz) inicioDaSessao(entrada, raiz, [posix(path.relative(caminhoReal(raiz), absoluto))]);
      // A raiz vai junto: no fim, não é preciso perguntar ao git de novo por pasta.
      anotar(sessao, 'edicoes', raiz ? `${raiz}\t${absoluto}` : absoluto);
    }
    return;
  }
  if (/^(Bash|PowerShell)$/.test(nome) && tipo === 'implementador' && ehVerificacao(ti.command, lista)) {
    anotar(chaveDaChamada(entrada), 'verificou', Date.now());
  }
}

// Começo da sessão num repositório: guarda o commit de agora (a base) e o conteúdo do que já
// estava mudado (do usuário, de outra sessão), que não é desta sessão enquanto não mudar de
// novo. Roda no envio do pedido e, se ele não rodou, na primeira edição. Devolve a raiz.
export function inicioDaSessao(entrada, raizDada = null, excluir = []) {
  const sessao = chaveDaSessao(entrada);
  if (!sessao) return null;
  const raiz = raizDada || raizGit(entrada.cwd || process.cwd());
  if (!raiz) return null;
  const bases = lerEstado(sessao, 'base') || {};
  if (bases[raiz]) return raiz;
  bases[raiz] = git(['rev-parse', 'HEAD'], raiz) || 'HEAD';
  gravarEstado(sessao, 'base', bases);
  const status = statusDe(raiz) || {};
  const fora = new Set(excluir);
  const nomes = Object.keys(status).filter((n) => !fora.has(n)).slice(0, 2000);
  const h = hashes(raiz, nomes);
  const sujos = lerEstado(sessao, 'sujos') || {};
  // Sem os hashes (git lento), o que estava mudado fica como "da sessão anterior" de vez ('?').
  sujos[raiz] = Object.fromEntries(nomes.map((n) => [n, h ? h[n] || '-' : '?']));
  gravarEstado(sessao, 'sujos', sujos);
  return raiz;
}

// Arquivos mudados desde a base: no git (diff contra a base, o que já foi commitado também)
// e os novos fora do git que não são ignorados. null se o git falhou.
function mudadosDesdeBase(raiz, base) {
  const d = git(['diff', '--name-only', '--no-renames', '-z', base || 'HEAD'], raiz, 4000);
  if (d === null) return null;
  const r = new Set(d.split('\0').filter(Boolean));
  const u = git(['ls-files', '--others', '--exclude-standard', '-z'], raiz, 4000);
  if (u === null) return null;
  const novos = new Set(u.split('\0').filter(Boolean));
  for (const n of novos) r.add(n);
  return { mudados: r, novos };
}

// Base de verdade: o commit do começo da sessão, ou o HEAD depois do último merge, pull,
// checkout ou rebase feito desde então (o que chegou de outra pessoa não é desta sessão).
// Pelo reflog: andando do mais novo para o mais velho, o primeiro movimento que não é commit
// antes de chegar à base.
export function baseEfetiva(raiz, base) {
  if (!base || base === 'HEAD') return base || 'HEAD';
  const r = git(['reflog', '-n', '60', '--format=%H%x09%gs', 'HEAD'], raiz);
  if (!r) return base;
  const linhas = r.split(/\r?\n/).map((l) => l.split('\t')).filter(([sha]) => sha);
  for (let i = 0; i < linhas.length; i++) {
    const [sha, acao = ''] = linhas[i];
    if (sha === base) return base;
    // Movimento que não mudou o HEAD (stash, checkout -b, reset para o mesmo commit): não conta.
    const anterior = linhas[i + 1] ? linhas[i + 1][0] : null;
    if (anterior === sha) continue;
    if (!/^commit( \((amend|initial)\))?:/.test(acao)) return sha;
  }
  return base;
}

// O que esta sessão mudou, por repositório: o que ela editou pelas ferramentas mais o que
// mudou no git desde a base (por comando de terminal, por outro agente, por um plugin),
// tirando o que já estava mudado antes dela e não mudou de novo.
// Devolve um Map raiz -> Set de caminhos relativos.
export function arquivosDaSessao(sessao) {
  const porRaiz = new Map();
  const juntar = (raiz, rel) => {
    if (!rel || rel.startsWith('..') || /^\.revisao\//.test(rel)) return;
    if (!porRaiz.has(raiz)) porRaiz.set(raiz, new Set());
    porRaiz.get(raiz).add(rel);
  };
  const raizDaPasta = new Map();
  for (const linha of [...new Set(anotacoes(sessao, 'edicoes'))]) {
    // "raiz<TAB>arquivo" (ou só o arquivo, do formato antigo).
    const [r, a] = linha.includes('\t') ? linha.split('\t') : [null, linha];
    let raiz = r;
    if (!raiz) {
      const pasta = path.dirname(a);
      if (!raizDaPasta.has(pasta)) {
        if (raizDaPasta.size >= 50) continue;
        raizDaPasta.set(pasta, fs.existsSync(pasta) ? raizGit(pasta) : null);
      }
      raiz = raizDaPasta.get(pasta);
    }
    if (raiz) juntar(raiz, posix(path.relative(caminhoReal(raiz), caminhoReal(a))));
  }
  const bases = lerEstado(sessao, 'base') || {};
  const sujos = lerEstado(sessao, 'sujos') || {};
  for (const [raiz, base] of Object.entries(bases)) {
    if (typeof base !== 'string' || !fs.existsSync(raiz)) continue;
    const m = mudadosDesdeBase(raiz, baseEfetiva(raiz, base));
    if (!m || m.mudados.size > MAX_MUDADOS) continue;
    novosDaRaiz.set(raiz, m.novos);
    const antes = sujos[raiz] || {};
    const h = hashes(raiz, [...m.mudados].filter((n) => n in antes));
    for (const n of m.mudados) {
      // Já estava mudado antes da sessão e não mudou de novo (sem hash: não dá para saber,
      // então fica de fora).
      if (n in antes && (!h || antes[n] === '?' || (h[n] || '-') === antes[n])) continue;
      juntar(raiz, n);
    }
  }
  return porRaiz;
}
// Os arquivos novos (fora do git, não ignorados) de cada raiz, do último arquivosDaSessao.
const novosDaRaiz = new Map();

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

// Hash do conteúdo de cada arquivo (o do git). null se o git falhou ou acabou o tempo: quem
// chama trata como "não dá para saber" e deixa passar.
export function hashes(raiz, nomes) {
  const r = {};
  const existentes = nomes.filter((n) => { try { return fs.statSync(path.join(raiz, n)).isFile(); } catch { return false; } }).slice(0, 2000);
  if (!existentes.length) return r;
  const saida = git(['hash-object', '--', ...existentes], raiz, 4000);
  if (saida === null) return null;
  saida.split(/\r?\n/).forEach((h, i) => { if (existentes[i]) r[existentes[i]] = h.trim(); });
  return r;
}

export function fotoInicial(entrada) {
  const chave = chaveDaChamada(entrada);
  const raiz = raizGit(entrada.cwd);
  if (!chave || !raiz) return false;
  const status = statusDe(raiz);
  if (!status) return false;
  gravarEstado(chave, 'foto', { raiz, status, hashes: hashes(raiz, Object.keys(status)) || {} });
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
  if (depois) for (const n of antes) if ((foto.hashes[n] || null) !== (depois[n] || null)) alterados.add(n);
  return [...alterados].sort();
}

// Escopo de um briefing: os caminhos do "Escopo", sem a parte depois de "fora do escopo".
// [] se não há escopo com caminho.
export function escopoDoTexto(texto) {
  const s = secoes(texto || '');
  if (!s.escopo) return [];
  const pode = s.escopo.split(/fora(?: do escopo)?\s*[:\-–]|nao (?:pode|toque|mexa)/)[0];
  return caminhos(pode);
}

// Escopo do briefing, lido da primeira mensagem da transcrição do subagente.
export function escopoDoBriefing(arquivoTranscricao) {
  const t = briefingDaTranscricao(arquivoTranscricao);
  return t === null ? null : escopoDoTexto(t);
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
// Cada lista fica guardada com a marca do briefing, para chegar ao mestre certa mesmo com
// vários implementadores (e os de segundo plano).
export function relatorioDeEscopo(entrada, { semVerificar = false } = {}) {
  const chave = chaveDaChamada(entrada);
  const foto = lerEstado(chave, 'foto');
  if (!foto || !foto.raiz) return null;
  const alterados = alteradosDesde(foto);
  if (!alterados) return null;
  const chaveRel = (r) => normalizar(posix(r));
  const raizReal = caminhoReal(foto.raiz);
  const proprios = new Set(anotacoes(chave, 'arquivos').map((f) => chaveRel(path.relative(raizReal, caminhoReal(f)))));
  const dele = alterados.filter((a) => proprios.has(chaveRel(a)));
  const outros = alterados.filter((a) => !proprios.has(chaveRel(a)));
  const briefing = briefingDaTranscricao(entrada.agent_transcript_path);
  const escopo = briefing === null ? null : escopoDoTexto(briefing);
  const fora = escopo && escopo.length ? dele.filter((a) => !dentroDoEscopo(a, escopo, foto.raiz)) : [];
  const lista = (xs) => `${xs.slice(0, 40).join(', ')}${xs.length > 40 ? ' ...' : ''}`;
  const objetivo = briefing ? (secoes(briefing).objetivo || '').split('\n')[0].slice(0, 80) : '';
  const l = [`Escopo conferido pela equipe (fim do implementador, ${new Date().toISOString().slice(0, 16).replace('T', ' ')}${objetivo ? `, objetivo: ${objetivo}` : ''}):`];
  l.push(`- Arquivos que o implementador editou (${dele.length}): ${dele.length ? lista(dele) : 'nenhum'}`);
  if (outros.length) l.push(`- Outras mudanças na pasta durante a tarefa (${outros.length}), de outro agente, do mestre ou de um comando: ${lista(outros)}. Confira de quem são antes do commit.`);
  if (escopo === null || !escopo.length) l.push('- O briefing não tinha "Escopo" com caminhos: confira a lista acima com o pedido.');
  else if (fora.length) l.push(`- FORA DO ESCOPO (${fora.length}): ${fora.join(', ')}. Não entram no commit sem o OK do usuário; descartar também só com o OK dele.`);
  else l.push('- Os arquivos que ele editou estão dentro do escopo do briefing.');
  if (semVerificar) l.push('- Ele entregou sem rodar a verificação depois da última edição: confira antes do commit.');
  const texto = l.join('\n');
  const sessao = chaveDaSessao(entrada);
  const id = briefing ? marcaDoTexto(briefing) : `sem-briefing-${Date.now()}`;
  anotar(sessao, 'escopos', JSON.stringify({ id, em: Date.now(), raiz: foto.raiz, texto, fora: fora.length, semVerificar }));
  // .revisao/escopo.md: as listas desta sessão neste repositório, a mais nova primeiro.
  const daRaiz = listasDeEscopo(sessao).filter((x) => x.raiz === foto.raiz).slice(-8).reverse();
  try { fs.writeFileSync(path.join(garantirRevisao(foto.raiz), 'escopo.md'), `${daRaiz.map((x) => x.texto).join('\n\n')}\n`); } catch { /* segue */ }
  return { texto, fora: fora.length };
}

function listasDeEscopo(sessao) {
  return anotacoes(sessao, 'escopos').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && x.id && x.texto);
}

// Depois de qualquer ferramenta do mestre, no envio do pedido e no fim da resposta: entrega as
// listas de escopo que ele ainda não recebeu (o implementador em primeiro plano que acabou de
// terminar e os de segundo plano que terminaram desde então), uma vez cada. soComProblema: só
// as que têm algo fora do escopo ou entrega sem verificação (as que barram o fim).
export function escopoParaMestre(entrada, { soComProblema = false } = {}) {
  if (tipoDoAgente(entrada) !== 'mestre' || desligada('escopo')) return null;
  const sessao = chaveDaSessao(entrada);
  if (!sessao) return null;
  const entregues = new Set(anotacoes(sessao, 'escopos-entregues'));
  const pendentes = listasDeEscopo(sessao).filter((x) => !entregues.has(`${x.id}|${x.em}`) && Date.now() - x.em < 6 * 3600000 && (!soComProblema || x.fora || x.semVerificar));
  if (!pendentes.length) return null;
  for (const x of pendentes) anotar(sessao, 'escopos-entregues', `${x.id}|${x.em}`);
  // A do briefing desta chamada vem primeiro.
  const ti = entrada.tool_input || {};
  const id = /^(Agent|Task)$/.test(String(entrada.tool_name || '')) && ti.prompt ? marcaDoTexto(ti.prompt) : null;
  pendentes.sort((a, b) => (a.id === id ? -1 : 0) - (b.id === id ? -1 : 0) || b.em - a.em);
  return `${pendentes.slice(0, 4).map((x) => x.texto).join('\n\n')}\n(As listas também estão em .revisao/escopo.md.)`;
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
  if (!desligada('escopo')) { try { escopo = relatorioDeEscopo(entrada, { semVerificar }); } catch { escopo = null; } }
  // Os arquivos que ele editou (a convergência conta a tentativa por eles).
  const editados = [...new Set(anotacoes(chave, 'arquivos'))];
  limparChamada(chave);
  if (semVerificar) return { bloquear: false, registro: 'entregou-sem-verificar', escopo, editados };
  return { bloquear: false, registro: escopo && escopo.fora ? 'fora-do-escopo' : 'passou', escopo, editados };
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
// Git com erro ou sem tempo: o arquivo fica sem conta (não vira mudança).
function linhasPorArquivo(raiz, base, arquivos) {
  const r = {};
  if (!arquivos.length) return r;
  const saida = git(['diff', '--numstat', '--no-color', '--no-ext-diff', baseEfetiva(raiz, base || 'HEAD'), '--', ...arquivos], raiz, 4000);
  if (saida === null) return null;
  for (const l of saida.split(/\r?\n/)) {
    const m = l.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (m) r[m[3]] = (Number(m[1]) || 0) + (Number(m[2]) || 0);
  }
  // Arquivo novo (fora do git e não ignorado): todas as linhas contam. A lista vem de uma vez
  // só (ls-files --others), não de um git por arquivo.
  let novos = novosDaRaiz.get(raiz);
  if (!novos) {
    const u = git(['ls-files', '--others', '--exclude-standard', '-z'], raiz, 4000);
    if (u === null) return r;
    novos = new Set(u.split('\0').filter(Boolean));
  }
  for (const a of arquivos) {
    if (a in r || !novos.has(a)) continue;
    const t = lerTexto(path.join(raiz, a));
    if (t !== null) r[a] = t.split('\n').length;
  }
  return r;
}

// Mudanças da sessão agrupadas por repositório (um worktree é um repositório à parte), com
// as linhas mudadas de cada arquivo desde a base daquele repositório. arquivos: o Map de
// arquivosDaSessao, quando quem chama já o tem.
export function estadoDaRevisao(entrada, arquivos = null) {
  const sessao = chaveDaSessao(entrada);
  if (!sessao) return null;
  const porRaiz = arquivos || arquivosDaSessao(sessao);
  if (!porRaiz.size) return null;
  const bases = lerEstado(sessao, 'base') || {};
  const agora = {};
  const conteudo = {};
  const lista = [];
  // Repositórios em que o git falhou ou ficou sem tempo: não dá para saber o que mudou.
  const incertos = new Set();
  for (const [raiz, rels] of porRaiz) {
    // Faixa pelo custo de desfazer: texto, documentação e testes voltam com um clique e não
    // pedem revisor; código do produto, schema, telas, manifesto e configuração do analisador
    // contam; área sensível, sempre.
    const areasRaiz = areasDoProjeto(raiz);
    const contam = [...rels].filter((r) => ehSensivel(r, areasRaiz) || ((ehCodigo(r) || CONTA_COMO_CODIGO.test(r)) && !ARQUIVO_DE_TESTE.test(r)));
    if (!contam.length) continue;
    const linhasOuNada = linhasPorArquivo(raiz, typeof bases[raiz] === 'string' ? bases[raiz] : 'HEAD', contam);
    // O conteúdo de cada arquivo (hash do git): um commit não muda o conteúdo, então o que
    // foi revisado e só commitado depois não conta como mudança nova.
    const hOuNada = hashes(raiz, contam);
    if (linhasOuNada === null || hOuNada === null) incertos.add(raiz);
    const linhas = linhasOuNada || {};
    const h = hOuNada || {};
    for (const rel of contam) {
      const chave = `${raiz}|${rel}`;
      // Sem hash (git lento ou com erro), fica de fora: a conta volta a ser por linhas.
      if (h[rel]) conteudo[chave] = h[rel];
      if (linhas[rel]) agora[chave] = linhas[rel];
      lista.push({ chave, raiz, rel, sensivel: ehSensivel(rel, areasRaiz) });
    }
  }
  return { sessao, agora, conteudo, arquivos: lista, incertos };
}

// Começo de um revisor: a foto do que ele vai ver. É ela que fica como "revisado" se ele
// aprovar; o que mudar enquanto ele lê conta como mudança nova.
export function fotoDaRevisao(entrada) {
  const e = estadoDaRevisao(entrada);
  if (!e) return false;
  gravarEstado(chaveDaChamada(entrada), 'foto-revisao', { em: Date.now(), linhas: e.agora, conteudo: e.conteudo });
  return true;
}

// O revisor aprovou: guarda as linhas e o conteúdo revisados (a foto do começo dele, se
// houver), para medir o que mudou depois.
export function anotarRevisao(entrada) {
  const foto = lerEstado(chaveDaChamada(entrada), 'foto-revisao');
  if (foto && typeof foto.em === 'number' && Date.now() - foto.em < 6 * 3600000) {
    gravarEstado(chaveDaSessao(entrada), 'revisado', { em: Date.now(), linhas: foto.linhas || {}, conteudo: foto.conteudo || {} });
    return true;
  }
  const e = estadoDaRevisao(entrada);
  if (!e) return false;
  gravarEstado(e.sessao, 'revisado', { em: Date.now(), linhas: e.agora, conteudo: e.conteudo });
  return true;
}

// Veredito negativo de um revisor que não usa o nosso formato (o de um plugin).
const NEGATIVO = /\b(reprovad[oa]s?|rejeitad[oa]s?|rejected|request(ed)? changes|changes requested|nao aprovad[oa]|nao aprovo)\b/;

// Achados do relatório do revisor, curtos, para o mestre (o que vem depois de "Achados").
function trechoDosAchados(relatorio) {
  const linhas = String(relatorio || '').split(/\r?\n/);
  const i = linhas.findIndex((l) => /achados|findings/i.test(l));
  const corpo = (i >= 0 ? linhas.slice(i, i + 6) : linhas.slice(0, 5)).map((l) => l.trim()).filter(Boolean);
  const t = corpo.join(' ').replace(/\s+/g, ' ');
  return t.length > 600 ? `${t.slice(0, 600)}...` : t;
}

// Fim de um revisor (o da equipe ou o de um projeto): só a aprovação conta como revisão.
// Devolve o registro: aprovou, reprovou ou sem-veredito.
export function fimDaRevisao(entrada) {
  const tipo = tipoDoAgente(entrada);
  const relatorio = relatorioDaChamada(entrada);
  let status = statusDoRelatorio('revisor', relatorio);
  // O revisor de um plugin escreve do jeito dele: conta, a não ser que diga que reprova.
  if (status === 'sem veredito' && tipo !== 'revisor') status = NEGATIVO.test(normalizar(relatorio)) ? 'reprovado' : 'aprovado';
  const sessao = chaveDaSessao(entrada);
  if (status === 'aprovado' || status === 'aprovado com ressalvas') {
    // Com dois revisores em paralelo, a aprovação de um não apaga a reprovação do outro: só a
    // que veio antes de este começar.
    const foto = lerEstado(chaveDaChamada(entrada), 'foto-revisao');
    const comecou = foto && typeof foto.em === 'number' ? foto.em : Date.now();
    anotarRevisao(entrada);
    const r = lerEstado(sessao, 'reprovada');
    if (!r || typeof r.em !== 'number' || r.em <= comecou) apagarEstado(sessao, 'reprovada');
    return 'aprovou';
  }
  if (status === 'reprovado') {
    gravarEstado(sessao, 'reprovada', { em: Date.now(), achados: trechoDosAchados(relatorio) });
    return 'reprovou';
  }
  return 'sem-veredito';
}

// A última fala do mestre é uma pausa (pergunta ao usuário, espera de resposta)? Pausa de
// verdade: diz que não terminou, espera uma decisão, pergunta qual caminho. A fala de
// conclusão ("pronto", "feito", "corrigi") ou a oferta de envio no fim ("quer que eu envie?",
// "faço o commit?") não é pausa, mesmo terminando em pergunta: a regra manda deixar o pedido
// de aprovação para o fim da entrega.
const PAUSA_FORTE = /\b(ainda nao terminei|nao terminei|ainda falta|vou aguardar|aguardo (a )?sua|aguardando (a )?sua|esperando (a )?sua|preciso (da sua|que voce)|(qual|como|o que) (\S+ ){0,3}prefere|pode me dizer|sigo com|continuo com|metade|primeira parte)\b/;
const CONCLUSAO = /\b(pronto|feito|conclui|concluid[oa]s?|terminei|terminad[oa]s?|implementei|implementad[oa]s?|corrigi|corrigid[oa]s?|entreguei|entregues?|verificad[oa]s?|finalizei|finalizad[oa]s?|push|commit|envie|envio|enviar|mande|mandar|suba|subir|publique|publicar)\b/;
const PAUSA_FRACA = /\b(me (diga|confirme|avise)|posso (seguir|continuar|prosseguir)|quer que eu)\b/;
export function ehPausa(entrada) {
  const fala = typeof entrada.last_assistant_message === 'string' && entrada.last_assistant_message.trim()
    ? entrada.last_assistant_message
    : ultimaFalaDoMestre(entrada.transcript_path);
  const t = String(fala || '').trim();
  if (!t) return false;
  const fim = normalizar(t.slice(-600));
  if (PAUSA_FORTE.test(fim)) return true;
  if (CONCLUSAO.test(fim)) return false;
  return /\?\s*[*_`)\]]*\s*$/.test(t) || PAUSA_FRACA.test(fim);
}

// Um revisor ainda rodando em segundo plano (o Stop das versões novas traz a lista)? O
// veredito vem depois, e a parada não é conclusão sem revisão.
export function revisorEmSegundoPlano(entrada) {
  const tarefas = Array.isArray(entrada.background_tasks) ? entrada.background_tasks : [];
  return tarefas.some((t) => t && typeof t === 'object' && ehAgenteDeRevisao(t.agent_type) && !/^(completed|failed|killed|stopped|cancelled)$/i.test(String(t.status || '')));
}

// Stop do mestre: { bloquear, motivo, registro } ou null. arquivos: o Map de
// arquivosDaSessao, quando quem chama já o tem.
export function revisaoNoFim(entrada, arquivos = null) {
  if (desligada('revisao') || tipoDoAgente(entrada) !== 'mestre') return null;
  const e = estadoDaRevisao(entrada, arquivos);
  if (!e) return null;
  const revisado = lerEstado(e.sessao, 'revisado') || {};
  const antes = revisado.linhas || {};
  const conteudoAntes = revisado.conteudo || null;
  let linhas = 0;
  const sensiveis = [];
  for (const a of e.arquivos) {
    // Git com erro ou sem tempo neste repositório: deixa passar.
    if (e.incertos.has(a.raiz)) continue;
    if (conteudoAntes) {
      const hAntes = conteudoAntes[a.chave];
      const hAgora = e.conteudo[a.chave];
      // Conteúdo igual ao da revisão (talvez só commitado): nada novo neste arquivo.
      if (hAntes && hAgora && hAntes === hAgora) continue;
      // Sem um dos dois hashes (arquivo apagado, git com erro): conta por linhas, como antes.
      if (!hAntes || !hAgora) {
        const d = Math.abs((e.agora[a.chave] || 0) - (antes[a.chave] || 0)) || (hAntes || hAgora ? 1 : 0);
        if (!d) continue;
        linhas += d;
        if (a.sensivel) sensiveis.push(a.rel);
        continue;
      }
      // Mudou depois da revisão: conta a diferença de linhas (pelo menos uma).
      const d = Math.max(1, Math.abs((e.agora[a.chave] || 0) - (antes[a.chave] || 0)));
      linhas += d;
      if (a.sensivel) sensiveis.push(a.rel);
      continue;
    }
    const d = Math.abs((e.agora[a.chave] || 0) - (antes[a.chave] || 0));
    if (!d) continue;
    linhas += d;
    if (a.sensivel) sensiveis.push(a.rel);
  }
  // Dispensada ou já cobrada nesta resposta: o que está aí conta como visto, e a trava não
  // volta nas respostas seguintes pelas mesmas linhas.
  const dispensar = (registro) => {
    gravarEstado(e.sessao, 'revisado', { em: Date.now(), linhas: e.agora, conteudo: e.conteudo, dispensada: true });
    return registro ? { bloquear: false, registro } : null;
  };
  const pedido = lerEstado(chaveDaChamada(entrada), 'pedido');
  if (pedido && pedido.semRevisao) return linhas ? dispensar('dispensada') : null;
  // O revisor ainda roda em segundo plano: nem cobra, nem dispensa; o veredito decide depois.
  if ((linhas > LIMITE_LINHAS || sensiveis.length || lerEstado(e.sessao, 'reprovada')) && revisorEmSegundoPlano(entrada)) {
    return { bloquear: false, registro: 'revisor-rodando' };
  }
  // O revisor reprovou e ninguém resolveu: cobra uma vez, com os achados.
  const reprovada = lerEstado(e.sessao, 'reprovada');
  if (reprovada && !reprovada.cobrada) {
    gravarEstado(e.sessao, 'reprovada', { ...reprovada, cobrada: true });
    if (entrada.stop_hook_active) return dispensar('concluiu-com-reprovacao');
    return {
      bloquear: true,
      motivo: `Trava da equipe: o revisor reprovou a mudança (${reprovada.achados || 'veja o relatório dele'}). Corrija com o implementador e chame o revisor de novo, ou mostre os achados ao usuário e diga que ficou pendente; depois encerre de novo (a trava não volta por esta revisão).`,
      registro: 'reprovou',
    };
  }
  if (linhas <= LIMITE_LINHAS && !sensiveis.length) return null;
  // Assinatura do código de agora, para saber se nada mudou desde a última pausa.
  const assinatura = Object.entries(e.conteudo).sort((x, y) => x[0].localeCompare(y[0])).map(([k, v]) => `${k}=${v}`).join('|');
  if (entrada.stop_hook_active) {
    // Parou para perguntar ou esperar o usuário: não é conclusão. As linhas continuam
    // pedindo revisão até ele concluir.
    if (ehPausa(entrada)) {
      gravarEstado(e.sessao, 'revisao-pausa', { em: Date.now(), assinatura });
      return { bloquear: false, registro: 'pausou-sem-revisao' };
    }
    apagarEstado(e.sessao, 'revisao-pausa');
    return dispensar('concluiu-sem-revisao');
  }
  // Depois de uma pausa, com o mesmo código: a cobrança já veio. Outra pergunta passa (uma
  // conversa de perguntas e respostas não vira uma cobrança por resposta), e a conclusão
  // dispensa sem barrar de novo.
  const pausa = lerEstado(e.sessao, 'revisao-pausa');
  if (pausa && pausa.assinatura === assinatura) {
    if (ehPausa(entrada)) return { bloquear: false, registro: 'pausou-sem-revisao' };
    apagarEstado(e.sessao, 'revisao-pausa');
    return dispensar('concluiu-sem-revisao');
  }
  const motivos = [];
  if (linhas > LIMITE_LINHAS) motivos.push(`${linhas} linhas mudadas sem revisão`);
  if (sensiveis.length) motivos.push(`área sensível: ${[...new Set(sensiveis)].slice(0, 5).join(', ')}`);
  return {
    bloquear: true,
    motivo: `Trava da equipe: chame o revisor (o da equipe ou o do projeto) antes de concluir (${motivos.join('; ')}). Grave o diff com git diff HEAD --output=.revisao/diff.patch e passe o caminho e os arquivos novos no briefing${sensiveis.length ? ', com model opus' : ''}. Só a aprovação do revisor conta. Se você ainda não terminou (vai perguntar algo ao usuário ou esperar uma resposta), diga isso e encerre de novo: enquanto o código não mudar, a trava não volta. Se o usuário disse "sem revisão", ela também não vale.`,
    registro: 'barrou',
  };
}
