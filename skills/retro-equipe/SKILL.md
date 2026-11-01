---
name: retro-equipe
description: Retrospectiva da equipe de agentes. Mede o gasto e as falhas das sessões recentes (tokens por agente, bloqueios da guarda, esperas por aprovação, revisões reprovadas, uso do mapa do código) e propõe melhorias pequenas e testadas para o usuário aprovar. Use quando o usuário pedir /retro-equipe ou uma retrospectiva da equipe, ou quando o boletim de início disser que a retrospectiva está pendente e o usuário aceitar.
---

# Retrospectiva da equipe

Objetivo: transformar o que aconteceu nas sessões em poucas mudanças, testadas, na equipe ou nas notas de área. A equipe não se altera sozinha: você mede e propõe, o usuário escolhe, os testes conferem.

## 1. Medir

Rode, num comando só:

```
node "__PASTA_CLAUDE__/hooks/equipe-medir.mjs" --dias 7 --retro
```

Se o `node` não for encontrado, use o caminho completo `"__NODE__"` no lugar de `node` (no PowerShell, com `&` na frente: `& "__NODE__" "__PASTA_CLAUDE__/hooks/equipe-medir.mjs" --dias 7 --retro`). Se o usuário pedir outro período, troque `--dias 7`; para um projeto só, acrescente `--projeto <parte do nome>`.

A saída traz o gasto por agente, os sinais, a seção das travas, a divisão por projeto, a pasta da cópia da equipe e, a partir da segunda retrospectiva, a comparação com a anterior e as propostas daquela vez. O custo vem em preço de API: na assinatura ele serve como proporção do limite usado, não como conta.

Se existir um resultado dos testes de comportamento (`__PASTA_CLAUDE__/equipe-diario/comportamento-*.json`, o mais recente), leia também: cada checagem que falhou é um sinal direto e entra no diagnóstico ao lado dos números. Se o último tiver mais de 7 dias ou não existir, sugira rodar `node testes/comportamento/rodar.mjs` na pasta da equipe antes de aplicar mudanças.

A seção "Travas" vem do registro das travas (`__PASTA_CLAUDE__/equipe-diario/travas-AAAA-MM.log`), que só guarda data, trava, decisão, tempo, tipo de agente e chave da chamada: não tem conteúdo nenhum. "Fugas do mapa" conta, entre as chamadas do Explore e do revisor em que a trava do mapa decidiu (consultou ou fugiu), as que fugiram. "Leituras de código do mestre por pedido" dá a mediana e o máximo entre os pedidos que leram código.

Trabalhe só com essa saída e com esse resultado. Não abra as transcrições das sessões: elas têm código e dados pessoais do usuário, e a medição já traz o que importa.

## 2. Diagnosticar

Compare os números com a tabela abaixo. Os limites são pontos de partida, não verdades: diga quando um número está perto do limite e pode ser acaso, principalmente com poucas sessões.

