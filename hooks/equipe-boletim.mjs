#!/usr/bin/env node
// Hook SessionStart da equipe: boletim do projeto para o mestre.
//
// Diz, em poucas linhas, o que o mestre levaria várias chamadas para descobrir: o tamanho
// do projeto e se o mapa do código é obrigatório, se o projeto está configurado para o
// verificador, as notas de área, o plano em andamento, se há versão nova da equipe e se
// a retrospectiva está pendente, se esta cópia está no mapa, se a revisão de escopo achou
// algo fora do pedido e se a instalação da equipe tem problema. Só lê; nunca bloqueia;
// qualquer erro vira silêncio.
import fs from 'node:fs';
import path from 'node:path';
import { fatosDoProjeto, lerEntrada, lerJson, lerTexto, pastaDiario, saidaContexto, sessoesDesde, versaoDaEquipe } from './equipe-comum.mjs';
import { acharMapa, projetoIndexado, projetosDoMapa, resumoRapido, rodarMapa } from './equipe-diagnostico.mjs';
import { CONEXAO_LEITURA, leituraDeclarada } from './equipe-sql.mjs';

const DIAS_RETRO = 7;
const SESSOES_RETRO = 10;

export function boletim(entrada) {
  const fatos = fatosDoProjeto(entrada.cwd || process.cwd());
  if (!fatos) return '';
  const origem = entrada.source || 'startup';
  const l = [];
  if (fatos.codigo > 0) linhasDoProjeto(fatos, origem, l);
  escopo(fatos.raiz, l);
  if (origem === 'startup') avisos(l);
  if (!l.length) return '';
  return ['Boletim da equipe (hook de início de sessão; dados lidos agora do projeto):', ...l].join('\n');
}

function linhasDoProjeto(fatos, origem, l) {
  const modulos = fatos.modulos.length > 1 ? `, ${fatos.modulos.length} módulos (${fatos.modulos.slice(0, 5).join(', ')})` : '';
  if (fatos.mapaObrigatorio) {
    l.push(`- Projeto ${fatos.raiz}: ${fatos.codigo} arquivos de código${modulos}. O mapa do código é obrigatório aqui: na primeira tarefa, o Explore confere o índice e indexa se faltar.`);
    const indexado = mapaIndexado(fatos.raiz);
    if (indexado === true) l.push('- Mapa: esta cópia está indexada.');
    else if (indexado === false) l.push('- Mapa: esta cópia não está indexada (o Explore indexa na primeira tarefa).');
  } else {
    l.push(`- Projeto ${fatos.raiz}: ${fatos.codigo} arquivos de código${modulos}. Projeto pequeno: o mapa é opcional.`);
  }

  if (!fatos.configurado) {
    l.push(`- ${fatos.claudeMd ? 'O CLAUDE.md do projeto não tem os comandos preenchidos' : 'O projeto não tem CLAUDE.md'}: siga "Projeto sem configuração" antes de delegar.`);
  }
  if (fatos.comandos === null) {
    l.push('- Falta .claude/verificador-comandos.txt: a guarda bloqueia todo comando do verificador até a lista existir e estar em commit.');
  } else if (!fatos.listaEmCommit) {
    l.push('- .claude/verificador-comandos.txt tem mudança fora de commit (ou não está no git): a guarda bloqueia o verificador até o commit.');
  } else {
    l.push(`- Verificador: ${fatos.comandos.length} comando(s) liberado(s) em .claude/verificador-comandos.txt, em commit.`);
  }

  // Sem a conexão só de leitura, o hook de SQL barra toda consulta ao banco: o usuário
  // precisa saber logo, uma vez.
  if (origem === 'startup' && fatos.modulos.some((m) => m === 'supabase' || m.endsWith('/supabase')) && !leituraDeclarada(fatos.raiz)) {
    l.push(`- Projeto com Supabase sem a conexão só de leitura (${CONEXAO_LEITURA}): consulta ao banco pela conexão que escreve é barrada pela equipe. Avise o usuário uma vez, no fim da primeira tarefa, para configurá-la (README da equipe, "Consultas ao banco sem pedir aprovação").`);
  }

  if (fatos.notas.length) {
    const mais = fatos.notas.length > 12 ? ` e mais ${fatos.notas.length - 12}` : '';
    l.push(`- Notas de área: ${fatos.notas.slice(0, 12).join(', ')}${mais}. O Explore e o revisor recebem esta lista sozinhos; aponte no briefing a que importa.`);
  }

  const p = fatos.plano;
  if (p && (p.abertos > 0 || origem === 'compact')) {
    const idade = p.dias === null ? '' : p.dias === 0 ? ', atualizado hoje' : `, atualizado há ${p.dias} dia(s)`;
    const passos = p.abertos + p.feitos > 0 ? `: ${p.feitos} de ${p.feitos + p.abertos} passos marcados como feitos` : '';
    const acao = origem === 'compact'
      ? 'A conversa acabou de ser compactada: releia o plano antes de continuar.'
      : 'Se a tarefa de agora é a mesma, releia antes de continuar; se não, ignore.';
    const tentado = p.jaTentado ? ` A seção "Já tentado" tem ${p.jaTentado} item(ns): não repita esses caminhos.` : '';
    l.push(`- Plano em .revisao/plano.md${passos}${idade}. ${acao}${tentado}`);
  }
}

