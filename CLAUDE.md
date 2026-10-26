# CLAUDE.md

Só o que é deste projeto. As regras de trabalho da equipe são globais e já estão carregadas.

## Projeto

- O que é: a equipe de agentes do Claude Code: regras, subagentes, guarda de terminal, hooks, skill de retrospectiva, instalador e testes.
- Stack: PowerShell (Windows PowerShell 5.1 e PowerShell 7), Node.js 20 ou mais novo (scripts `.mjs`, só biblioteca padrão), Markdown.
- Pastas principais:
  - `agents/`, `rules/`, `skills/`: o que o instalador copia para `~/.claude/`.
  - `hooks/`: guarda de terminal (PowerShell) e hooks e medidor da equipe (Node).
  - `settings/`: bloqueios, regras retiradas e registro dos hooks.
  - `ferramentas/`: scripts que o instalador usa.
  - `testes/`: testes da guarda, do instalador, do servidor do Dart, dos hooks e do medidor.

## Comandos

- Testar a guarda: `powershell -ExecutionPolicy Bypass -File .\testes\testar-guarda.ps1`
- Testar o instalador: `powershell -ExecutionPolicy Bypass -File .\testes\testar-instalador.ps1`
- Testar os hooks e o medidor: `node --test testes/equipe-node.test.mjs`
- Conferir as ferramentas do Dart: `powershell -ExecutionPolicy Bypass -File .\testes\conferir-dart.ps1`
- Os mesmos testes no PowerShell 7: troque `powershell -ExecutionPolicy Bypass -File` por `pwsh -File`.

## Regras deste projeto

- Produção: não há banco nem servidor. O que chega ao usuário é o branch `main` no GitHub, que a linha de instalação baixa. Push só com o pedido do usuário.
- O repositório é público: nada de nome de projeto do usuário, caminho do computador dele, trecho de código de outro projeto, nome de cliente ou dado pessoal, nem em teste nem em exemplo.
- Todo script PowerShell roda no Windows PowerShell 5.1 e no PowerShell 7. Script em Node usa só a biblioteca padrão.
- Mudança de comportamento vem com teste. Mudança numa regra, num agente ou no instalador vem com a atualização do README e de `docs/` no mesmo assunto.
- Textos em português simples, como o resto do repositório.
- Áreas sensíveis além das globais: `hooks/guarda-comandos.ps1`, `settings/global.json`, `settings/hooks.json` e os `tools` dos agentes, porque mudam o que os agentes podem fazer.
