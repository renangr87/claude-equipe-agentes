# Modelos: preço, desempenho e onde cada um entra na equipe

Dados oficiais da Anthropic, consultados em 8 de outubro de 2026. Preços e modelos mudam: confira as fontes no fim antes de decidir com base nestes números.

## Preço por milhão de tokens (API)

| Modelo | ID | Entrada | Saída | Leitura de cache | Velocidade | Esforço padrão | Lançamento |
|---|---|---|---|---|---|---|---|
| Fable 5.1 | `claude-fable-5-1` | US$ 10 | US$ 50 | US$ 0,25 | mais lento | high | — |
| Opus 5.5 | `claude-opus-5-5` | US$ 4 | US$ 20 | US$ 0,20 | moderada | medium | 22/09/2026 |
| Sonnet 5.5 | `claude-sonnet-5-5` | US$ 2 | US$ 10 | US$ 0,10 | rápida | high na API, medium no Claude Code | 28/09/2026 |
| Haiku 5.5, entrada até 100 mil tokens | `claude-haiku-5-5` | US$ 0,10 | US$ 0,50 | US$ 0,01 | a mais rápida | medium | 07/10/2026 |
| Haiku 5.5, entrada acima de 100 mil tokens | | US$ 0,50 | US$ 2,50 | US$ 0,05 | | | |

Os quatro têm contexto de 1 milhão de tokens e saída máxima de 128 mil.

Em proporção: o Opus custa 2 vezes o Sonnet, e o Sonnet custa 20 vezes o Haiku (40 vezes, comparando Opus e Haiku). Na assinatura você não paga por token, mas modelos maiores consomem o limite de uso mais rápido, então a proporção continua sendo a referência.

## Benchmarks oficiais

| Teste | O que mede | Haiku 5.5 | Sonnet 5.5 | Opus 5.5 | Fable 5.1 |
|---|---|---|---|---|---|
| Terminal-Bench 4.0 | agente trabalhando no terminal | 39,2% | **70,6%** | 66,4% | 55,8% |
| FrontierCode 1.1 | código | 46,4% | 52,1% | **54,4%** | 50,3% |
| CursorBench 4.0 | código dentro do editor | — | 55,5% | **57,8%** | 51,8% |
| GDPval-AA v2.1 (Elo) | trabalho profissional | 1620 | 1844 | **1846** | 1735 |
| Humanity's Last Exam, com ferramentas | raciocínio difícil | 57,4% | 64,5% | **67,7%** | 65,6% |
| OSWorld 2.1 | uso de computador | 72,4%¹ | 80,1% | **81,8%** | 80,7% |

¹ Medido em outro subconjunto do teste; não compare direto com as outras colunas.

Como os números foram obtidos: o Opus 5.5 aparece quase sempre em esforço máximo (no Terminal-Bench, em xhigh). Para o Sonnet 5.5, o FrontierCode é em xhigh. O Haiku não tem resultado por nível de esforço.

Sobre o esforço, a Anthropic afirma que o Opus 5.5 em esforço médio supera o Opus 5 em esforço máximo, a cerca de um quinto do custo, e que o Haiku 5.5 é o primeiro Haiku com esforço ajustável e "combina bem com Opus 5.5 e Sonnet 5.5 como subagente em trabalho de código".

## O que isso decide na equipe

| Papel | Modelo | Por quê |
|---|---|---|
| mestre | Opus 5.5, médio | ligeiramente à frente nos testes de julgamento e código; erro de plano contamina o resto. Em esforço médio já é forte. |
| mestre, se o limite apertar | Sonnet 5.5, médio | quase empata com o Opus pela metade do preço, e no terminal é melhor. |
| Explore e verificador | Haiku 5.5, baixo | 1/20 do preço do Sonnet, feito para trabalho repetitivo. O limite de 100 mil vale para cada passo, e o subagente reenvia todo o contexto a cada passo: é o volume lido ao longo da busca que estoura, não o briefing. Uma pergunta por chamada; busca grande, dividida em chamadas menores. |
| implementador | Sonnet 5.5, médio | o Haiku fica em 39% no terminal, contra 70% do Sonnet; o Opus custa o dobro para ganho pequeno. |
| revisor | Sonnet 5.5, alto; Opus 5.5 em área sensível | o Opus leva a pequena vantagem justamente em julgamento. |
| — | Fable 5.1 | não usar: custa 2,5 vezes o Opus e fica abaixo dele em todos os testes acima. |

## O que estes números não dizem

- **São médias de testes públicos**, com os ajustes que a Anthropic escolheu. Não mostram como cada modelo se sai no seu código. Meça numa tarefa real antes de mudar um papel de modelo.
- **Não servem para o mestre decidir a cada chamada.** Quem decide é a regra de escalonamento em `rules/equipe-agentes.md`. Esta tabela não fica nas regras para não pesar em toda chamada.
- **Há divergências pequenas entre páginas oficiais**: a leitura de cache do Sonnet 5.5 aparece como US$ 0,20 na página do modelo e US$ 0,10 na tabela de preços; o Elo GDPval do Sonnet aparece como 1844 e 1840.
- **Os números são da própria Anthropic.**

## Fontes

- [Visão geral dos modelos](https://platform.claude.com/docs/en/models/overview)
- [Preços](https://platform.claude.com/docs/en/about-claude/pricing)
- [Introducing Claude Opus 5.5](https://www.anthropic.com/claude-opus-5-5)
- [Introducing Claude Sonnet 5.5](https://www.anthropic.com/claude-sonnet-5-5)
- [Introducing Claude Haiku 5.5](https://www.anthropic.com/claude-haiku-5-5)
- [Configuração de modelos no Claude Code](https://code.claude.com/docs/en/model-config)
