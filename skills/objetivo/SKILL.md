---
name: objetivo
description: Transforma o pedido num objetivo com condição de parada verificável e faz a equipe seguir até o fim sem parar para perguntar. Use quando o usuário pedir /objetivo, disser que vai sair e quer o trabalho pronto na volta ("deixe rodando", "até terminar", "vou sair"), ou pedir para não ser interrompido.
---

# Objetivo com condição de parada

Objetivo: o usuário sai e volta com o trabalho pronto, ou feito até o ponto que só ele pode decidir. Uma trava da equipe segura o fim de cada resposta sua enquanto o "Pronto quando" não estiver cumprido.

## 1. Antes de começar (o usuário ainda está aqui)

- Entenda o pedido. Se falta uma decisão que só o usuário pode tomar e que muda o resultado, pergunte agora, tudo numa pergunta só. Depois disso, não pergunte mais nada até o fim.
- Escolha o critério de pronto: as linhas de `.claude/verificador-comandos.txt` que provam o resultado, escritas como estão na lista, e, se precisar, um critério a mais que dê para conferir ("o teste novo de login passa").

## 2. Grave `.revisao/objetivo.md`

Se a pasta `.revisao/` não existir, crie com um `.gitignore` contendo `*`.

```
# Objetivo
Pedido: <uma frase, nas palavras do usuário>
Pronto quando:
- `<linha exata da lista do verificador>`
- `<outra linha, se precisar>`
- <critério a mais, se houver, e como conferir>
Pare só para: aprovar push, gasto ou ação sem volta; o resto, decida.
Status: ativo
Decisões:
- <escolha que você fez sem perguntar, e por quê>
```

No fim de cada resposta sua, a trava lê esse arquivo:

- as linhas da lista citadas no "Pronto quando" precisam ter passado, sem filtro, com o código de agora (ela confere pelo resultado do comando, não pelo texto do relatório);
- sem linha da lista, ela espera `Status: concluído`;
- `Status: aguardando usuário: <o quê>` deixa você parar;
- `Status: encerrado` desliga o objetivo (o usuário mudou de assunto ou desistiu);
- com um agente ainda rodando em segundo plano, você pode parar para esperar o resultado.

A mesma cobrança, sem o código nem o arquivo mudarem, vale no máximo 3 vezes; cada mensagem do usuário leva no máximo 8 cobranças. O objetivo vence 24 horas depois da última gravação do arquivo. Quando o objetivo deixa parar, as outras travas do fim (revisão, prova) ainda cobram o que for delas.

## 3. Proponha o objetivo ao Claude Code, se der

Se a ferramenta `ProposeGoal` estiver disponível nesta sessão, chame-a com uma condição curta (até 500 caracteres) que dê para conferir pela conversa. Por exemplo: "O verificador rodou `flutter test` e `flutter analyze` com o código final e os dois passaram; ou o mestre registrou em .revisao/objetivo.md que aguarda o usuário para aprovar o push." O avaliador do Claude Code só lê a conversa; quem confere os comandos é a trava da equipe. Sem a ferramenta, siga sem ela.

## 4. Trabalhe até o fim

- Siga a ordem padrão da equipe: explorar, planejar (`.revisao/plano.md`, em tarefa média ou maior), implementar, verificar, revisar quando exigido, commit local.
- Escolha comum (nome, uma entre duas abordagens boas, detalhe de texto): decida pela opção recomendada e anote em "Decisões".
- Escolha que muda o resultado para o usuário e não foi combinada: faça antes tudo o que não depende dela. Depois, marque `Status: aguardando usuário: <a escolha>`.
- O que pede aprovação (push, dependência nova, migração, produção, gasto) fica para o fim, tudo junto.
- A mesma falha três vezes: a escada de falhas para a equipe. Registre o caminho em "Já tentado" (no plano) e marque `Status: aguardando usuário: <o que travou>`.
- Ao fechar cada parte, atualize `.revisao/progresso.md`.

## 5. Termine

- **Pronto:** marque `Status: concluído` e atualize o progresso. Na resposta ao usuário, diga o que mudou, a evidência (as linhas da lista e o resultado), as decisões que você tomou e o que não foi verificado.
- **Parado no que só o usuário decide:** marque `Status: aguardando usuário: <o quê>`. Na resposta, diga o que já está pronto e faça o pedido de aprovação, tudo de uma vez.

## 6. Quando o usuário responder

Se a resposta destrava o trabalho, volte o `Status` para `ativo` e siga até o fim; se ela conclui (o push aprovado e feito, por exemplo), `concluído`; se o usuário mudou de assunto, `encerrado`. Enquanto o arquivo diz "aguardando", a trava não segura o fim da resposta.
