# CLAUDE.md

Exemplo ilustrativo de um projeto Flutter com Supabase. Troque os comandos e caminhos pelos seus.

## Projeto

- O que é: aplicativo móvel com backend no Supabase.
- Stack: Flutter (Dart) no app, Supabase (Postgres, funções em Deno) no backend.
- Pastas principais:
  - `app/`: aplicativo Flutter
  - `supabase/`: migrações e funções

## Comandos

- Instalar dependências: `flutter pub get` (dentro de `app/`)
- Testar tudo: `flutter test`
- Testar um arquivo: `flutter test test/<arquivo>_test.dart`
- Lint e tipos: `flutter analyze`
- Formatar (só arquivos tocados): `dart format <arquivo>`
- Build: `flutter build apk --dart-define-from-file=<arquivo de configuração>`

## Regras deste projeto

- Produção: o projeto Supabase ligado ao app publicado. Qualquer comando ou script que use a URL ou a chave dele é escrita em produção.
- Não entram em commit: rascunhos em `docs/` que ainda não foram aprovados.
- Instalar no aparelho: só com `adb install -r <apk>`, para não apagar os dados do app.
- Áreas sensíveis além das globais: `supabase/migrations/` e as políticas de acesso às tabelas.

## Notas de área

Pastas com `CLAUDE.md` próprio:
- `app/lib/features/<área>/`: <assunto>
