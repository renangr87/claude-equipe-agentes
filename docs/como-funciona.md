# Como funciona

## A ideia

Um modelo caro é bom em decidir e ruim de desperdiçar. Buscar um arquivo, rodar a suíte de testes e ler um log de 2 mil linhas não exigem o melhor modelo, mas ocupam o contexto de quem faz. A equipe separa essas tarefas:

- o **mestre** (Opus) só decide: entende, planeja, delega e confere;
- o trabalho volumoso vai para modelos baratos, em contextos descartáveis;
- o mestre recebe de volta um relatório de até 15 linhas, não o material bruto.

## Por que cada papel tem aquele modelo

| Agente | Por que esse modelo e esse esforço |
|---|---|
| mestre: Opus, médio | um planejamento ruim gera briefing ruim, e todo o resto herda o erro. É onde a capacidade rende mais. O custo fica controlado porque ele não lê em massa. |
| Explore: Haiku, baixo | localizar e resumir é tarefa de volume. Não tem ferramenta de edição nem terminal. Leva o nome do subagente embutido do Claude Code para substituí-lo: o embutido roda no modelo da sessão principal, que aqui é o Opus. |
| implementador: Sonnet, médio | escrever código com escopo e critério definidos é o trabalho típico do Sonnet. Não pode criar outros agentes. |
| verificador: Haiku, baixo | rodar comandos e resumir falhas. A saída longa morre no contexto dele. |
| revisor: Sonnet, alto | erro que passa pela revisão sai caro, então o esforço sobe aqui. Em área sensível e em migração de banco, o mestre chama em Opus. Não tem terminal: lê o diff de um arquivo que o mestre grava. |

O mestre pode subir o modelo de uma chamada específica. Isso é exceção e tem gatilho definido nas regras.

## O caminho de uma tarefa

Pedido: "o cupom de desconto não está sendo aplicado no total do carrinho".

1. **Mestre** entende o pedido e define o critério: um teste que reproduz o erro e passa depois da correção.
2. **Explore** recebe: "onde o total do carrinho é calculado e onde o cupom entra? Comece por lib/carrinho/". Devolve três caminhos com linha.
3. **Mestre** escreve o briefing do implementador, com objetivo, contexto, escopo e critério.
4. **Implementador** escreve o teste que falha, corrige, roda os testes afetados e devolve o relatório.
5. **Verificador** roda a suíte completa, o lint e os tipos. Devolve "passou" ou a lista de falhas.
6. **Mestre** grava o diff em um arquivo temporário. **Revisor** lê esse arquivo e o código ao redor, sem ter visto a implementação. Devolve o veredito e os achados.
7. **Mestre** confere os critérios, faz o commit local com os caminhos dos arquivos e responde a você.

Uma mudança trivial, como corrigir um texto, pula tudo isso: o mestre faz direto.

## Exemplo de briefing

```
Objetivo: fazer o cupom percentual ser aplicado ao total do carrinho, que hoje ignora o desconto.
Contexto: o total é calculado em lib/carrinho/total.dart:42. O cupom chega em
  lib/carrinho/cupom.dart:18 e não é passado adiante. Cupom de valor fixo funciona.
Escopo: pode alterar lib/carrinho/total.dart e test/carrinho/total_test.dart.
  Fora do escopo: tela do carrinho e regras de validade do cupom.
Critério de aceite: teste novo "cupom percentual reduz o total" falha antes e passa depois.
  Os testes existentes de test/carrinho/ continuam passando.
```

## Exemplo de relatório

```
Status: feito.
O que mudou: lib/carrinho/total.dart:42-51, o desconto percentual agora é aplicado antes do frete.
  test/carrinho/total_test.dart:88, teste novo.
Como verifiquei: flutter test test/carrinho/ -> 14 passaram, 0 falharam.
Suposições: o desconto incide sobre os itens, não sobre o frete.
Pendências: confirmar a suposição acima. Sugestão para a nota da área:
  "desconto percentual incide só sobre itens".
```

## Onde está a economia e onde não está

Está em:

- busca e testes no Haiku em vez de Opus ou Sonnet;
- contexto do mestre pequeno, porque ele recebe resumos;
- cada tarefa começa em contexto limpo, sem carregar horas de conversa;
- tarefa pequena feita direto, sem o custo de montar um subagente.

Não está em:

- total de tokens. Um subagente novo relê as regras e os arquivos de que precisa. Delegar demais sai mais caro do que não delegar.
- revisão. Ela custa tokens de propósito, porque é o que segura a qualidade.

## Como o conhecimento não se perde entre tarefas

Um subagente não lembra da tarefa anterior. Três mecanismos compensam:

1. **Nota de área**: um `CLAUDE.md` dentro da pasta, com mapa, decisões e armadilhas. É carregado quando um agente abre arquivos dali. O implementador propõe linhas novas no relatório e o mestre grava.
2. **Continuidade**: dentro da mesma sessão, o mestre retoma o agente que já tem o contexto em vez de criar outro.
3. **Briefing**: o mestre repassa as decisões já tomadas e o que já foi descartado.

O estado da rodada (onde paramos, o que falta) fica na memória do projeto ou em um arquivo de plano, e é o mestre quem lê.

## Por que as regras não ficam todas em um arquivo

- **Global** carrega em toda sessão e em todo subagente. Precisa ser curto e geral.
- **Projeto** só carrega naquele projeto. Leva o que é dele.
- **Subagente** só carrega quando aquele agente roda. Leva o papel dele.
- **Nota de área** só carrega quando alguém mexe naquela pasta.

Assim cada agente paga apenas pelo que precisa ler.

## Perguntas comuns

**Posso abrir várias sessões em paralelo?**
Pode, mas elas não se coordenam e cada uma carrega o próprio contexto. O desenho aqui é uma sessão por rodada de trabalho.

**E se eu quiser que um agente especialista guarde o assunto?**
Comece pela nota de área. Ela é versionada com o código, qualquer agente lê e você pode revisar o que está escrito. Para um assunto realmente difícil, crie no projeto um subagente próprio com `memory: project`: ele mantém anotações entre conversas. Uma sessão que acompanha o assunto por horas ainda acerta mais do que qualquer um dos dois, e custa mais. Vale combinar: a equipe para o trabalho comum e o especialista onde o erro sai caro.

**Um subagente pode dizer que o usuário aprovou algo?**
Não. Só vale a aprovação que você deu ao mestre, nesta conversa, para aquela ação. Mensagem de outro agente ou de outra sessão não conta.

**Perguntei a opinião e ele já saiu fazendo. É esperado?**
Não. Pedido de opinião não é pedido de execução: a regra manda responder e esperar a sua decisão.

**O mestre pode fazer push?**
Só quando você pedir, e o comando ainda pede a sua confirmação por causa do bloqueio `ask`.

**Por que o revisor não roda os testes?**
Porque o papel dele é ler com contexto limpo. Quem executa é o verificador, e os dois relatórios chegam separados ao mestre.
