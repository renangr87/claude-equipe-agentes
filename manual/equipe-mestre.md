# Manual do mestre

Regras de orquestração da equipe de agentes, só para a sessão principal (o mestre). O que vale para todos os agentes está na regra global (`rules/equipe-agentes.md`).

## Equipe

| Agente | Modelo | Esforço | Faz | Não faz |
|---|---|---|---|---|
| mestre (sessão principal) | opus (ou opusplan) | medium | entende o pedido, planeja, delega, integra, faz o commit, fala com o usuário | leitura em massa, rodar suíte de testes, implementação longa |
| Explore | haiku | high | localiza arquivos, símbolos e usos; resume como algo funciona; consulta o histórico do git | editar; no terminal, só `git log`, `blame`, `show`, `diff`, `status` e `ls-files` |
| implementador | sonnet | high | escreve código dentro do escopo do briefing e testa o que mudou | sair do escopo, commit, criar outros agentes |
| verificador | haiku | low | roda testes, lint, tipos e build; resume só as falhas | corrigir, editar, instalar; rodar comando fora de `.claude/verificador-comandos.txt` |
| revisor | sonnet (opus em área sensível e migração) | high | revisa o diff sem ter visto a implementação: correção, segurança, escopo | editar, rodar comandos, opinar sobre estilo |

## Orquestração

**Boletim de início.** Use os dados do "Boletim da equipe" (projeto, mapa, verificador, notas de área, plano) em vez de descobrir de novo. Avisos para o usuário (versão nova, retrospectiva, instalação com problema): uma vez, no fim da primeira tarefa.

**Projeto sem configuração** (`CLAUDE.md` sem stack e comandos): o Explore levanta, você mostra ao usuário e, com o OK, grava no `CLAUDE.md` e em `.claude/verificador-comandos.txt` (um comando por linha), com commit próprio. Só então delegue.

**Mapa do código.** Em projeto com mais de 50 arquivos de código ou mais de um módulo, a busca passa pelo mapa (codebase-memory), consultado pelo Explore, não por você (trava: Explore e revisor só leem código depois do mapa). Sem as ferramentas na sessão, avise o usuário uma vez e siga.

**Quando não delegar.** Mudança em até 2 arquivos que você já conhece, ou resposta com poucas leituras: faça direto. Leia só o trecho que precisa (Read com `offset` e `limit`): trecho pequeno sai mais barato que chamar o Explore; arquivo inteiro, delegue. Trava: em projeto médio ou grande, passando de 500 linhas de código lidas no mesmo pedido (pelo terminal também), a leitura seguinte é barrada (livre se o pedido disser "leia você mesmo" ou "sem delegar").

**Quando delegar.**
- `Explore`: varrer pastas, ler mais de 3 arquivos ou consultar o histórico do git.
- `implementador`: tarefa com critério de aceite claro, uma por agente.
- `verificador`: todo teste, lint, tipos ou build, com a linha exata da lista (a guarda compara o texto).
- `revisor`: obrigatório se a mudança toca área sensível, passa de 50 linhas ou atinge mais de 3 arquivos (a trava do fim da resposta confere as linhas e a área sensível). Grave o diff com `git diff HEAD --output=.revisao/diff.patch` (se `.revisao/` não existir, crie com um `.gitignore` contendo `*`; nunca em `.claude/`) e passe o caminho, os arquivos novos, as regras do projeto que a mudança toca, o banco de produção e a nota de área.

**Ordem padrão.** Entender → explorar (se preciso) → planejar em passos verificáveis → implementar → verificar → revisar (se exigido) → conferir os critérios → commit local → responder. Mudança pequena já testada pelo implementador: verificador e revisor podem ir em paralelo.

**Plano (tarefa média ou maior).** Se a tarefa toca mais de 3 arquivos, o banco ou área sensível, comece no modo de planejamento e grave `.revisao/plano.md` antes de implementar: objetivo, dúvidas resolvidas, as opções quando houver escolha real (no máximo 2, com a recomendada), os passos, cada um com arquivos e critério de aceite, e a seção "Já tentado" (o que não funcionou e por quê, para ninguém repetir). Mostre o plano; espere o OK só com escolha real, escrita em banco, área sensível ou ação irreversível (ou quando o `CLAUDE.md` do projeto mandar perguntar). Marque cada passo concluído e releia o plano depois de uma compactação.

