#!/usr/bin/env node
// Mede como a equipe trabalhou nas sessões recentes do Claude Code, para a /retro-equipe.
//
// Lê as transcrições em <pasta do Claude>/projects (sessão principal e subagentes) e
// tira só metadados: tokens e custo por agente, ferramentas usadas, status dos
// relatórios, bloqueios da guarda, compactações, esperas prováveis por aprovação, se o
// Explore e o revisor consultaram o mapa antes de ler código e quantos arquivos de código o
// mestre leu por pedido. Lê também o registro das travas (<pasta do Claude>/equipe-diario/
// travas-AAAA-MM.log), que só tem decisões e tempos.
// O conteúdo das conversas (pedidos, código, arquivos) nunca vai para a saída.
//
// Uso:
//   node equipe-medir.mjs [--dias 7] [--projeto texto] [--json]
//   node equipe-medir.mjs --retro                 mede, compara com a última retro e guarda a medição
//   node equipe-medir.mjs --testar-trava <nome>   desliga uma trava testável por 7 dias (teste da retro)
//   node equipe-medir.mjs --fim-teste             encerra o teste antes da hora
//   node equipe-medir.mjs --guardar-propostas F   guarda as propostas da retro (arquivo .md)
//   node equipe-medir.mjs --ultima                mostra a última retro guardada
// Opções para teste: --raiz <pasta projects> (EQUIPE_PASTA_CLAUDE muda a pasta do Claude).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pastaClaude, pastaDiario, lerJson, lerTexto, desligada, DIAS_TESTE, ehCodigo, EXTENSOES_CODIGO, normalizar, registrarTrava, statusDoRelatorio, TESTE_DE_VERDADE, testeValido, TRAVAS_TESTAVEIS } from './equipe-comum.mjs';

// Briefing de correção de bug (só o sim ou não sai daqui, nunca o texto): "bug" ou
// "regressão", ou "corrigir"/"consertar" perto de erro, falha ou quebra. "Corrigir o texto"
// não conta.
const PEDE_CORRECAO = /\b(bug|bugs|regress\w*)\b|\b(corrig\w*|corre[cç][aã]o|consert\w*|fix|fixes)\b[^.\n]{0,50}\b(erro|errado|falha\w*|quebr\w*|problema|crash|exce[cç][aã]o|bug)/;
// Só teste de verdade: analisador, lint e checagem de tipos não reproduzem o bug.
// TESTE_DE_VERDADE (comando que roda testes de verdade) vem do equipe-comum.mjs, o mesmo da prova.
// Arquivo de teste: a edição dele não é "a correção".
const ARQUIVO_DE_TESTE = /(^|[\\/])(test|tests|spec|specs|__tests__|testes)[\\/]|[._-](test|spec)\.[a-z0-9]+$|^test_[^\\/]*$|[\\/]test_[^\\/]*$/i;

// ---------- opções ----------
function opcoes(argv) {
  const o = { dias: 7, projeto: '', json: false, retro: false, propostas: '', ultima: false, raiz: '', testarTrava: '', fimTeste: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dias') o.dias = Math.max(1, Number(argv[++i]) || 7);
    else if (a === '--projeto') o.projeto = String(argv[++i] || '').toLowerCase();
    else if (a === '--json') o.json = true;
    else if (a === '--retro') o.retro = true;
    else if (a === '--guardar-propostas') o.propostas = String(argv[++i] || '');
    else if (a === '--ultima') o.ultima = true;
    else if (a === '--raiz') o.raiz = String(argv[++i] || '');
    else if (a === '--testar-trava') {
      // Sem o nome (ou com outra opção no lugar dele): erro, não a medição normal.
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) o.testarTrava = '-';
      else { o.testarTrava = String(v).toLowerCase(); i++; }
    }
    else if (a === '--fim-teste') o.fimTeste = true;
  }
  return o;
}

// ---------- preço (US$ por milhão de tokens, docs/modelos.md) ----------
// Na assinatura não se paga por token, mas a proporção mostra o que consome o limite.
const PRECOS = [
  [/fable|mythos/i, { e: 10, s: 50, l: 0.25 }],
  [/opus/i, { e: 4, s: 20, l: 0.2 }],
  [/sonnet/i, { e: 2, s: 10, l: 0.1 }],
  [/haiku/i, { e: 0.1, s: 0.5, l: 0.01, alto: { e: 0.5, s: 2.5, l: 0.05 }, limite: 100000 }],
];

function entradaTotal(u) {
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

function custo(modelo, u) {
  const achado = PRECOS.find(([re]) => re.test(modelo || ''));
  if (!achado) return 0;
  const p = achado[1];
  const t = p.alto && entradaTotal(u) > p.limite ? p.alto : p;
  const cc = u.cache_creation || {};
  const c1h = cc.ephemeral_1h_input_tokens || 0;
  const c5m = cc.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - c1h);
  return ((u.input_tokens || 0) * t.e + (u.output_tokens || 0) * t.s +
    (u.cache_read_input_tokens || 0) * t.l + c5m * t.e * 1.25 + c1h * t.e * 2) / 1e6;
}

// ---------- leitura das transcrições ----------
// Só as linhas que interessam são convertidas: o resto (pedidos, anexos) nem é lido.
const INTERESSA = ['"assistant"', 'tool_result', 'compact_boundary', 'cost-state', 'isApiErrorMessage', 'agent-message'];

// Lê em blocos de 4 MB: sessão longa pode passar do tamanho máximo de texto do Node.
function* linhas(arquivo) {
  let fd;
  try { fd = fs.openSync(arquivo, 'r'); } catch { return; }
  const bloco = Buffer.alloc(4 * 1024 * 1024);
  let resto = Buffer.alloc(0);
  try {
    for (;;) {
      const lidos = fs.readSync(fd, bloco, 0, bloco.length, null);
      if (lidos <= 0) break;
      let dados = Buffer.concat([resto, bloco.subarray(0, lidos)]);
      let inicio = 0;
      let fim;
      while ((fim = dados.indexOf(10, inicio)) !== -1) {
        const l = dados.toString('utf8', inicio, fim);
        inicio = fim + 1;
        const v = interpretar(l);
        if (v) yield v;
      }
      resto = Buffer.from(dados.subarray(inicio));
      dados = null;
    }
    if (resto.length) {
      const v = interpretar(resto.toString('utf8'));
      if (v) yield v;
    }
  } finally {
    try { fs.closeSync(fd); } catch { /* já fechado */ }
  }
}