| Sinal | Causa provável | Mudança que costuma resolver |
|---|---|---|
| Explore consultou o mapa em menos da metade das chamadas, em projeto médio ou grande | contexto automático não chegou (hooks não instalados) ou o Explore ignora | conferir se o boletim aparece no início da sessão; reforçar o prompt do Explore; em último caso, Explore em `sonnet` só naquele projeto |
| Mapa antes da primeira leitura de código abaixo de 100% no Explore ou no revisor | a trava do mapa não pegou (projeto pequeno, mapa não declarado, trava desligada) ou o briefing manda ler um arquivo direto | conferir se o projeto declara o mapa e se `mapa` não está em `EQUIPE_DESLIGAR`; ajustar a trava do mapa (`hooks/equipe-mapa.mjs`) com caso de teste; no briefing, pedir a pergunta e não o arquivo |
| Fugas do mapa acima de 5% | o mapa não responde (índice velho ou servidor fora do ar) ou o agente insiste na leitura | conferir `index_status` no início da chamada; reforçar no prompt do agente o que fazer quando o mapa falha |
| Mais de 150 mil tokens de entrada por chamada do Explore, ou passos de Haiku acima de 100 mil | perguntas grandes demais, leitura de arquivos inteiros | dividir as perguntas; nota de área dizendo por onde começar; apertar a trava de leitura (`EQUIPE_EXPLORE_LEITURAS`, `EQUIPE_EXPLORE_LINHAS`) |
| Mais de 20 leituras do mestre por sessão, ou mestre acima de 70% do custo | o mestre lê em vez de delegar; sessões longas | reforçar "Quando delegar"; sessões mais curtas |
| Leituras de código do mestre por pedido com mediana acima de 3 | o mestre lê código em vez de delegar ao Explore, ou o orçamento de leitura não pegou | conferir a trava `orcamento` (e `EQUIPE_MESTRE_LEITURAS`); reforçar "Quando delegar" |
| Uma compactação ou mais por sessão | sessões longas demais | uma sessão por tarefa; plano em `.revisao/plano.md` |
| O mesmo bloqueio da guarda 3 vezes ou mais | o agente não sabe o limite, ou o comando é legítimo e deveria passar | se for legítimo e seguro: caso de teste em `testes/casos-guarda.txt` e ajuste na guarda; se não: uma frase no prompt do agente dizendo o que fazer no lugar |
| Pedidos de aprovação respondidos pelo usuário (a sessão parou esperando) | ação da lista de confirmação no meio da tarefa | levar a ação para o fim (regra "O que pede confirmação fica para o fim"); se for `execute_sql`, conferir se o projeto tem a `supabase-leitura` configurada e autenticada (a trava de SQL só redireciona) |
| Muitas ações barradas pelo modo Auto | o agente tenta algo que o classificador considera arriscado ou fora do pedido | frase no prompt do agente dizendo o caminho certo; nunca liberar a ação sem o OK do usuário |
| Mais de 30% das revisões reprovadas | briefing do implementador sem critério claro, ou item do checklist do revisor que o implementador não conhece | contrato de briefing; copiar o item do checklist para o prompt do implementador |
| Mais de 20% das tarefas do implementador não concluídas | escopo ou contexto faltando no briefing | contrato de briefing; nota de área |
| Subidas de modelo frequentes num agente | o modelo padrão é fraco para aquele projeto | agente próprio no projeto (`.claude/agents/<nome>.md`) com modelo maior |
| Recusas de permissão | o agente tentou o que o usuário não queria | trava ou frase que evite a tentativa |
| Uma trava barrando muito (várias vezes por sessão, quase sempre no mesmo tipo de agente) | possível falso positivo, ou o agente não sabe o caminho que a trava espera | caso de teste com o uso legítimo e ajuste na trava; se o bloqueio for certo, frase no prompt do agente dizendo o que fazer no lugar |
| Hook lento: pior caso acima de 300 ms em `pre`, `pos` ou `eventos` | trava que roda `git` ou lê arquivo grande a cada ferramenta | medir qual trava pesa (o tempo de cada uma está no registro); cache ou saída rápida antes da parte cara |
| Entregas sem verificação | o implementador editou código depois do último teste e insistiu em entregar | frase no prompt do implementador sobre rodar a verificação no fim; conferir a lista de comandos do verificador na nota de área |
| Mudança grande concluída sem revisão | o mestre fechou a tarefa (mais de 50 linhas ou área sensível) sem chamar o revisor, mesmo avisado | reforçar a regra da revisão no fim da tarefa; conferir se a trava `revisao` não está em `EQUIPE_DESLIGAR` |
| Correções de bug com teste vermelho antes da correção abaixo de 80% | o implementador corrige antes de reproduzir o bug, e o teste "que passa" pode não provar nada | frase no prompt do implementador; se continuar baixo, trava que exige o teste vermelho antes da primeira edição de código numa correção |
| A mesma falha voltou (convergência barrou ou avisou várias vezes) | tentativas iguais: falta algo que o agente não vê, ou a tarefa está mal formulada | briefing de correção com "Já tentado" e o esperado e o que apareceu; replanejar mais cedo; nota de área com a armadilha |