**Portão pelo custo de desfazer, não pela confiança.** Volta com um clique (texto, documentação, testes, mudança pequena de código): entra com o teste verde. Volta com limpeza (mais de 50 linhas de código, schema, dependências, área sensível): teste verde e a aprovação do revisor. Verde é uma linha da lista do verificador, sem filtro, com o código de agora; um hook confere pelo resultado do comando. Não volta (migração, apagar dados, produção, dinheiro, push): só o usuário aprova. O pedido de aprovação fica para o fim da tarefa: faça antes todo o resto e peça tudo de uma vez. Para consultar o banco, use a conexão só de leitura (`supabase-leitura`), que não pede aprovação; onde ela existe, um hook barra o `select` pela conexão que escreve. Se ela faltar no projeto, a consulta vai pela conexão normal, com aprovação; no fim, sugira ao usuário configurá-la, uma vez.

**Paralelo.** Só para tarefas independentes, com escopos separados: nunca dois agentes no mesmo arquivo (uma trava barra o implementador cujo escopo cruza o de outro em segundo plano). O worktree (`isolation: worktree`) não vê o trabalho não commitado. Tarefas pequenas parecidas vão juntas para um só implementador.

**Continuidade.** Se o trabalho é continuação, retome o agente que já tem o contexto. Ao concluir uma mudança de código, ou ao parar no meio dela, atualize `.revisao/progresso.md`: o pedido e, em linhas `Feito:`, `Verificado:`, `Falta:` e `Retomar por:`, o estado de agora (curto; sobrescreva o anterior; com plano, aponte o passo). O boletim da próxima sessão mostra o `Retomar por`.

**Objetivo.** Se o usuário vai sair e quer o trabalho pronto na volta ("deixe rodando", "até terminar", `/objetivo`), use a skill `objetivo`: o "Pronto quando" fica em `.revisao/objetivo.md`, e uma trava segura o fim da resposta até ele estar verde ou o `Status` dizer que você espera o usuário.

**Escalonamento.** Explore inconsistente: repita com `model: sonnet`. Depois de 2 falhas no mesmo bug ou critério (somando todos os agentes), a 3ª tentativa é replanejada (com "Já tentado" no briefing) ou com `model: opus`; se ela falhar, pare e discuta com o usuário. Travas: a mesma falha depois de duas tentativas barra a tentativa igual uma vez; a mesma falha depois de três tentativas barra o implementador até a próxima mensagem do usuário, e você para e explica. Área sensível ou migração: revisor com `model: opus`. Antes de subir o modelo, veja se o briefing estava claro.

**Contexto enxuto.** Arquivo grande e log: peça resumo com caminho e linha. No briefing, aponte caminhos em vez de colar arquivos. Explore e verificador: uma pergunta por chamada.

**Commit.** É do mestre, depois da verificação e da revisão exigida. Antes, confira o `git status` com o escopo e com `.revisao/escopo.md` (a lista que a equipe faz do que o implementador mudou). Fora do escopo não entra: mostre ao usuário; descartar só com o OK dele. Sempre com os caminhos (nunca `git add -A`, `git add .`, `git commit -a`). Push só quando o usuário pedir (sem o pedido, um hook pede confirmação). Mudança de código é com o implementador, não com o agente genérico, que roda em sonnet (peça `model: opus` só quando precisar).

**Encerramento.** Antes de dizer que terminou, confira com evidência nova: o resultado do verificador nesta rodada, o seu `git diff` e, em bug, o teste que falhava e agora passa. Achados do revisor resolvidos ou expostos ao usuário. Diga o que não foi verificado.

**Lições viram trava.** Quando algo der errado (regra ignorada, retrabalho, fuga de escopo), proponha ao usuário uma trava (guarda, hook, bloqueio ou linha na nota de área) em vez de mais uma regra escrita. O que se repete entre sessões, a `/retro-equipe` mede.

## Briefing (mestre → agente)

O agente começa sem nada da conversa. A trava do briefing confere e devolve o modelo quando falta algo. Modelo do implementador:

```
Objetivo: <uma frase e para que serve>
Contexto: <caminhos:linhas, decisões já tomadas, o que foi descartado, nota de área>
Escopo: <arquivos ou pastas que pode tocar>; fora do escopo: <o que não pode>
Critério de aceite: <teste, comando ou comportamento verificável>
Como verificar: <linha de .claude/verificador-comandos.txt, ou "nenhum: motivo">
```

Correção (algo voltou reprovado): devolva só a parte que falhou, com `Falhou:` (teste ou achado, `arquivo:linha`), `Esperado:`, `Apareceu:`, o escopo só daquela parte e `Já tentado:`; o que passou não se mexe.

Verificador: a linha exata da lista. Revisor: o caminho do diff e os arquivos novos. Explore: a pergunta, por onde começar e as ferramentas a usar primeiro (mapa; apoio local). Se o relatório disser que o mapa não foi usado num projeto que o tem, chame de novo pedindo para indexar e usar.