function interpretar(l) {
  if (!l) return null;
  if (!INTERESSA.some((k) => l.includes(k))) {
    if (l.includes('"type":"user"')) return { ...pedidoLeve(l), tam: l.length };
    // Anexo (aviso de hook, arquivo anexado): só o tamanho, para a conta do custo.
    if (l.includes('"type":"attachment"')) {
      const m = l.match(/"attachment":\{"type":"([A-Za-z_-]+)"/);
      return { type: 'attachment', tipoAnexo: m ? m[1] : '', tam: l.length, uuid: campo(l, 'uuid'), timestamp: campo(l, 'timestamp') };
    }
    return null;
  }
  try { return JSON.parse(l); } catch { return null; }
}

// ---------- para onde vai o custo ----------
// Cada passo de um agente relê tudo o que está no contexto: o começo da conversa (prompt,
// regras, ferramentas), os pedidos, cada resultado de ferramenta e o que o próprio agente já
// escreveu. O custo de entrada de cada passo (o real, das mensagens) é dividido entre essas
// partes pelo tamanho de cada uma e por quantas vezes foi relida até a próxima compactação
// (a primeira vez grava no cache, as seguintes leem do cache, bem mais barato). O custo de
// saída é "o que os agentes escrevem". É uma estimativa: o tamanho vem do texto, convertido em
// tokens pela proporção que a própria sessão mostra.
export const CATEGORIAS_GASTO = {
  fixo: 'Começo de cada conversa (prompt, regras, ferramentas, resumo da compactação)',
  pedidos: 'Seus pedidos e arquivos anexados',
  avisos: 'Avisos do Claude Code e dos hooks (skills, memória, contexto)',
  leitura: 'Leitura de arquivos (Read)',
  busca: 'Buscas (Grep, Glob)',
  terminal: 'Saída de terminal (testes, git, build)',
  agentes: 'Relatórios dos subagentes',
  mapa: 'Mapa do código',
  mcp: 'Outras ferramentas MCP',
  web: 'Páginas e buscas na web',
  outras: 'Outras ferramentas',
  escrita: 'O que os agentes escrevem (resposta e chamadas de ferramenta)',
};
export function categoriaDaFerramenta(nome) {
  const n = String(nome || '');
  if (n === 'Read' || n === 'NotebookRead') return 'leitura';
  if (n === 'Grep' || n === 'Glob') return 'busca';
  if (n === 'Bash' || n === 'PowerShell' || n === 'BashOutput') return 'terminal';
  if (n === 'Agent' || n === 'Task') return 'agentes';
  if (n.startsWith('mcp__codebase-memory__')) return 'mapa';
  if (n.startsWith('mcp__')) return 'mcp';
  if (n === 'WebFetch' || n === 'WebSearch') return 'web';
  return 'outras';
}
// Comando de terminal que mostra código de um arquivo (cat, sed, Get-Content, busca com muito
// contexto, git show de um arquivo): no custo, conta como leitura de arquivos, não como saída
// de terminal. sed -i edita, não mostra.
const MOSTRA_CODIGO = /^(cat|type|get-content|gc|head|tail|less|more|bat|nl|sed|awk)$/i;
export function leCodigoPeloTerminal(comando) {
  return String(comando || '').split(/&&|\|\||;|\n|\|/).some((seg) => {
    const t = seg.trim().replace(/^\(\s*/, '').split(/\s+/);
    const prog = String(t[0] || '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
    if (MOSTRA_CODIGO.test(prog)) return !/\s-i\b/.test(seg) && t.slice(1).some((x) => ehCodigo(x.replace(/^["'(]+/, '').replace(/["')\]].*$/, '')));
    if (/^(grep|egrep|rg|select-string|sls|findstr)$/.test(prog)) return /(^|\s)(-[CAB]\s*\d{2,}|--context=\d{2,}|-context\s+\d{2,})/i.test(seg);
    if (prog === 'git') return /\bshow\s+\S+:\S+/.test(seg);
    return false;
  });
}

// Forma de um comando de terminal: o programa e o subcomando de cada parte (git push, npm
// install, rm), sem caminho nem argumento. É o que a medição mostra dos comandos barrados, e
// pode ir parar num relatório colado em outro lugar: só sai nome de listas fechadas. Programa
// fora da lista (um script do projeto, por exemplo) vira "(outro)"; subcomando fora da lista
// fica de fora.
const PROGRAMAS = new Set(`
  git npm pnpm yarn bun npx node deno python python3 py pip pip3 uv poetry flutter dart supabase gh docker
  docker-compose kubectl helm terraform cargo rustc go dotnet java javac mvn gradle gradlew firebase vercel netlify
  prisma az aws gcloud winget choco scoop brew apt apt-get make cmake ls dir cat type head tail less more grep egrep
  rg find fd sed awk cut sort uniq wc xargs echo printf cp mv rm mkdir rmdir touch chmod chown ln tar zip unzip curl
  wget ssh scp rsync ps kill pkill taskkill which where env export powershell pwsh cmd bash sh zsh code start open
  explorer tee diff patch jq yq sqlite3 psql mysql tsc eslint prettier vitest jest pytest playwright tsx vite expo
  eas adb xcodebuild pod ruby gem bundle php composer perl sudo timeout
  get-content set-content add-content get-childitem gci remove-item ri del copy-item copy move-item move new-item
  ni test-path select-string sls select-object where-object foreach-object invoke-webrequest iwr invoke-restmethod
  irm start-process stop-process get-process out-file write-output write-host invoke-pester get-location
  resolve-path join-path split-path get-item rename-item compress-archive expand-archive get-command
  import-module install-module start-sleep measure-object sort-object convertto-json convertfrom-json
`.split(/\s+/).filter(Boolean));
const SUBCOMANDOS = {
  git: 'add am apply archive bisect blame branch checkout cherry-pick clean clone commit config describe diff fetch format-patch gc grep init log ls-files ls-remote merge mv notes pull push rebase reflog remote reset restore revert rev-parse rm shortlog show sparse-checkout stash status submodule switch tag worktree fsck prune cat-file merge-base rev-list lfs',
  npm: 'install i ci add remove rm uninstall update up upgrade run run-script test t start build exec x dlx init create publish pack link unlink list ls outdated audit fund version view info cache config prune dedupe rebuild why explain doctor login logout whoami dev lint format typecheck preview serve workspace global patch',
  npx: 'vitest jest playwright tsc eslint prettier prisma vite next expo eas supabase firebase vercel wrangler tsx ts-node nx turbo knip serve rimraf',
  flutter: 'analyze build clean create devices doctor drive emulators format gen-l10n install logs pub run test upgrade config attach screenshot precache channel downgrade',
  dart: 'analyze compile create doc fix format info pub run test devtools',
  supabase: 'start stop status db migration functions gen link login init projects secrets storage branches orgs inspect seed test services',
  gh: 'pr issue repo run workflow release api auth gist browse secret variable label search codespace cache ruleset project extension status',
  docker: 'build run exec ps images pull push compose logs stop start rm rmi network volume system inspect tag login logout cp kill restart buildx context info version container image save load',
  kubectl: 'get describe apply delete logs exec port-forward rollout scale create edit config top cp set label annotate patch explain version cluster-info auth wait diff',
  cargo: 'build run test check clippy fmt add remove update install publish doc bench clean new init tree fix',
  go: 'build run test mod get install fmt vet generate clean env list work version tool',
  dotnet: 'build run test restore publish new add remove clean pack tool format watch ef sln list nuget',
  pip: 'install uninstall freeze list show download wheel check config cache',
  uv: 'pip run sync add remove lock venv tool python init build publish tree export',
  poetry: 'install add remove update run shell build publish lock show init new check config env export version',
  firebase: 'deploy emulators:start emulators:exec init login logout use serve projects:list functions:log functions:shell hosting:channel:deploy',
  vercel: 'deploy dev build env pull link login logout logs ls list inspect domains alias promote rollback redeploy remove project',
  prisma: 'generate migrate db studio format validate init version',
  gradle: 'build assemble test clean check run tasks dependencies bundleRelease assembleDebug assembleRelease installDebug lint signingReport wrapper',
  mvn: 'clean compile test package install deploy verify validate',
  az: 'login logout account group vm webapp functionapp storage keyvault aks acr ad deployment resource network sql monitor extension',
  aws: 's3 ec2 lambda iam sts cloudformation ecr ecs eks logs dynamodb rds sqs sns route53 cloudfront ssm secretsmanager configure sso',
  gcloud: 'auth config compute run functions projects app builds container sql storage iam logging pubsub secrets services components init info',
  winget: 'install uninstall upgrade search list show source settings export import pin',
  choco: 'install uninstall upgrade search list info outdated pin source config feature',
  brew: 'install uninstall upgrade update list search info doctor cleanup services tap outdated link unlink',
  apt: 'install remove purge update upgrade full-upgrade autoremove search show list policy',
};
for (const [a, b] of [['pnpm', 'npm'], ['yarn', 'npm'], ['bun', 'npm'], ['pip3', 'pip'], ['gradlew', 'gradle'], ['apt-get', 'apt']]) SUBCOMANDOS[a] = SUBCOMANDOS[b];
const LISTA_SUB = Object.fromEntries(Object.entries(SUBCOMANDOS).map(([k, v]) => [k, new Set(v.split(' '))]));

// Palavras de um comando como o terminal vê: aspas juntam ("Fulano de Tal" é uma palavra só).
function palavrasDoComando(seg) {
  const r = [];
  let atual = '';
  let tem = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '"' || c === "'") {
      const j = seg.indexOf(c, i + 1);
      const fim = j < 0 ? seg.length : j;
      atual += seg.slice(i + 1, fim);
      tem = true;
      i = fim;
    } else if (/\s/.test(c)) {
      if (tem) r.push(atual);
      atual = '';
      tem = false;
    } else {
      atual += c;
      tem = true;
    }
  }
  if (tem) r.push(atual);
  return r;
}

// Partes do comando (&&, ||, ;, | e quebra de linha), fora de aspas.
function partesDoComando(texto) {
  const partes = [];
  let atual = '';
  let aspas = null;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) { if (c === aspas) aspas = null; atual += c; continue; }
    if (c === '"' || c === "'") { aspas = c; atual += c; continue; }
    if (c === '&' && texto[i + 1] === '&') { partes.push(atual); atual = ''; i++; continue; }
    if (c === ';' || c === '|' || c === '\n' || c === '\r') { partes.push(atual); atual = ''; if (texto[i + 1] === '|') i++; continue; }
    atual += c;
  }
  partes.push(atual);
  return partes;
}

function formaDaParte(seg) {
  const t = palavrasDoComando(seg.trim());
  // Variáveis antes do programa (NOME="x" git commit) e o "&" do PowerShell não contam.
  while (t.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]) || t[0] === '&')) t.shift();
  if (!t.length) return null;
  const prog = String(t[0]).replace(/^[(]+|[)]+$/g, '').split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|ps1|bat)$/, '');
  if (/^(cd|set-location|sl|pushd|popd|chdir)$/.test(prog)) return null;
  if (!PROGRAMAS.has(prog)) return '(outro)';
  const subs = LISTA_SUB[prog];
  if (!subs) return prog;
  // O subcomando: a primeira palavra da lista. Uma palavra fora dela logo depois de uma
  // opção é o valor da opção (git -C pasta push, kubectl --context x get); senão, para.
  for (let i = 1; i < t.length; i++) {
    const w = t[i];
    if (w.startsWith('-')) continue;
    if (subs.has(w)) return `${prog} ${w}`;
    if (!(t[i - 1].startsWith('-') && !t[i - 1].includes('='))) break;
  }
  return prog;
}

export function formaDoComando(comando) {
  const formas = [];
  for (const seg of partesDoComando(String(comando || ''))) {
    const f = formaDaParte(seg);
    if (f && !formas.includes(f)) formas.push(f);
  }
  if (!formas.length) return '(vazio)';
  return formas.slice(0, 4).join(' + ') + (formas.length > 4 ? ' + …' : '');
}

const novoSegmento = () => ({ turnos: 0, fixo: null, ultimaEntrada: 0, custoEntrada: 0, blocos: [] });
const somarEm = (o, k, v) => { if (v) o[k] = (o[k] || 0) + v; };
function blocoNoContexto(g, cat, chars) {
  if (chars > 0) g.blocos.push({ cat, chars, t: g.turnos });
}
function passoDoAgente(g, modelo, u, total) {
  g.turnos++;
  const e = entradaTotal(u);
  if (g.fixo === null) g.fixo = e;
  g.ultimaEntrada = e;
  const soEntrada = custo(modelo, { ...u, output_tokens: 0 });
  g.custoEntrada += soEntrada;
  somarEm(total, 'escrita', Math.max(0, custo(modelo, u) - soEntrada));
}
// Fim de um trecho (compactação ou fim do arquivo): reparte o custo de entrada dele.
function fecharSegmento(g, total) {
  const n = g.turnos;
  if (!n || !g.custoEntrada) return;
  const relidos = g.blocos.filter((b) => b.t < n);
  const chars = relidos.reduce((x, b) => x + b.chars, 0);
  const fixo = g.fixo || 0;
  // Tokens por caractere, pela própria sessão: o que cresceu na entrada sobre o texto que entrou.
  const f = Math.min(0.6, Math.max(0.15, chars ? (g.ultimaEntrada - fixo) / chars : 0.3));
  const pesos = { fixo: fixo * (1.25 + 0.1 * (n - 1)) };
  for (const b of relidos) somarEm(pesos, b.cat, b.chars * f * (1.25 + 0.1 * (n - b.t - 1)));
  const soma = Object.values(pesos).reduce((x, v) => x + v, 0);
  if (!soma) { somarEm(total, 'fixo', g.custoEntrada); return; }
  for (const [k, v] of Object.entries(pesos)) somarEm(total, k, (g.custoEntrada * v) / soma);
}