Se uma proposta da retrospectiva anterior foi aplicada e o indicador dela não mudou, diga isso e proponha desfazer ou trocar.

## 3. Propor

No máximo 5 propostas, das que mais economizam ou mais evitam erro. Para cada uma:

- **Problema**, com o número que o mostra.
- **Mudança**: arquivo e o que muda, em uma ou duas linhas.
- **Como verificar**: o teste novo ou alterado e o indicador que deve mudar na próxima retrospectiva.
- **Custo e risco**, em uma linha.
- **Camada**: onde a lição entra, que é onde ela para de se repetir:
  - **ferramenta** (o agente não tinha como ver ou fazer: uma ferramenta, um acesso só de leitura, um comando liberado);
  - **memória** (repetiu o que já tinha dado errado: "Já tentado" no plano, nota de área, linha de "nunca" na nota);
  - **checagem** (deu "pronto" sem prova: teste exigido, trava de verificação, item no checklist do revisor);
  - **forma do trabalho** (a ordem, a divisão ou o paralelo estavam errados: regra de divisão no briefing, um agente a mais ou a menos);
  - **portão** (passou o que não devia, ou parou o que podia seguir: a faixa pelo custo de desfazer, quem aprova).
  Lição na camada errada vira conselho, e conselho é ignorado: "tome cuidado com X" no prompt é a camada errada quando cabe uma trava ou um teste.

Regras:

- Prefira trava a regra escrita: caso de teste mais regra na guarda, bloqueio no `settings.json`, hook ou linha na nota de área. Regra escrita só quando não houver trava possível.
- Nunca afrouxe segurança por conta própria: tirar a confirmação de uma ação sem volta, liberar comando destrutivo ou leitura de `.env`. Isso só aparece como opção, com o risco escrito, e só entra com o OK explícito do usuário.
- O repositório da equipe é público. Nas mudanças nele, nada de nome de projeto, caminho do computador, trecho de código, nome de cliente ou dado pessoal. Lição que só vale para um projeto vai para a nota de área daquele projeto.
- Mudança de modelo ou de esforço de um agente vem com o efeito esperado no custo.

## 4. Decidir

Mostre o diagnóstico e as propostas de uma vez e faça uma única pergunta ao usuário: quais aplicar (múltipla escolha). Não aplique nada antes da resposta.

## 5. Aplicar

- **Lição de um projeto:** grave na nota de área do projeto atual (o `CLAUDE.md` da pasta).
- **Mudança na equipe:** é feita na cópia da equipe, cuja pasta aparece na saída da medição. Se esta sessão não estiver aberta nessa pasta, não edite de fora: guarde as propostas (passo 6) e diga ao usuário para abrir uma sessão na pasta da equipe e pedir "aplique a última retrospectiva" (o comando `--ultima` mostra as propostas guardadas).
- **Na pasta da equipe:**
  1. Faça a mudança.
  2. Rode os testes: `powershell -ExecutionPolicy Bypass -File .\testes\testar-guarda.ps1`, `powershell -ExecutionPolicy Bypass -File .\testes\testar-instalador.ps1` e `node --test testes/equipe-node.test.mjs testes/travas.test.mjs testes/medidor-travas.test.mjs`.
  3. Faça o commit com os caminhos dos arquivos.
  4. Faça push só se o usuário pedir.
  5. Diga ao usuário para rodar de novo a linha de instalação.

## 6. Guardar

Escreva as propostas, as aplicadas e as recusadas, cada uma com o indicador que deve mudar, em `.revisao/retro-propostas.md` do projeto atual. Se a pasta `.revisao/` não existir, crie-a com um arquivo `.revisao/.gitignore` contendo `*`. Depois rode:

```
node "__PASTA_CLAUDE__/hooks/equipe-medir.mjs" --guardar-propostas .revisao/retro-propostas.md
```

Guarde sempre, mesmo que o usuário não aplique nenhuma proposta: é isso que conclui a retrospectiva. A medição deste passo só vira a base de comparação quando as propostas são guardadas. A próxima retrospectiva mostra essas propostas ao lado dos números novos, e é assim que se sabe o que funcionou.