// O mapa já tem esta cópia? Pergunta ao programa (codebase-memory-mcp cli list_projects,
// 2 segundos no máximo). true, false, ou null quando não dá para saber: programa ausente
// ou saída que não deu para ler (aí o boletim não diz nada).
export function mapaIndexado(raiz) {
  const programa = acharMapa();
  if (!programa) return null;
  const saida = rodarMapa(programa, ['cli', 'list_projects', '{"format":"json","limit":500,"metadata_only":true}'], 2000);
  const projetos = projetosDoMapa(saida);
  if (!projetos) return null;
  return projetoIndexado(projetos, raiz);
}

// A revisão de escopo de menos de 1 dia achou mudança fora do pedido: o mestre lê antes
// do commit.
function escopo(raiz, l) {
  const arquivo = path.join(raiz, '.revisao', 'escopo.md');
  let idade = Infinity;
  try { idade = Date.now() - fs.statSync(arquivo).mtimeMs; } catch { return; }
  if (idade > 86400000) return;
  const texto = lerTexto(arquivo);
  if (texto && texto.includes('FORA DO ESCOPO')) {
    l.push('- .revisao/escopo.md (de menos de 1 dia) marca mudança FORA DO ESCOPO: leia antes do commit e resolva com o usuário o que fica.');
  }
}

// Avisos para o usuário: só no começo de uma sessão nova, para não repetir.
function avisos(l) {
  const problema = resumoRapido();
  if (problema) l.push(`- ${problema}`);
  const v = versaoDaEquipe();
  if (v && v.atrasada) {
    l.push(`- Há versão nova da equipe no GitHub (instalada ${v.instalada.slice(0, 7)}, disponível ${v.remota.slice(0, 7)}). No fim da primeira tarefa, avise o usuário uma vez: rodar de novo a linha de instalação.`);
  }
  const ultima = lerJson(path.join(pastaDiario(), 'ultima-retro.json'));
  const desde = ultima && ultima.data ? Date.parse(ultima.data) : 0;
  const dias = desde ? Math.floor((Date.now() - desde) / 86400000) : null;
  if (dias === null || dias >= DIAS_RETRO) {
    const sessoes = sessoesDesde(desde);
    if (sessoes >= SESSOES_RETRO) {
      const quando = dias === null ? 'nunca foi feita' : `foi há ${dias} dias`;
      l.push(`- Retrospectiva da equipe: ${quando}, e houve ${sessoes} sessões desde então. No fim de uma tarefa, sugira ao usuário uma vez rodar /retro-equipe (de preferência numa sessão aberta na pasta da equipe).`);
    }
  }
}

const entrada = lerEntrada();
try {
  saidaContexto('SessionStart', boletim(entrada));
} catch {
  // Silêncio: o boletim é ajuda, não pode atrapalhar a sessão.
}