// Mensagem que a pessoa digitou (um pedido). A linha não é convertida: só os campos de
// controle e o começo do conteúdo são olhados, para saber se é pedido; o texto não sai daqui.
// Campos de controle começam depois de "{" ou ","; no conteúdo as aspas vêm escapadas.
const campo = (l, nome) => {
  const m = l.match(new RegExp(`[,{]"${nome}":("[^"]*"|true|false)`));
  return m ? (m[1].startsWith('"') ? m[1].slice(1, -1) : m[1] === 'true') : undefined;
};
function pedidoLeve(l) {
  const m = l.match(/[,{]"content":(?:\[\{"type":"text","text":)?"([^"]{0,40})/);
  const inicio = m ? m[1] : (/[,{]"content":\[/.test(l) ? '' : null);
  const d = { type: 'user', uuid: campo(l, 'uuid'), timestamp: campo(l, 'timestamp'), isSidechain: campo(l, 'isSidechain') === true };
  d.pedido = inicio !== null && campo(l, 'isMeta') !== true && campo(l, 'isCompactSummary') !== true && !d.isSidechain && inicioDePedido(inicio);
  // Briefing do subagente: só se é correção de bug (sim ou não), lido no começo do conteúdo.
  if (d.isSidechain) {
    const i = l.indexOf('"content":');
    // As quebras de linha vêm escapadas (\n) na linha crua: viram espaço antes de procurar.
    if (i >= 0) d.correcao = PEDE_CORRECAO.test(normalizar(l.slice(i, i + 1500).replace(/\\[nrt]/g, ' ')));
  }
  return d;
}
// Saída de comando local, aviso de tarefa e interrupção não são pedidos; comando de barra é.
const inicioDePedido = (t) => !/^\[Request interrupted/.test(t) && (!t.startsWith('<') || t.startsWith('<command-'));
function ehPedido(d) {
  if (typeof d.pedido === 'boolean') return d.pedido;
  if (d.isMeta || d.isCompactSummary || d.isSidechain || !d.message) return false;
  const c = d.message.content;
  if (typeof c === 'string') return inicioDePedido(c);
  if (!Array.isArray(c) || !c.length || c.some((x) => x && x.type === 'tool_result')) return false;
  const t = c.find((x) => x && x.type === 'text');
  return inicioDePedido(t && typeof t.text === 'string' ? t.text : '');
}

// Leitura de código por Read, Grep ou Glob, sem olhar o disco (a transcrição pode ser de
// outro computador). Mesmos critérios da trava do mapa (equipe-mapa.mjs).
const CONSULTA_MAPA = /^mcp__codebase-memory__(search_graph|search_code|trace_path|query_graph|get_code_snippet|detect_changes)$/;
const TIPOS_TEXTO = new Set(['md', 'markdown', 'json', 'yaml', 'toml', 'txt', 'html', 'css', 'xml', 'csv', 'log', 'ini', 'config', 'license', 'readme']);
const naRevisao = (f) => /(^|[\\/])\.revisao[\\/]/.test(String(f));
function padraoDeCodigo(padrao) {
  const p = String(padrao || '');
  const exts = [];
  for (const m of p.matchAll(/\.\{([A-Za-z0-9,]+)\}/g)) exts.push(...m[1].split(','));
  for (const m of p.matchAll(/\.([A-Za-z0-9]+)(?=$|[\s,}/])/g)) exts.push(m[1]);
  return exts.some((e) => EXTENSOES_CODIGO.has(e.toLowerCase()));
}
const pareceArquivo = (p) => {
  const n = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return n.slice(n.lastIndexOf('/') + 1).lastIndexOf('.') > 0;
};
export function leituraDeCodigo(nome, entrada) {
  const ti = entrada && typeof entrada === 'object' ? entrada : {};
  if (nome === 'Read') {
    const f = String(ti.file_path || '');
    return Boolean(f) && ehCodigo(f) && !naRevisao(f);
  }
  if (nome === 'Grep') {
    const p = String(ti.path || '');
    if (naRevisao(p)) return false;
    if (ti.type) return !TIPOS_TEXTO.has(String(ti.type).toLowerCase());
    if (ti.glob) return padraoDeCodigo(ti.glob);
    if (p && ehCodigo(p)) return true;
    // Um arquivo que não é código não conta; pasta (ou nenhuma) varre o código.
    return !(p && pareceArquivo(p));
  }
  if (nome === 'Glob') return padraoDeCodigo(ti.pattern) && !naRevisao(ti.path || '');
  return false;
}

function textoDe(conteudo) {
  if (typeof conteudo === 'string') return conteudo;
  if (Array.isArray(conteudo)) return conteudo.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join(' ');
  return '';
}

// Sessões de versões recentes do Claude Code gravam a decisão de permissão de cada
// ferramenta (permissionDecision, toolDenialKind). Nas antigas, a medição estima: uma
// ferramenta que responde na hora e levou mais de 1 minuto quase sempre esperou aprovação.
const INSTANTANEAS = /^(Edit|Write|MultiEdit|NotebookEdit)$|__(execute_sql|apply_migration|deploy_edge_function|create_edge_function_secret|merge_branch|reset_branch|rebase_branch|delete_branch|pause_project|restore_project|create_project|upload_file|delete_project|manage_adr|ingest_traces|pub|vm_service|roots|dart_fix|dart_format|launch_app|stop_app|run_tests)$/;
const RECUSA = /doesn't want to proceed|tool use was rejected/i;
const BARRADO = /denied by the Claude Code auto mode classifier/i;
const MAPA_CONSULTA = /^mcp__codebase-memory__(search_graph|search_code|trace_path|query_graph|get_code_snippet|get_architecture|detect_changes)$/;
// O mestre gravou o progresso pelo terminal ("> .revisao/progresso.md", tee, Set-Content).
const GRAVA_PROGRESSO = /(>|\btee\b|Set-Content|Add-Content|Out-File)[^|;&]*\.revisao[\\/]progresso\.md/i;

// Agentes em segundo plano não devolvem o relatório no resultado da chamada: ele chega como
// mensagem na fila da sessão principal (anexo "queued_command" e a linha "enqueue" da fila,
// com o mesmo texto). Guarda o último relatório de cada agente; só a palavra-chave do status
// sai daqui, nunca o texto.
const MARCA_RELATORIO = 'The report follows:';
function guardarRelatorios(texto, mapa) {
  for (const m of texto.matchAll(/<agent-message from="([^"]+)">([\s\S]*?)(?=<agent-message from="|$)/g)) {
    if (!m[2].includes('[Subagent hand-back]')) continue;
    // Sem o marcador, o cabeçalho mudou de formato: não adivinha (o texto fixo poderia citar um status).
    const i = m[2].indexOf(MARCA_RELATORIO);
    if (i < 0) continue;
    const relatorio = m[2].slice(i + MARCA_RELATORIO.length).replace(/<\/agent-message>\s*$/, '').replace(/^ {2}/gm, '').trim();
    if (relatorio) mapa.set(m[1], relatorio);
  }
}

function novaAnalise() {
  return {
    msgs: new Map(), ferramentas: {}, usos: new Map(), resultados: new Set(), vistos: new Set(),
    esperas: [], perguntas: [], bloqueios: [], recusas: 0, compactacoes: 0, errosApi: 0,
    aprovacoes: [], barrados: [], recusasUsuario: 0, recusasTexto: 0, barradosTexto: [], temDecisoes: false,
    comandosBarrados: [], comandosBarradosTexto: [], doDiff: new Set(),
    primeiro: null, ultimo: null, ultimoTs: null, cwd: null, custos: new Map(), ultimoTexto: '', gasto: {},
    entrega: '', entregaTs: null,
    agentes: [], tipoPorAgente: new Map(), relatorios: new Map(),
    // Ordem das ferramentas (primeira consulta ao mapa, primeira leitura de código) e linha do
    // tempo do mestre (pedidos e leituras de código), só com posições e horários.
    seq: 0, primeiroMapa: null, primeiraLeitura: null, linhaDoTempo: [],
    // Correção de bug: o teste ficou vermelho antes da primeira edição de código (fora de teste)?
    pedeCorrecao: null, testesPorUso: new Map(), primeiroVermelho: null, primeiraEdicao: null,
    // O mestre atualizou .revisao/progresso.md? Editou código?
    progresso: false, editouCodigo: false,
  };
}

// O subagente termina chamando a ferramenta SubagentHandback, com o relatório no campo
// "message". É a fonte mais segura do relatório: vale para agente em primeiro e em segundo
// plano e não depende de como a sessão principal recebe a mensagem.
const ENTREGA = /^SubagentHandback$/;
function textoDaEntrega(entrada) {
  if (!entrada || typeof entrada !== 'object') return '';
  if (typeof entrada.message === 'string') return entrada.message;
  // Formato diferente do esperado: junta os textos que houver, sem adivinhar o campo.
  return Object.values(entrada).map((v) => (typeof v === 'string' ? v : textoDe(v))).filter(Boolean).join('\n');
}

