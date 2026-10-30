#!/usr/bin/env node
// Hook SessionStart da equipe: boletim do projeto para o mestre.
//
// Diz, em poucas linhas, o que o mestre levaria várias chamadas para descobrir: o tamanho
// do projeto e se o mapa do código é obrigatório, se o projeto está configurado para o
// verificador, as notas de área, o plano em andamento, se há versão nova da equipe e se
// a retrospectiva está pendente. Só lê; nunca bloqueia; qualquer erro vira silêncio.
import path from 'node:path';
import { fatosDoProjeto, lerEntrada, lerJson, pastaDiario, saidaContexto, sessoesDesde, versaoDaEquipe } from './equipe-comum.mjs';
import { CONEXAO_LEITURA, leituraDeclarada } from './equipe-sql.mjs';

const DIAS_RETRO = 7;
const SESSOES_RETRO = 10;

export function boletim(entrada) {
  const fatos = fatosDoProjeto(entrada.cwd || process.cwd());
  if (!fatos) return '';
  const origem = entrada.source || 'startup';
  const l = [];
  if (fatos.codigo > 0) linhasDoProjeto(fatos, origem, l);
  if (origem === 'startup') avisos(l);
  if (!l.length) return '';
  return ['Boletim da equipe (hook de início de sessão; dados lidos agora do projeto):', ...l].join('\n');
}

function linhasDoProjeto(fatos, origem, l) {
  const modulos = fatos.modulos.length > 1 ? `, ${fatos.modulos.length} módulos (${fatos.modulos.slice(0, 5).join(', ')})` : '';
  if (fatos.mapaObrigatorio) {
    l.push(`- Projeto ${fatos.raiz}: ${fatos.codigo} arquivos de código${modulos}. O mapa do código é obrigatório aqui: na primeira tarefa, o Explore confere o índice e indexa se faltar.`);
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
    l.push(`- Plano em .revisao/plano.md${passos}${idade}. ${acao}`);
  }
}

// Avisos para o usuário: só no começo de uma sessão nova, para não repetir.
function avisos(l) {
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
