#!/usr/bin/env node
// Hook SubagentStart da equipe: contexto automático para o Explore, o verificador e o
// revisor, que não carregam o CLAUDE.md do projeto.
//
// Entrega o que o mestre às vezes esquecia de pôr no briefing: a raiz do projeto, se o
// mapa é obrigatório e como conferir e indexar, as notas de área, os comandos liberados
// do verificador e as regras do projeto. Só lê; nunca bloqueia; erro vira silêncio.
import { fatosDoProjeto, lerEntrada, saidaContexto } from './equipe-comum.mjs';

function linhaProjeto(f) {
  const modulos = f.modulos.length > 1 ? `, ${f.modulos.length} módulos (${f.modulos.slice(0, 5).join(', ')})` : '';
  return `- Raiz do projeto: ${f.raiz}. ${f.codigo} arquivos de código${modulos}.`;
}

function linhaNotas(f, uso) {
  if (!f.notas.length) return null;
  const mais = f.notas.length > 12 ? ` e mais ${f.notas.length - 12}` : '';
  return `- Notas de área (${uso}): ${f.notas.slice(0, 12).join(', ')}${mais}.`;
}

function mapa(f, depois) {
  const quando = f.mapaObrigatorio ? 'O mapa do código é obrigatório neste projeto.' : 'Projeto pequeno: use o mapa se o índice já existir.';
  return `- ${quando} Se existirem as ferramentas mcp__codebase-memory__*, rode index_status ${depois}; se o índice faltar ou estiver velho, rode index_repository em ${f.raiz}, sem perguntar (não altera o projeto). Só avisar que falta não basta.`;
}

export function contexto(entrada) {
  const tipo = entrada.agent_type || '';
  if (!['Explore', 'verificador', 'revisor'].includes(tipo)) return '';
  const f = fatosDoProjeto(entrada.cwd || process.cwd());
  if (!f || f.codigo === 0) return '';
  const l = ['Contexto automático do projeto (hook da equipe; vale junto com o briefing):', linhaProjeto(f)];

  if (tipo === 'Explore') {
    l.push(mapa(f, 'antes da primeira busca'));
    l.push('- Depois, use o mapa para "onde está", "quem chama" e "o que depende disto", e confirme o ponto crítico lendo o trecho.');
    l.push('- Apoio local: arquivo que não é código com mais de ~300 linhas, ou muitos arquivos de uma vez, vai para mcp__apoio-local__resumir_arquivos (se existir); confirme com Read o trecho apontado.');
    const n = linhaNotas(f, 'leia a da pasta que a pergunta toca');
    if (n) l.push(n);
    l.push('- No relatório, diga se usou o mapa e o apoio local e, se não usou alguma que existia, por quê.');
  }

  if (tipo === 'revisor') {
    l.push(mapa(f, 'antes de usar detect_changes e trace_path'));
    if (f.regras) {
      l.push('- Regras deste projeto (seção "Regras deste projeto" do CLAUDE.md):');
      for (const r of f.regras.split('\n')) l.push(`  ${r}`);
    } else {
      l.push('- O CLAUDE.md do projeto não tem a seção "Regras deste projeto" preenchida: se o veredito depender de saber qual é o banco de produção ou as áreas sensíveis, pergunte ao mestre no relatório.');
    }
    const n = linhaNotas(f, 'leia a da pasta que o diff toca');
    if (n) l.push(n);
  }

  if (tipo === 'verificador') {
    if (f.comandos === null) {
      l.push('- Não existe .claude/verificador-comandos.txt: a guarda vai bloquear todo comando. Devolva isso ao mestre como bloqueio, sem tentar outros comandos.');
    } else {
      const estado = f.listaEmCommit ? 'em commit' : 'com mudança fora de commit: a guarda vai bloquear até o commit; devolva como bloqueio';
      l.push(`- Comandos liberados em .claude/verificador-comandos.txt (${estado}):`);
      for (const c of f.comandos.slice(0, 20)) l.push(`  - ${c}`);
      l.push('- Rode só os que o briefing pedir, cada um como está na lista, com argumentos a mais se precisar (por exemplo, um arquivo de teste).');
    }
  }
  return l.join('\n');
}

const entrada = lerEntrada();
try {
  saidaContexto('SubagentStart', contexto(entrada));
} catch {
  // Silêncio: o contexto é ajuda, não pode atrapalhar o agente.
}