// Lê um arquivo de transcrição e soma em r. Uma sessão pode estar espalhada em mais de
// um arquivo (quando a pasta do projeto muda no meio), então tudo é deduplicado pelos
// identificadores: mensagem, chamada de ferramenta e linha.
function analisar(arquivo, desdeMs, r = novaAnalise()) {
  // O contexto é de cada arquivo (o do mestre e o de cada subagente), até a compactação.
  let g = novoSegmento();
  for (const d of linhas(arquivo)) {
    if (d.cwd && !r.cwd) r.cwd = d.cwd;
    if (d.type === 'cost-state') {
      // Custo acumulado de cada execução do Claude Code (startTime), já com o que não
      // aparece nas mensagens: compactação, classificador do modo Auto, resumo de páginas.
      const k = d.startTime || 0;
      if (typeof d.totalCostUSD === 'number') r.custos.set(k, Math.max(r.custos.get(k) || 0, d.totalCostUSD));
      continue;
    }
    const ts = Date.parse(d.timestamp || '') || null;
    if (ts !== null && ts < desdeMs) continue;
    if (d.uuid) {
      if (r.vistos.has(d.uuid)) continue;
      r.vistos.add(d.uuid);
    }
    if (ts !== null) {
      if (r.primeiro === null || ts < r.primeiro) r.primeiro = ts;
      if (r.ultimo === null || ts > r.ultimo) r.ultimo = ts;
    }
    if (d.type === 'system' && d.subtype === 'compact_boundary') {
      r.compactacoes++;
      fecharSegmento(g, r.gasto);
      g = novoSegmento();
    }
    // Anexos: o arquivo que você anexou, o relatório de um agente de segundo plano, ou um aviso.
    // Registro e foto do prompt (snapshot, record) não entram no contexto do modelo.
    if (d.type === 'attachment' && typeof d.tam === 'number' && !/snapshot|record/i.test(d.tipoAnexo || '')) {
      blocoNoContexto(g, d.tipoAnexo === 'file' ? 'pedidos' : d.tipoAnexo === 'queued_command' ? 'agentes' : 'avisos', Math.max(0, d.tam - 300));
    }
    // Pedido ou briefing (linha lida sem converter): o tamanho, sem os campos de controle.
    if (d.type === 'user' && typeof d.tam === 'number' && !d.message) blocoNoContexto(g, d.pedido || d.isSidechain ? 'pedidos' : 'avisos', Math.max(0, d.tam - 400));
    const fila = d.type === 'attachment' && d.attachment && d.attachment.type === 'queued_command' ? d.attachment.prompt
      : d.type === 'queue-operation' && d.operation === 'enqueue' ? d.content : null;
    if (typeof fila === 'string') guardarRelatorios(fila, r.relatorios);
    if (d.isApiErrorMessage) r.errosApi++;
    if (d.type === 'user' && ehPedido(d)) r.linhaDoTempo.push({ ts, seq: ++r.seq, k: 'pedido' });
    // Primeira mensagem do arquivo do subagente: o briefing. Só guarda se é correção de bug.
    if (r.pedeCorrecao === null && d.type === 'user') {
      if (typeof d.correcao === 'boolean') r.pedeCorrecao = d.correcao;
      else if (d.message) {
        const t = typeof d.message.content === 'string' ? d.message.content : textoDe(d.message.content);
        if (t && t.trim()) r.pedeCorrecao = PEDE_CORRECAO.test(normalizar(t));
      }
    }
    if (d.type === 'assistant' && d.message) {
      const m = d.message;
      const chave = m.id || d.requestId || d.uuid;
      if (m.usage && chave && !r.msgs.has(chave)) {
        r.msgs.set(chave, { modelo: m.model || '', usage: m.usage, lado: Boolean(d.isSidechain) });
        passoDoAgente(g, m.model || '', m.usage, r.gasto);
      }
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c.type === 'text' && typeof c.text === 'string') blocoNoContexto(g, 'escrita', c.text.length);
        if (c.type === 'tool_use') {
          if (r.usos.has(c.id)) continue;
          blocoNoContexto(g, 'escrita', String(c.name || '').length + JSON.stringify(c.input || {}).length);
          r.ferramentas[c.name] = (r.ferramentas[c.name] || 0) + 1;
          const terminal = /^(Bash|PowerShell)$/.test(c.name) && c.input;
          r.usos.set(c.id, {
            nome: c.name, ts, tipo: c.input && c.input.subagent_type,
            forma: terminal ? formaDoComando(c.input.command) : null,
            le: terminal ? leCodigoPeloTerminal(c.input.command) : false,
            diff: c.name === 'Read' && c.input && /(^|[\\/])\.revisao[\\/].*\.(patch|diff)$/i.test(String(c.input.file_path || '')),
          });
          r.seq++;
          if (r.primeiroMapa === null && CONSULTA_MAPA.test(c.name)) r.primeiroMapa = r.seq;
          // O revisor lendo um arquivo que está no diff que ele recebeu não precisa do mapa.
          const doDiff = c.name === 'Read' && c.input && naMudanca(r.doDiff, c.input.file_path);
          if (/^(Read|Grep|Glob)$/.test(c.name) && leituraDeCodigo(c.name, c.input) && !doDiff) {
            if (r.primeiraLeitura === null) r.primeiraLeitura = r.seq;
            if (c.name === 'Read' && !d.isSidechain) r.linhaDoTempo.push({ ts, seq: r.seq, k: 'leitura' });
          }
          if (/^(Bash|PowerShell)$/.test(c.name) && c.input && TESTE_DE_VERDADE.test(String(c.input.command || ''))) r.testesPorUso.set(c.id, r.seq);
          // Progresso (só o mestre) e edição de código (o mestre, ou o agente no arquivo dele).
          if (/^(Edit|Write|MultiEdit)$/.test(c.name) && c.input) {
            const alvo = String(c.input.file_path || '');
            const progresso = /(^|[\\/])\.revisao[\\/]progresso\.md$/i.test(alvo);
            if (progresso && !d.isSidechain) r.progresso = true;
            else if (!progresso && ehCodigo(alvo)) r.editouCodigo = true;
          }
          if (/^(Bash|PowerShell)$/.test(c.name) && c.input && !d.isSidechain && GRAVA_PROGRESSO.test(String(c.input.command || ''))) r.progresso = true;
          if (r.primeiraEdicao === null && /^(Edit|Write|MultiEdit)$/.test(c.name) && c.input) {
            const arq = String(c.input.file_path || '').replace(/\\/g, '/');
            // Teste ou não pelo caminho dentro do projeto: um projeto numa pasta "tests/" não
            // faz toda edição parecer teste.
            const base = String(d.cwd || r.cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
            const rel = base && arq.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? arq.slice(base.length + 1) : arq.split('/').slice(-3).join('/');
            if (ehCodigo(arq) && !ARQUIVO_DE_TESTE.test(rel)) r.primeiraEdicao = r.seq;
          }
          if (c.name === 'Agent' || c.name === 'Task') {
            r.agentes.push({ tipo: (c.input && c.input.subagent_type) || 'general-purpose', modelo: (c.input && c.input.model) || null });
          }
          if (ENTREGA.test(c.name) && (ts === null || r.entregaTs === null || ts >= r.entregaTs)) {
            // Agente retomado entrega de novo: vale a última entrega.
            const t = textoDaEntrega(c.input);
            if (t) { r.entrega = t; r.entregaTs = ts; }
          }
        } else if (c.type === 'text' && c.text && (ts === null || r.ultimoTs === null || ts >= r.ultimoTs)) {
          // Guardado só para ler o status do relatório final; nunca vai para a saída.
          r.ultimoTexto = c.text;
          r.ultimoTs = ts;
        }
      }
    }
    if (d.type === 'user' && d.message && Array.isArray(d.message.content)) {
      const decisao = d.permissionDecision && typeof d.permissionDecision === 'object' ? d.permissionDecision : null;
      if (decisao || d.toolDenialKind) r.temDecisoes = true;
      let primeiro = true;
      for (const c of d.message.content) {
        if (!c || c.type !== 'tool_result' || r.resultados.has(c.tool_use_id)) continue;
        r.resultados.add(c.tool_use_id);
        const uso = r.usos.get(c.tool_use_id);
        const nome = uso ? uso.nome : '?';
        const texto = textoDe(c.content);
        blocoNoContexto(g, uso && uso.le ? 'leitura' : categoriaDaFerramenta(nome), texto.length);
        // O diff que o revisor leu: os arquivos dele. O Read devolve cada linha com o número
        // na frente ("     1\tdiff --git ..." ou "1→diff --git ...").
        if (uso && uso.diff) {
          const semNumeros = texto.replace(/^[ \t]*\d+(?:\t|→)/gm, '');
          for (const m of semNumeros.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) r.doDiff.add(m[2].trim());
        }
        if (c.is_error && r.testesPorUso.has(c.tool_use_id)) {
          const q = r.testesPorUso.get(c.tool_use_id);
          if (r.primeiroVermelho === null || q < r.primeiroVermelho) r.primeiroVermelho = q;
        }
        const s = uso && ts !== null && uso.ts !== null ? (ts - uso.ts) / 1000 : null;
        if (s !== null) {
          if (INSTANTANEAS.test(uso.nome) && s > 60) r.esperas.push({ nome, s });
          if (uso.nome === 'AskUserQuestion') r.perguntas.push(s);
        }
        // A decisão vale para a ferramenta desta linha (uma por linha).
        if (primeiro) {
          primeiro = false;
          // Barrado pelo modo Auto: só os tipos dele (automode-blocked, -unavailable,
          // -parsing-error). Regra de permissão, hook (a guarda, as travas), interrupção e
          // cancelamento não são o modo Auto.
          if (d.toolDenialKind === 'user-rejected') r.recusasUsuario++;
          else if (/^(automode|auto-mode|auto_mode|classifier)/i.test(String(d.toolDenialKind || ''))) {
            r.barrados.push(nome);
            if (uso && uso.forma) r.comandosBarrados.push(uso.forma);
          }
          if (decisao && decisao.decision === 'accept' && /^user/.test(String(decisao.source || ''))) {
            r.aprovacoes.push({ nome, s: s === null ? 0 : s });
          }
        }
        // Bloqueio de verdade: o comando de terminal voltou com erro e a mensagem é curta.
        // Saída de teste ou arquivo lido que só cita a frase não conta.
        if (c.is_error && texto.length < 1500 && (!uso || /^(Bash|PowerShell)$/.test(uso.nome))) {
          const b = texto.match(/Bloqueado pela guarda \(([a-z]+)\):\s*([^\n]{0,90})/);
          if (b) r.bloqueios.push({ perfil: b[1], motivo: limparMotivo(b[2]) });
        }
        if (c.is_error && texto.length < 3000) {
          if (RECUSA.test(texto)) r.recusasTexto++;
          else if (BARRADO.test(texto)) {
            r.barradosTexto.push(nome);
            if (uso && uso.forma) r.comandosBarradosTexto.push(uso.forma);
          }
        }
        if (uso && (uso.nome === 'Agent' || uso.nome === 'Task') && d.toolUseResult && d.toolUseResult.agentId) {
          r.tipoPorAgente.set(String(d.toolUseResult.agentId), uso.tipo || 'general-purpose');
        }
      }
    } else if (d.type === 'user' && d.message) {
      // Pedido convertido (o formato com o texto inteiro): o tamanho dele.
      blocoNoContexto(g, ehPedido(d) || d.isSidechain ? 'pedidos' : 'avisos', textoDe(d.message.content).length);
    }
  }
  fecharSegmento(g, r.gasto);
  return r;
}

// Leituras de código do mestre em cada pedido, na ordem do tempo. Leituras antes do primeiro
// pedido do período (pedido feito antes dele) contam como um pedido.
export function leiturasPorPedido(linhaDoTempo) {
  const ordem = [...linhaDoTempo].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || a.seq - b.seq);
  const contas = [];
  for (const e of ordem) {
    if (e.k === 'pedido') contas.push(0);
    else {
      if (!contas.length) contas.push(0);
      contas[contas.length - 1]++;
    }
  }
  return contas;
}

// O motivo da guarda pode citar o comando barrado: o que vem entre aspas sai.
export function limparMotivo(m) {
  // Primeiro a sobra do texto em volta da mensagem (aspas e parêntese no fim), depois o
  // que está entre aspas.
  const sem = m.replace(/["'`)\]\s]+$/, '');
  return sem.replace(/'[^']*'?/g, "'…'").replace(/"[^"]*"?/g, '"…"').trim();
}

// Pedidos de aprovação, bloqueios do modo Auto e recusas: pelos campos que a sessão grava
// ou, em sessão de versão antiga, pela estimativa.
function decisoes(a) {
  if (a.temDecisoes) return { aprovacoes: a.aprovacoes, barrados: a.barrados, comandosBarrados: a.comandosBarrados, recusas: a.recusasUsuario, estimado: false };
  return { aprovacoes: a.esperas, barrados: a.barradosTexto, comandosBarrados: a.comandosBarradosTexto, recusas: a.recusasTexto, estimado: a.esperas.length > 0 };
}

// O arquivo está entre os do diff (caminhos relativos à raiz do projeto)?
function naMudanca(doDiff, arquivo) {
  if (!doDiff.size || !arquivo) return false;
  const a = String(arquivo).replace(/\\/g, '/').toLowerCase();
  for (const rel of doDiff) {
    const r = rel.replace(/\\/g, '/').toLowerCase();
    if (a === r || a.endsWith(`/${r}`)) return true;
  }
  return false;
}

function somarUso(msgs, filtro = () => true) {
  const t = { entrada: 0, saida: 0, custo: 0, modelos: {}, passosAcima100k: 0, passos: 0 };
  for (const m of msgs.values()) {
    if (!filtro(m)) continue;
    const u = m.usage;
    t.entrada += entradaTotal(u);
    t.saida += u.output_tokens || 0;
    t.custo += custo(m.modelo, u);
    t.passos++;
    const nome = (m.modelo || 'desconhecido').replace(/^claude-/, '');
    t.modelos[nome] = (t.modelos[nome] || 0) + 1;
    if (/haiku/i.test(m.modelo) && entradaTotal(u) > 100000) t.passosAcima100k++;
  }
  return t;
}

function modeloPrincipal(modelos) {
  return Object.entries(modelos).sort((a, b) => b[1] - a[1]).map(([m]) => m)[0] || '?';
}

// Status do relatório final de cada agente (só a palavra-chave, nunca o texto).

// ---------- medição ----------
export function medir({ dias = 7, projeto = '', raiz = '', diario = '' } = {}) {
  const pastaProjetos = raiz || path.join(pastaClaude(), 'projects');
  const desdeMs = Date.now() - dias * 86400000;
  const sessoes = [];
  let pastas = [];
  try { pastas = fs.readdirSync(pastaProjetos, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { /* sem pasta */ }

  // Uma sessão pode ter arquivos em mais de uma pasta de projeto (a pasta mudou no meio):
  // junta tudo pelo id da sessão, que é o nome do arquivo.
  const porSessao = new Map();
  for (const p of pastas) {
    const dir = path.join(pastaProjetos, p.name);
    let nomes = [];
    try { nomes = fs.readdirSync(dir); } catch { continue; }
    for (const n of nomes) {
      if (!n.endsWith('.jsonl')) continue;
      const arquivo = path.join(dir, n);
      let mtime = 0;
      try { mtime = fs.statSync(arquivo).mtimeMs; } catch { continue; }
      if (mtime < desdeMs) continue;
      const id = n.replace(/\.jsonl$/, '');
      if (!porSessao.has(id)) porSessao.set(id, []);
      porSessao.get(id).push({ arquivo, dirSub: path.join(dir, id, 'subagents') });
    }
  }

  const idsMedidos = new Set();
  for (const [idSessao, partes] of porSessao) {
    {
      const principal = novaAnalise();
      for (const parte of partes) analisar(parte.arquivo, desdeMs, principal);
      if (principal.primeiro === null) continue;
      const nomeProjeto = principal.cwd ? path.basename(principal.cwd.replace(/[\\/]+$/, '')) : '?';
      if (projeto && !nomeProjeto.toLowerCase().includes(projeto) && !(principal.cwd || '').toLowerCase().includes(projeto)) continue;
      idsMedidos.add(idSessao);

      // Subagentes: um arquivo por agente em <sessão>/subagents/, com o tipo no .meta.json.
      const arquivosSub = new Map();
      for (const parte of partes) {
        let subs = [];
        try { subs = fs.readdirSync(parte.dirSub).filter((x) => /^agent-.*\.jsonl$/.test(x)); } catch { /* sem subagentes */ }
        for (const s of subs) {
          const idAgente = s.replace(/^agent-/, '').replace(/\.jsonl$/, '');
          if (!arquivosSub.has(idAgente)) arquivosSub.set(idAgente, parte.dirSub);
        }
      }
      const agentes = [];
      const gastoAgentes = {};
      for (const [id, dirSub] of arquivosSub) {
        const meta = lerJson(path.join(dirSub, `agent-${id}.meta.json`)) || {};
        const a = analisar(path.join(dirSub, `agent-${id}.jsonl`), desdeMs);
        if (a.primeiro === null) continue;
        const tipo = meta.agentType || principal.tipoPorAgente.get(id) || 'subagente';
        for (const [k, v] of Object.entries(a.gasto)) somarEm(gastoAgentes, k, v);
        const uso = somarUso(a.msgs);
        const f = a.ferramentas;
        const nomesF = Object.keys(f);
        agentes.push({
          tipo,
          modelo: modeloPrincipal(uso.modelos),
          entrada: uso.entrada, saida: uso.saida, custo: uso.custo, passos: uso.passos,
          passosAcima100k: uso.passosAcima100k,
          segundos: a.ultimo && a.primeiro ? (a.ultimo - a.primeiro) / 1000 : 0,
          leituras: f.Read || 0,
          buscas: (f.Grep || 0) + (f.Glob || 0),
          consultouMapa: nomesF.some((x) => MAPA_CONSULTA.test(x)),
          editouCodigo: a.editouCodigo,
          // null: a chamada não leu código. true: consultou o mapa antes da primeira leitura.
          mapaAntes: a.primeiraLeitura === null ? null : a.primeiroMapa !== null && a.primeiroMapa < a.primeiraLeitura,
          // null: não é correção de bug (ou não editou código). true: teste vermelho antes da correção.
          vermelhoAntes: a.pedeCorrecao && a.primeiraEdicao !== null ? a.primeiroVermelho !== null && a.primeiroVermelho < a.primeiraEdicao : null,
          indexou: Boolean(f['mcp__codebase-memory__index_repository']),
          conferiuIndice: Boolean(f['mcp__codebase-memory__index_status']),
          usouApoio: nomesF.some((x) => x.startsWith('mcp__apoio-local__') && x !== 'mcp__apoio-local__status_local'),
          bloqueios: a.bloqueios,
          ...decisoes(a),
          // Ordem: a entrega do próprio agente (SubagentHandback); a mensagem que chegou na fila
          // da sessão principal; o último texto do agente (versões antigas do Claude Code).
          status: statusDoRelatorio(tipo, a.entrega || principal.relatorios.get(id) || a.ultimoTexto),
        });
      }
      // Formato antigo: mensagens de subagente dentro do arquivo da sessão.
      const lado = somarUso(principal.msgs, (m) => m.lado);
      if (lado.passos > 0) {
        agentes.push({ tipo: 'subagente', modelo: modeloPrincipal(lado.modelos), entrada: lado.entrada, saida: lado.saida, custo: lado.custo, passos: lado.passos, passosAcima100k: lado.passosAcima100k, segundos: 0, leituras: 0, buscas: 0, consultouMapa: false, mapaAntes: null, indexou: false, conferiuIndice: false, usouApoio: false, bloqueios: [], aprovacoes: [], barrados: [], recusas: 0, estimado: false, status: '' });
      }

      const mestre = somarUso(principal.msgs, (m) => !m.lado);
      const f = principal.ferramentas;
      sessoes.push({
        projeto: nomeProjeto,
        inicio: principal.primeiro, fim: principal.ultimo,
        mestre: {
          modelo: modeloPrincipal(mestre.modelos), entrada: mestre.entrada, saida: mestre.saida, custo: mestre.custo,
          leituras: f.Read || 0, buscas: (f.Grep || 0) + (f.Glob || 0), edicoes: (f.Edit || 0) + (f.Write || 0) + (f.MultiEdit || 0),
          terminal: (f.Bash || 0) + (f.PowerShell || 0),
          leiturasPorPedido: leiturasPorPedido(principal.linhaDoTempo),
        },
        chamadas: principal.agentes,
        agentes,
        compactacoes: principal.compactacoes,
        errosApi: principal.errosApi,
        // Sessão que mudou código (o mestre ou um implementador) e se atualizou o progresso.
        mudouCodigo: principal.editouCodigo || agentes.some((a) => a.editouCodigo),
        progresso: principal.progresso,
        ...decisoes(principal),
        perguntas: principal.perguntas,
        bloqueios: principal.bloqueios,
        // O custo que o próprio Claude Code registra é acumulado por execução, então só
        // entram as execuções que começaram dentro do período.
        custoRegistrado: custoRegistrado(principal.custos, desdeMs),
        gasto: { mestre: principal.gasto, agentes: gastoAgentes },
      });
    }
  }
  // Com filtro de projeto, só as decisões das sessões medidas (a chave da chamada começa
  // pelo id da sessão).
  const travas = lerTravas(diario || pastaDiario(), desdeMs, projeto ? idsMedidos : null);
  const teste = testeDaRetro(travas.intervencoes, diario || pastaDiario());
  return { ...resumir(sessoes, { dias, desdeMs, pastaProjetos, travas }), teste, filtro: projeto || null };
}

// ---------- registro das travas ----------
// Uma linha por decisão: data ISO, trava, decisão, ms, tipo do agente, chave da chamada.
// Os despachantes (pre, pos, eventos) gravam o tempo do processo inteiro; no "eventos" a
// decisão é o nome do evento do hook.
const DESPACHANTES = ['pre', 'pos', 'eventos'];
const INTERVENCAO = /^(barrou|pediu|avisou|sonnet|parou|entregou-falha|entregou-no-fim)$/;
const NOME_VALIDO = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

function percentil(ordenados, p) {
  if (!ordenados.length) return 0;
  return ordenados[Math.min(ordenados.length - 1, Math.max(0, Math.ceil(p * ordenados.length) - 1))];
}
export function mediana(lista) {
  if (!lista.length) return 0;
  const o = [...lista].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
}

export function lerTravas(pasta, desdeMs, sessoes = null) {
  const r = {
    linhas: 0, porTrava: {}, tempos: {}, mapa: { chamadas: 0, fugas: 0, semTentar: 0 }, entregasSemVerificar: 0,
    // Concluídas sem revisão depois da cobrança: sem chamar o revisor, ou com ele chamado mas sem
    // aprovação reconhecida (reprovou, ou o relatório veio sem veredito). A pausa para
    // perguntar ao usuário não conta como conclusão.
    conclusoesSemRevisao: 0, conclusoesComRevisor: 0, pausasSemRevisao: 0, foraDoEscopo: 0,
    // Vezes que cada trava mudou o rumo (barrou, pediu, avisou, trocou o modelo, mandou parar).
    intervencoes: {},
  };
  // Sessões com a cobrança da revisão em aberto: se um revisor terminou depois dela.
  const cobradas = new Map();
  const sessaoDe = (chave) => { const c = String(chave || ''); const i = c.lastIndexOf('-'); return i > 0 ? c.slice(0, i) : c; };
  let nomes = [];
  try { nomes = fs.readdirSync(pasta).filter((n) => /^travas-\d{4}-\d{2}\.log$/.test(n)).sort(); } catch { return r; }
  const porDespachante = {};
  const chamadasMapa = new Map();
  for (const n of nomes) {
    const conteudo = lerTexto(path.join(pasta, n));
    if (!conteudo) continue;
    for (const l of conteudo.split(/\r?\n/)) {
      const [quando, trava, decisao, tempo, tipo, chave] = l.split('\t');
      const ts = Date.parse(quando || '');
      if (!ts || ts < desdeMs || !NOME_VALIDO.test(trava || '') || !NOME_VALIDO.test(decisao || '')) continue;
      if (sessoes && ![...sessoes].some((id) => String(chave || '').startsWith(`${id}-`))) continue;
      r.linhas++;
      // Revisor chamado depois da cobrança: conta o começo dele (o de segundo plano termina
      // depois da conclusão).
      if (trava === 'eventos' && /^Subagent(Start|Stop)$/.test(decisao) && /revis|review/i.test(tipo || '') && cobradas.has(sessaoDe(chave))) cobradas.set(sessaoDe(chave), true);
      if (DESPACHANTES.includes(trava)) {
        const v = Number(tempo);
        if (Number.isFinite(v)) (porDespachante[trava] = porDespachante[trava] || []).push(v);
        continue;
      }
      const t = r.porTrava[trava] = r.porTrava[trava] || {};
      t[decisao] = (t[decisao] || 0) + 1;
      if (INTERVENCAO.test(decisao)) r.intervencoes[trava] = (r.intervencoes[trava] || 0) + 1;
      if (decisao === 'entregou-sem-verificar') r.entregasSemVerificar++;
      if (trava === 'revisao' && decisao === 'barrou') cobradas.set(sessaoDe(chave), cobradas.get(sessaoDe(chave)) || false);
      if (decisao === 'concluiu-sem-revisao') {
        if (cobradas.get(sessaoDe(chave))) r.conclusoesComRevisor++;
        else r.conclusoesSemRevisao++;
        cobradas.delete(sessaoDe(chave));
      }
      if (decisao === 'pausou-sem-revisao') r.pausasSemRevisao++;
      if (decisao === 'fora-do-escopo') r.foraDoEscopo++;
      // Fugas do mapa: entre as chamadas do Explore e do revisor que tiveram decisão do mapa
      // (consultou ou fugiu), quantas fugiram. Chamada sem chave conta sozinha.
      if (trava === 'mapa' && /^(consultou|fuga|fuga-sem-tentar)$/.test(decisao) && (tipo === 'Explore' || tipo === 'revisor')) {
        const k = chave || `linha-${r.linhas}`;
        chamadasMapa.set(k, chamadasMapa.get(k) || decisao !== 'consultou');
        if (decisao === 'fuga-sem-tentar') r.mapa.semTentar++;
      }
    }
  }
  r.mapa.chamadas = chamadasMapa.size;
  r.mapa.fugas = [...chamadasMapa.values()].filter(Boolean).length;
  for (const [d, lista] of Object.entries(porDespachante)) {
    const o = lista.sort((a, b) => a - b);
    r.tempos[d] = { vezes: o.length, media: o.reduce((x, v) => x + v, 0) / o.length, p95: percentil(o, 0.95), pior: o[o.length - 1] };
  }
  return r;
}

function custoRegistrado(custos, desdeMs) {
  let soma = 0;
  let achou = false;
  for (const [inicio, valor] of custos) {
    if (inicio && inicio >= desdeMs) { soma += valor; achou = true; }
  }
  return achou ? soma : null;
}

const PADRAO_MODELO = { Explore: 'haiku', implementador: 'sonnet', verificador: 'haiku', revisor: 'sonnet' };

function resumir(sessoes, { dias, desdeMs, pastaProjetos, travas }) {
  const porTipo = {};
  const projetos = {};
  const bloqueios = {};
  const aprovacoes = {};
  const barrados = {};
  const comandosBarrados = {};
  const subidas = {};
  let estimado = false;
  let custoMestre = 0;
  let compactacoes = 0;
  let errosApi = 0;
  let recusas = 0;
  let perguntas = 0;
  let segundosPerguntas = 0;
  let custoRegistrado = 0;
  let sessoesComRegistro = 0;
  let leiturasMestre = 0;
  const porPedido = [];
  const gasto = { mestre: {}, agentes: {} };

  const somarDecisoes = (x) => {
    for (const e of x.aprovacoes) {
      aprovacoes[e.nome] = aprovacoes[e.nome] || { vezes: 0, segundos: 0 };
      aprovacoes[e.nome].vezes++;
      aprovacoes[e.nome].segundos += e.s;
    }
    for (const nome of x.barrados) barrados[nome] = (barrados[nome] || 0) + 1;
    for (const forma of x.comandosBarrados || []) comandosBarrados[forma] = (comandosBarrados[forma] || 0) + 1;
    recusas += x.recusas;
    if (x.estimado) estimado = true;
  };
  const somarBloqueios = (lista) => {
    for (const b of lista) {
      const k = `${b.perfil}: ${b.motivo}`;
      bloqueios[k] = (bloqueios[k] || 0) + 1;
    }
  };

  for (const s of sessoes) {
    for (const lado of ['mestre', 'agentes']) for (const [k, v] of Object.entries((s.gasto && s.gasto[lado]) || {})) somarEm(gasto[lado], k, v);
    custoMestre += s.mestre.custo;
    leiturasMestre += s.mestre.leituras;
    porPedido.push(...s.mestre.leiturasPorPedido);
    compactacoes += s.compactacoes;
    errosApi += s.errosApi;
    perguntas += s.perguntas.length;
    segundosPerguntas += s.perguntas.reduce((a, b) => a + b, 0);
    if (s.custoRegistrado !== null && s.custoRegistrado !== undefined) { custoRegistrado += s.custoRegistrado; sessoesComRegistro++; }
    somarDecisoes(s);
    somarBloqueios(s.bloqueios);
    const pj = projetos[s.projeto] = projetos[s.projeto] || { sessoes: 0, custo: 0, compactacoes: 0, agentes: 0 };
    pj.sessoes++;
    pj.custo += s.mestre.custo;
    pj.compactacoes += s.compactacoes;
    for (const c of s.chamadas) {
      if (c.modelo && PADRAO_MODELO[c.tipo] && !new RegExp(PADRAO_MODELO[c.tipo], 'i').test(c.modelo)) {
        const k = `${c.tipo} em ${c.modelo}`;
        subidas[k] = (subidas[k] || 0) + 1;
      }
    }
    for (const a of s.agentes) {
      pj.custo += a.custo;
      pj.agentes++;
      somarDecisoes(a);
      somarBloqueios(a.bloqueios);
      const t = porTipo[a.tipo] = porTipo[a.tipo] || {
        chamadas: 0, entrada: 0, saida: 0, custo: 0, segundos: 0, passosAcima100k: 0, leituras: 0,
        consultouMapa: 0, indexou: 0, conferiuIndice: 0, usouApoio: 0, status: {}, modelos: {},
        comLeituraDeCodigo: 0, mapaAntesDaLeitura: 0, correcoes: 0, vermelhoAntes: 0,
      };
      t.chamadas++;
      t.entrada += a.entrada;
      t.saida += a.saida;
      t.custo += a.custo;
      t.segundos += a.segundos;
      t.passosAcima100k += a.passosAcima100k;
      t.leituras += a.leituras;
      if (a.consultouMapa) t.consultouMapa++;
      if (a.mapaAntes !== null && a.mapaAntes !== undefined) {
        t.comLeituraDeCodigo++;
        if (a.mapaAntes) t.mapaAntesDaLeitura++;
      }
      if (a.vermelhoAntes !== null && a.vermelhoAntes !== undefined) {
        t.correcoes++;
        if (a.vermelhoAntes) t.vermelhoAntes++;
      }
      if (a.indexou) t.indexou++;
      if (a.conferiuIndice) t.conferiuIndice++;
      if (a.usouApoio) t.usouApoio++;
      if (a.status) t.status[a.status] = (t.status[a.status] || 0) + 1;
      t.modelos[a.modelo] = (t.modelos[a.modelo] || 0) + 1;
    }
  }

  const custoAgentes = Object.values(porTipo).reduce((x, t) => x + t.custo, 0);
  const custoTotal = custoMestre + custoAgentes;
  const n = sessoes.length || 1;
  const totalAprovacoes = Object.values(aprovacoes).reduce((x, e) => x + e.vezes, 0);
  const segundosAprovacao = Object.values(aprovacoes).reduce((x, e) => x + e.segundos, 0);
  const totalBarrados = Object.values(barrados).reduce((x, v) => x + v, 0);
  const totalBloqueios = Object.values(bloqueios).reduce((x, b) => x + b, 0);
  const ex = porTipo.Explore;
  const rev = porTipo.revisor;
  const imp = porTipo.implementador;
  // Mapa antes da leitura: só as chamadas do Explore e do revisor que leram código.
  const comLeitura = (ex ? ex.comLeituraDeCodigo : 0) + (rev ? rev.comLeituraDeCodigo : 0);
  const mapaAntes = (ex ? ex.mapaAntesDaLeitura : 0) + (rev ? rev.mapaAntesDaLeitura : 0);
  // Leituras do mestre por pedido: mediana e máximo entre os pedidos com ao menos uma
  // leitura de código (os pedidos sem leitura puxariam a mediana para zero).
  const comLeituraMestre = porPedido.filter((v) => v > 0);
  const pedidos = { total: porPedido.length, comLeitura: comLeituraMestre.length, mediana: mediana(comLeituraMestre), maximo: comLeituraMestre.length ? Math.max(...comLeituraMestre) : 0 };
  const gastoTotal = Object.values(gasto.mestre).concat(Object.values(gasto.agentes)).reduce((x, v) => x + v, 0);
  const parte = (...cats) => (gastoTotal ? (100 * cats.reduce((x, k) => x + (gasto.mestre[k] || 0) + (gasto.agentes[k] || 0), 0)) / gastoTotal : null);
  const tv = travas || lerTravas('', 0);
  const barrouOuPediu = Object.values(tv.porTrava).reduce((x, d) => x + (d.barrou || 0) + (d.pediu || 0), 0);
  const p95s = Object.values(tv.tempos).map((t) => t.p95);

  const comCodigo = sessoes.filter((s) => s.mudouCodigo);
  const indicadores = {
    sessoes: sessoes.length,
    custo_por_sessao: custoTotal / n,
    custo_mestre_pct: custoTotal ? (100 * custoMestre) / custoTotal : 0,
    leituras_do_mestre_por_sessao: leiturasMestre / n,
    explore_tokens_por_chamada: ex ? ex.entrada / ex.chamadas : 0,
    explore_mapa_pct: ex ? (100 * ex.consultouMapa) / ex.chamadas : 0,
    haiku_passos_acima_100k: Object.values(porTipo).reduce((x, t) => x + t.passosAcima100k, 0),
    bloqueios_por_sessao: totalBloqueios / n,
    aprovacoes_por_sessao: totalAprovacoes / n,
    minutos_esperando_aprovacao_por_sessao: segundosAprovacao / 60 / n,
    barrados_pelo_auto_por_sessao: totalBarrados / n,
    revisor_reprovado_pct: rev ? (100 * (rev.status.reprovado || 0)) / rev.chamadas : 0,
    implementador_incompleto_pct: imp ? (100 * (imp.chamadas - (imp.status.feito || 0) - (imp.status['feito com ressalvas'] || 0))) / imp.chamadas : 0,
    compactacoes_por_sessao: compactacoes / n,
    subidas_de_modelo: Object.values(subidas).reduce((x, v) => x + v, 0),
    // null: não deu para medir neste período (fica fora da comparação).
    mapa_antes_da_leitura_pct: comLeitura ? (100 * mapaAntes) / comLeitura : null,
    mestre_leituras_por_pedido_mediana: pedidos.total ? pedidos.mediana : null,
    fugas_do_mapa_pct: tv.mapa.chamadas ? (100 * tv.mapa.fugas) / tv.mapa.chamadas : null,
    travas_barrou_por_sessao: tv.linhas ? barrouOuPediu / n : null,
    entregas_sem_verificacao: tv.linhas ? tv.entregasSemVerificar : null,
    conclusoes_sem_revisor: tv.linhas ? tv.conclusoesSemRevisao : null,
    correcao_com_teste_vermelho_pct: imp && imp.correcoes ? (100 * imp.vermelhoAntes) / imp.correcoes : null,
    hooks_p95_ms: p95s.length ? Math.max(...p95s) : null,
    // Sessões que mudaram código e deixaram o progresso atualizado (null: nenhuma mudou código).
    progresso_atualizado_pct: comCodigo.length ? (100 * comCodigo.filter((s) => s.progresso).length) / comCodigo.length : null,
    // Para onde vai o custo (estimativa): a parte de cada fonte no custo total.
    gasto_fixo_pct: parte('fixo'),
    gasto_leitura_pct: parte('leitura', 'busca'),
    gasto_terminal_pct: parte('terminal'),
    gasto_escrita_pct: parte('escrita'),
  };

  return {
    geradoEm: new Date().toISOString(),
    dias, desde: new Date(desdeMs).toISOString(), pastaProjetos,
    sessoes: sessoes.length,
    custo: { total: custoTotal, mestre: custoMestre, agentes: custoAgentes, registradoPeloClaudeCode: sessoesComRegistro ? custoRegistrado : null, sessoesComRegistro },
    mestre: { leituras: leiturasMestre, modelos: contar(sessoes.map((s) => s.mestre.modelo)), pedidos },
    progresso: { sessoesComCodigo: comCodigo.length, atualizaram: comCodigo.filter((s) => s.progresso).length },
    porTipo, projetos, bloqueios, aprovacoes, barrados, comandosBarrados, estimado, subidas,
    compactacoes, errosApi, recusas, perguntas, segundosPerguntas,
    travas: tv,
    gasto,
    indicadores,
  };
}

// ---------- teste de desligar uma trava ----------
const ARQUIVO_TESTE = 'teste-trava.json';
// O teste em andamento (ou o que terminou e ainda não foi encerrado) e a candidata: entre as
// travas testáveis ligadas, a que menos mudou o rumo no período.
export function testeDaRetro(intervencoes = {}, diario = pastaDiario()) {
  const bruto = lerJson(path.join(diario, ARQUIVO_TESTE));
  let atual = null;
  if (bruto && TRAVAS_TESTAVEIS.includes(bruto.trava)) {
    const ate = Date.parse(bruto.ate || '');
    atual = { trava: bruto.trava, desde: bruto.desde || null, ate: bruto.ate || null, terminado: !(Date.now() < ate) || !testeValido(bruto) };
  }
  const contas = Object.fromEntries(TRAVAS_TESTAVEIS.map((n) => [n, intervencoes[n] || 0]));
  const ligadas = TRAVAS_TESTAVEIS.filter((n) => !(atual && atual.trava === n) && !desligada(n));
  const candidata = atual && !atual.terminado ? null
    : ligadas.sort((a, b) => contas[a] - contas[b] || a.localeCompare(b))[0] || null;
  return { atual, candidata, intervencoes: contas };
}

function textoDoTeste(t) {
  const l = ['', '## Teste de desligar uma trava', ''];
  if (t.atual && !t.atual.terminado) {
    l.push(`- Em andamento: a trava "${t.atual.trava}" está desligada desde ${t.atual.desde ? data(t.atual.desde) : '?'} e volta em ${data(t.atual.ate)}. Compare na retrospectiva depois dessa data.`);
  } else if (t.atual) {
    l.push(`- Terminado: a trava "${t.atual.trava}" ficou desligada de ${t.atual.desde ? data(t.atual.desde) : '?'} a ${data(t.atual.ate)} (já voltou). Compare os indicadores dela com a retrospectiva anterior e proponha: tirar de vez (nada piorou), manter (piorou) ou trocar por algo mais leve. Depois, rode com --fim-teste.`);
  }
  if (t.candidata) {
    const outras = Object.entries(t.intervencoes).filter(([n]) => n !== t.candidata).sort((a, b) => a[1] - b[1]).slice(0, 4).map(([n, v]) => `${n} ${v}`).join(', ');
    l.push(`- Candidata a um teste de 7 dias desligada: "${t.candidata}" (mudou o rumo ${t.intervencoes[t.candidata]} vez(es) no período; as seguintes: ${outras}). Antes de propor, veja se ela se aplica aos projetos do período.`);
  }
  return l.length > 3 ? l.join('\n') : '';
}

function contar(lista) {
  const o = {};
  for (const x of lista) o[x] = (o[x] || 0) + 1;
  return o;
}

// ---------- texto ----------
const nf = (casas = 0) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
const dinheiro = (v) => `US$ ${nf(2).format(v || 0)}`;
const mil = (v) => (v >= 1e6 ? `${nf(1).format(v / 1e6)} mi` : v >= 1e3 ? `${nf(0).format(v / 1e3)} mil` : nf(0).format(v || 0));
const pct = (v) => `${nf(0).format(v || 0)}%`;
const minutos = (s) => (s >= 3600 ? `${nf(1).format(s / 3600)} h` : `${nf(0).format(s / 60)} min`);
const data = (iso) => new Date(iso).toLocaleDateString('pt-BR');
const ms = (v) => `${nf(0).format(v || 0)} ms`;

export function texto(r) {
  const out = [];
  out.push(`# Medição da equipe: últimos ${r.dias} dias (desde ${data(r.desde)})`);
  out.push('');
  if (!r.sessoes) {
    out.push(`Nenhuma sessão encontrada em ${r.pastaProjetos} neste período${r.filtro ? ` para o projeto "${r.filtro}"` : ''}.`);
    return out.join('\n');
  }
  const pj = Object.keys(r.projetos).length;
  out.push(`${r.sessoes} sessões em ${pj} projeto(s). Fonte: ${r.pastaProjetos}`);
  out.push('Custo em preço de API, aproximado: na assinatura serve como proporção do limite usado.');
  out.push('');
  out.push('## Gasto por agente');
  out.push('');
  out.push('| Quem | Chamadas | Modelo | Entrada | Saída | Custo | % |');
  out.push('|---|---|---|---|---|---|---|');
  const total = r.custo.total || 1;
  out.push(`| mestre | ${r.sessoes} sessões | ${Object.keys(r.mestre.modelos).join(', ')} | — | — | ${dinheiro(r.custo.mestre)} | ${pct((100 * r.custo.mestre) / total)} |`);
  for (const [tipo, t] of Object.entries(r.porTipo).sort((a, b) => b[1].custo - a[1].custo)) {
    out.push(`| ${tipo} | ${t.chamadas} | ${Object.keys(t.modelos).join(', ')} | ${mil(t.entrada)} | ${mil(t.saida)} | ${dinheiro(t.custo)} | ${pct((100 * t.custo) / total)} |`);
  }
  out.push(`| **total** | | | | | **${dinheiro(r.custo.total)}** | |`);
  if (r.custo.registradoPeloClaudeCode !== null) {
    out.push('');
    out.push(`Custo registrado pelo próprio Claude Code nas ${r.custo.sessoesComRegistro} sessões que começaram no período: ${dinheiro(r.custo.registradoPeloClaudeCode)}.`);
  }
  out.push('');
  out.push(...textoGasto(r.gasto));
  out.push('## Sinais');
  out.push('');
  const i = r.indicadores;
  const ex = r.porTipo.Explore;
  if (ex) {
    out.push(`- Explore: ${ex.chamadas} chamadas; consultou o mapa em ${ex.consultouMapa} (${pct(i.explore_mapa_pct)}), conferiu o índice em ${ex.conferiuIndice}, indexou ${ex.indexou} vez(es); usou o apoio local em ${ex.usouApoio}; ${nf(1).format(ex.leituras / ex.chamadas)} leituras (Read) e ${mil(i.explore_tokens_por_chamada)} tokens de entrada por chamada.`);
  }
  if (i.haiku_passos_acima_100k) out.push(`- Passos de Haiku acima de 100 mil tokens (custam 5 vezes mais): ${i.haiku_passos_acima_100k}.`);
  for (const tipo of ['implementador', 'verificador', 'revisor']) {
    const t = r.porTipo[tipo];
    if (!t) continue;
    const st = Object.entries(t.status).map(([k, v]) => `${v} ${k}`).join(', ');
    out.push(`- ${tipo}: ${t.chamadas} chamadas${st ? ` (${st})` : ''}; ${minutos(t.segundos / t.chamadas)} em média.`);
  }
  const antes = ['Explore', 'revisor'].filter((tp) => r.porTipo[tp] && r.porTipo[tp].comLeituraDeCodigo)
    .map((tp) => { const t = r.porTipo[tp]; return `${tp} ${t.mapaAntesDaLeitura} de ${t.comLeituraDeCodigo} (${pct((100 * t.mapaAntesDaLeitura) / t.comLeituraDeCodigo)})`; });
  if (antes.length) out.push(`- Mapa antes da primeira leitura de código: ${antes.join(', ')}. Só contam as chamadas que leram código.`);
  const ti = r.porTipo.implementador;
  if (ti && ti.correcoes) out.push(`- Correções de bug do implementador com teste vermelho antes da correção: ${ti.vermelhoAntes} de ${ti.correcoes} (${pct((100 * ti.vermelhoAntes) / ti.correcoes)}). Teste que já passava antes não prova a correção.`);
  out.push(`- Mestre: ${r.mestre.leituras} leituras próprias (Read), ${nf(1).format(i.leituras_do_mestre_por_sessao)} por sessão.`);
  const pd = r.mestre.pedidos;
  if (pd && pd.total) out.push(`- Leituras de código do mestre por pedido: ${pd.comLeitura} de ${pd.total} pedidos leram código${pd.comLeitura ? `; nesses, mediana ${nf(1).format(pd.mediana)} e máximo ${pd.maximo}` : ''}.`);
  const subidas = Object.entries(r.subidas);
  out.push(`- Subidas de modelo: ${subidas.length ? subidas.map(([k, v]) => `${k} (${v})`).join(', ') : 'nenhuma'}.`);
  out.push(`- Compactações: ${r.compactacoes} (${nf(1).format(i.compactacoes_por_sessao)} por sessão). Erros da API: ${r.errosApi}.`);
  if (r.progresso && r.progresso.sessoesComCodigo) out.push(`- Registro de progresso (.revisao/progresso.md): atualizado em ${r.progresso.atualizaram} de ${r.progresso.sessoesComCodigo} sessões que mudaram código (${pct(i.progresso_atualizado_pct)}).`);
  const aprov = Object.entries(r.aprovacoes).sort((a, b) => b[1].segundos - a[1].segundos);
  const totalAprov = aprov.reduce((x, [, e]) => x + e.vezes, 0);
  const comoMedido = r.estimado ? ' (estimado onde a sessão não grava as decisões: ferramenta instantânea que levou mais de 1 min)' : '';
  out.push(`- Pedidos de aprovação que você respondeu${comoMedido}: ${totalAprov}${aprov.length ? `, com a sessão parada ${minutos(aprov.reduce((x, [, e]) => x + e.segundos, 0))} no total: ` + aprov.slice(0, 6).map(([k, e]) => `${k} ${e.vezes}x (${minutos(e.segundos)})`).join(', ') : ''}.`);
  const barr = Object.entries(r.barrados).sort((a, b) => b[1] - a[1]);
  out.push(`- Barrados pelo modo Auto: ${barr.reduce((x, [, v]) => x + v, 0)}${barr.length ? ` (${barr.slice(0, 6).map(([k, v]) => `${k} ${v}x`).join(', ')})` : ''}. Recusados por você: ${r.recusas}.`);
  const cmds = Object.entries(r.comandosBarrados || {}).sort((a, b) => b[1] - a[1]);
  if (cmds.length) out.push(`  - Comandos de terminal barrados (programa e subcomando, sem argumentos): ${cmds.slice(0, 10).map(([k, v]) => `${k} ${v}x`).join(', ')}.`);
  out.push(`- Perguntas ao usuário: ${r.perguntas}${r.perguntas ? `, esperando ${minutos(r.segundosPerguntas)} no total` : ''}.`);
  const bloqueios = Object.entries(r.bloqueios).sort((a, b) => b[1] - a[1]);
  const totalBloqueios = bloqueios.reduce((x, [, v]) => x + v, 0);
  out.push(`- Bloqueios da guarda: ${totalBloqueios}.`);
  for (const [k, v] of bloqueios.slice(0, 8)) out.push(`  - ${v}x ${k}`);
  out.push('');
  out.push(...textoTravas(r.travas));
  const teste = r.teste ? textoDoTeste(r.teste) : '';
  if (teste) { out.push(teste.replace(/^\n/, '')); out.push(''); }
  out.push('## Por projeto');
  out.push('');
  out.push('| Projeto | Sessões | Chamadas de agente | Compactações | Custo |');
  out.push('|---|---|---|---|---|');
  for (const [nome, p] of Object.entries(r.projetos).sort((a, b) => b[1].custo - a[1].custo)) {
    out.push(`| ${nome} | ${p.sessoes} | ${p.agentes} | ${p.compactacoes} | ${dinheiro(p.custo)} |`);
  }
  return out.join('\n');
}

// Para onde vai o custo: cada fonte, no mestre e nos agentes, em parte do custo total.
function textoGasto(gasto) {
  const out = ['## Para onde vai o custo', ''];
  const g = gasto || { mestre: {}, agentes: {} };
  const total = Object.values(g.mestre).concat(Object.values(g.agentes)).reduce((x, v) => x + v, 0);
  if (!total) {
    out.push('Sem dados de uso nas transcrições deste período.', '');
    return out;
  }
  const parte = (v) => pct((100 * (v || 0)) / total);
  out.push('| De onde | Mestre | Agentes | Total | Custo |');
  out.push('|---|---|---|---|---|');
  const linhasG = Object.keys(CATEGORIAS_GASTO)
    .map((k) => [k, (g.mestre[k] || 0) + (g.agentes[k] || 0)])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  for (const [k, v] of linhasG) out.push(`| ${CATEGORIAS_GASTO[k]} | ${parte(g.mestre[k])} | ${parte(g.agentes[k])} | ${parte(v)} | ${dinheiro(v)} |`);
  out.push('');
  out.push('Estimativa: o custo de entrada de cada passo é dividido pelo tamanho de cada parte do contexto e por quantas vezes ela foi relida; o de saída é o que os agentes escrevem. Serve para comparar fontes, não como conta exata.');
  out.push('');
  return out;
}

// Seção das travas: vem só do registro (decisões e tempos), sem conteúdo.
const ESPECIAIS = new Set(['passou', 'consultou', 'fuga', 'fuga-sem-tentar', 'entregou-sem-verificar', 'concluiu-sem-revisao', 'pausou-sem-revisao']);
function textoTravas(tv) {
  const out = ['## Travas', ''];
  if (!tv || !tv.linhas) {
    out.push('Nenhuma decisão no registro das travas neste período (travas não instaladas ou sem uso).', '');
    return out;
  }
  out.push(`${tv.linhas} linhas no registro das travas (só decisões e tempos, sem conteúdo).`);
  for (const [nome, d] of Object.entries(tv.porTrava).sort((a, b) => a[0].localeCompare(b[0]))) {
    const partes = Object.entries(d).filter(([k]) => !ESPECIAIS.has(k)).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`);
    if (partes.length) out.push(`- ${nome}: ${partes.join(', ')}.`);
  }
  const m = tv.mapa;
  out.push(`- Fugas do mapa: ${m.fugas}${m.chamadas ? ` de ${m.chamadas} (${pct((100 * m.fugas) / m.chamadas)})` : ''}${m.semTentar ? `, ${m.semTentar} delas sem nem tentar o mapa` : ''}. Base: chamadas do Explore e do revisor que consultaram o mapa ou fugiram dele.`);
  out.push(`- Entregas sem verificação: ${tv.entregasSemVerificar}. Mudanças concluídas sem chamar o revisor depois da cobrança: ${tv.conclusoesSemRevisao}${tv.conclusoesComRevisor ? `; com o revisor chamado, mas sem aprovação reconhecida (reprovou, ou veio sem veredito): ${tv.conclusoesComRevisor}` : ''}${tv.pausasSemRevisao ? `. Pausas para perguntar ao usuário (não contam como conclusão): ${tv.pausasSemRevisao}` : ''}.`);
  const tempos = DESPACHANTES.filter((d) => tv.tempos[d]).map((d) => { const t = tv.tempos[d]; return `${d} ${ms(t.media)} em média, p95 ${ms(t.p95)}, pior ${ms(t.pior)} (${t.vezes}x)`; });
  if (tempos.length) out.push(`- Tempo dos hooks: ${tempos.join('; ')}.`);
  out.push('');
  return out;
}

// Indicadores em que subir é bom; nos outros, descer é bom.
const MAIOR_MELHOR = new Set(['explore_mapa_pct', 'mapa_antes_da_leitura_pct', 'correcao_com_teste_vermelho_pct', 'progresso_atualizado_pct']);
const ROTULOS = {
  custo_por_sessao: ['Custo por sessão', dinheiro],
  custo_mestre_pct: ['Parte do mestre no custo', pct],
  leituras_do_mestre_por_sessao: ['Leituras do mestre por sessão', (v) => nf(1).format(v)],
  explore_tokens_por_chamada: ['Tokens de entrada por chamada do Explore', mil],
  explore_mapa_pct: ['Chamadas do Explore que consultaram o mapa', pct],
  haiku_passos_acima_100k: ['Passos de Haiku acima de 100 mil', (v) => nf(0).format(v)],
  bloqueios_por_sessao: ['Bloqueios da guarda por sessão', (v) => nf(1).format(v)],
  aprovacoes_por_sessao: ['Pedidos de aprovação por sessão', (v) => nf(1).format(v)],
  minutos_esperando_aprovacao_por_sessao: ['Minutos parados esperando aprovação, por sessão', (v) => nf(0).format(v)],
  barrados_pelo_auto_por_sessao: ['Barrados pelo modo Auto por sessão', (v) => nf(1).format(v)],
  revisor_reprovado_pct: ['Revisões reprovadas', pct],
  implementador_incompleto_pct: ['Tarefas do implementador não concluídas', pct],
  compactacoes_por_sessao: ['Compactações por sessão', (v) => nf(1).format(v)],
  subidas_de_modelo: ['Subidas de modelo', (v) => nf(0).format(v)],
  mapa_antes_da_leitura_pct: ['Explore e revisor com mapa antes da primeira leitura de código', pct],
  mestre_leituras_por_pedido_mediana: ['Leituras de código do mestre por pedido (mediana)', (v) => nf(1).format(v)],
  fugas_do_mapa_pct: ['Fugas do mapa', pct],
  travas_barrou_por_sessao: ['Travas que barraram ou pediram, por sessão', (v) => nf(1).format(v)],
  entregas_sem_verificacao: ['Entregas sem verificação', (v) => nf(0).format(v)],
  conclusoes_sem_revisor: ['Mudanças concluídas sem chamar o revisor', (v) => nf(0).format(v)],
  correcao_com_teste_vermelho_pct: ['Correções de bug com teste vermelho antes da correção', pct],
  hooks_p95_ms: ['Tempo dos hooks (p95 do mais lento)', ms],
  progresso_atualizado_pct: ['Sessões com mudança de código que atualizaram o progresso', pct],
  gasto_fixo_pct: ['Parte do custo: começo de cada conversa (regras, prompt)', pct],
  gasto_leitura_pct: ['Parte do custo: leitura e busca de arquivos', pct],
  gasto_terminal_pct: ['Parte do custo: saída de terminal', pct],
  gasto_escrita_pct: ['Parte do custo: o que os agentes escrevem', pct],
};
// Partes do custo: subir ou descer não é bom nem ruim por si (uma cai quando outra sobe).
const SO_MUDOU = new Set(['gasto_fixo_pct', 'gasto_leitura_pct', 'gasto_terminal_pct', 'gasto_escrita_pct']);

export function comparacao(antes, agora) {
  const out = ['| Indicador | Antes | Agora | |', '|---|---|---|---|'];
  for (const [k, [rotulo, fmt]] of Object.entries(ROTULOS)) {
    if (!(k in agora) || !(k in antes)) continue;
    const a = antes[k];
    const b = agora[k];
    if (typeof a !== 'number' || typeof b !== 'number') continue;
    let sinal = '=';
    if (Math.abs(b - a) > Math.max(Math.abs(a) * 0.05, 1e-9)) {
      const melhorou = MAIOR_MELHOR.has(k) ? b > a : b < a;
      sinal = SO_MUDOU.has(k) ? (b > a ? 'subiu' : 'desceu') : melhorou ? 'melhorou' : 'piorou';
    }
    out.push(`| ${rotulo} | ${fmt(a)} | ${fmt(b)} | ${sinal} |`);
  }
  return out.join('\n');
}

// ---------- diário ----------
function carimbo() {
  const d = new Date();
  const p = (x, n = 2) => String(x).padStart(n, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

// Nome que ainda não existe na pasta: duas rodadas no mesmo instante não se sobrescrevem.
function arquivoNovo(pasta, prefixo, extensao) {
  const base = `${prefixo}-${carimbo()}`;
  let nome = path.join(pasta, `${base}${extensao}`);
  for (let i = 2; fs.existsSync(nome); i++) nome = path.join(pasta, `${base}-${i}${extensao}`);
  return nome;
}

// Estado das retrospectivas em ultima-retro.json:
//   data, medicao, propostas, dias, filtro: a última retrospectiva concluída (com as
//     propostas guardadas). É a base de comparação e a data que o boletim usa.
//   pendente: a medição de uma retrospectiva em andamento. Só vira base quando as
//     propostas são guardadas; repetir --retro, ou rodar com outro período ou projeto,
//     não apaga a base nem as propostas anteriores.
function principal() {
  const o = opcoes(process.argv.slice(2));
  const diario = pastaDiario();
  const arquivoEstado = path.join(diario, 'ultima-retro.json');
  const estado = lerJson(arquivoEstado) || {};
  const gravarEstado = (e) => {
    fs.mkdirSync(diario, { recursive: true });
    fs.writeFileSync(arquivoEstado, JSON.stringify(e, null, 2));
  };

  // Teste de desligar uma trava (a retrospectiva propõe, o usuário aprova): 7 dias, em todos
  // os projetos; a trava volta sozinha no fim.
  if (o.testarTrava) {
    if (!TRAVAS_TESTAVEIS.includes(o.testarTrava)) {
      console.error(o.testarTrava === '-'
        ? `Diga qual trava: --testar-trava <nome>. As testáveis: ${TRAVAS_TESTAVEIS.join(', ')}.`
        : `"${o.testarTrava}" não é uma trava testável. As testáveis: ${TRAVAS_TESTAVEIS.join(', ')}.`);
      process.exit(1);
    }
    const ate = new Date(Date.now() + DIAS_TESTE * 86400000);
    fs.mkdirSync(diario, { recursive: true });
    fs.writeFileSync(path.join(diario, ARQUIVO_TESTE), `${JSON.stringify({ trava: o.testarTrava, desde: new Date().toISOString(), ate: ate.toISOString() }, null, 2)}\n`);
    registrarTrava(o.testarTrava, 'teste-ligou', 0, {});
    console.log(`A trava "${o.testarTrava}" fica desligada até ${data(ate.toISOString())}, em todos os projetos. Ela volta sozinha nessa data; para voltar antes, rode com --fim-teste. A próxima retrospectiva compara os indicadores dela.`);
    return;
  }
  if (o.fimTeste) {
    const t = lerJson(path.join(diario, ARQUIVO_TESTE));
    try { fs.rmSync(path.join(diario, ARQUIVO_TESTE), { force: true }); } catch { /* já não existia */ }
    if (t && t.trava) registrarTrava(String(t.trava), 'teste-fim', 0, {});
    console.log('Teste encerrado: todas as travas voltaram ao normal.');
    return;
  }

  if (o.propostas) {
    const conteudo = lerTexto(o.propostas);
    if (conteudo === null) { console.error(`Não achei o arquivo ${o.propostas}.`); process.exit(1); }
    fs.mkdirSync(diario, { recursive: true });
    const destino = arquivoNovo(diario, 'retro-propostas', '.md');
    fs.writeFileSync(destino, conteudo);
    const base = estado.pendente || { data: new Date().toISOString(), medicao: estado.medicao || null, dias: estado.dias ?? null, filtro: estado.filtro ?? null };
    gravarEstado({ data: base.data, medicao: base.medicao, dias: base.dias, filtro: base.filtro, propostas: destino, pendente: null });
    console.log(`Propostas guardadas em ${destino}. A próxima retrospectiva compara com esta.`);
    return;
  }

  if (o.ultima) {
    if (!estado.data) { console.log('Nenhuma retrospectiva concluída ainda.'); }
    else {
      console.log(`Última retrospectiva concluída: ${data(estado.data)} (${estado.dias || '?'} dias${estado.filtro ? `, projeto "${estado.filtro}"` : ''}).`);
      const prop = estado.propostas ? lerTexto(estado.propostas) : null;
      console.log(prop ? `\n${prop.slice(0, 4000)}` : 'Sem propostas guardadas.');
    }
    if (estado.pendente) console.log(`\nHá uma medição de ${data(estado.pendente.data)} esperando as propostas (--guardar-propostas).`);
    return;
  }

  const r = medir({ dias: o.dias, projeto: o.projeto, raiz: o.raiz });
  if (o.json) { console.log(JSON.stringify(r, null, 2)); return; }
  const saida = [texto(r)];

  if (o.retro) {
    const versao = lerJson(path.join(pastaClaude(), 'equipe-versao.json'));
    if (versao && versao.pasta) {
      saida.push('');
      saida.push(`Cópia da equipe neste computador: ${versao.pasta}${versao.commit ? ` (instalada a partir do commit ${String(versao.commit).slice(0, 7)})` : ''}.`);
    }
    const medicaoAnterior = estado.medicao ? lerJson(estado.medicao) : null;
    const mesmaBase = (estado.dias ?? o.dias) === o.dias && (estado.filtro || null) === (o.projeto || null);
    if (medicaoAnterior && medicaoAnterior.indicadores && mesmaBase) {
      saida.push('');
      saida.push(`## Desde a última retrospectiva (${data(estado.data)})`);
      saida.push('');
      saida.push(comparacao(medicaoAnterior.indicadores, r.indicadores));
    } else if (medicaoAnterior) {
      saida.push('');
      saida.push(`A última retrospectiva (${data(estado.data)}) usou outro período ou outro projeto: sem comparação de números desta vez.`);
    } else {
      saida.push('');
      saida.push('Primeira retrospectiva: esta medição vira a base de comparação da próxima, quando as propostas forem guardadas.');
    }
    const prop = estado.propostas ? lerTexto(estado.propostas) : null;
    if (prop) {
      saida.push('');
      saida.push('### Propostas da última retrospectiva');
      saida.push('');
      saida.push(prop.slice(0, 4000));
    }
    if (r.sessoes) {
      fs.mkdirSync(diario, { recursive: true });
      const arq = arquivoNovo(diario, 'medicao', '.json');
      fs.writeFileSync(arq, JSON.stringify(r, null, 2));
      gravarEstado({ ...estado, pendente: { data: new Date().toISOString(), medicao: arq, dias: o.dias, filtro: o.projeto || null } });
      saida.push('');
      saida.push(`Medição guardada em ${arq}. Ela vira a base quando as propostas forem guardadas (--guardar-propostas).`);
    }
  }
  console.log(saida.join('\n'));
}

// Só roda como programa; importado pelos testes, expõe as funções.
// Compara o caminho real: chamado por um atalho (junção, symlink), também roda.
const real = (p) => {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch { /* fica o caminho dado */ }
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) principal();
