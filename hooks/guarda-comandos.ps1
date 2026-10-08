<#
.SYNOPSIS
  Guarda de terminal dos subagentes Explore, verificador e implementador (hook PreToolUse).

.DESCRIPTION
  O Claude Code chama este script antes de cada comando de terminal do subagente
  e entrega o JSON da chamada pela entrada padrao.

  Saida 0: o comando segue o fluxo normal de permissoes.
  Saida 2: o comando e bloqueado e a mensagem vai para o subagente.

  Qualquer erro inesperado tambem sai com 2. Com saida 1 o Claude Code
  deixaria o comando passar.

  Perfis:
    explore        so historico e estado do git: log, blame, show, diff, status, ls-files.
    verificador    so os comandos listados em .claude/verificador-comandos.txt do projeto.
                   Cada linha libera o comando exato e o mesmo comando com argumentos a mais.
    implementador  terminal livre, menos formatadores: so passam com arquivos nomeados um
                   a um. Pasta, '.', curinga, variavel ou nenhum arquivo sao bloqueados.
                   Scripts de formatacao (npm run format e parecidos) sao bloqueados.
                   Vale para cada parte de um comando composto (&&, ;, |, &).

.PARAMETER Perfil
  explore, verificador ou implementador.
#>
param([string]$Perfil = '')

function Bloquear([string]$motivo) {
    [Console]::Error.WriteLine("Bloqueado pela guarda ($Perfil): $motivo")
    exit 2
}

# Encadeamento, redirecionamento, subcomando e variavel: nada disso e permitido
# fora do texto que uma linha da lista ja traz.
$operadores = '[;&|<>`$(){}]'

# Formatadores: nome do programa, o que vem depois dele e, quando o padrao e so
# conferir, a opcao que faz gravar ($null = grava sempre).
$formatadores = @(
    @{ nome = 'dart';         resto = ' format';             escrita = $null },
    @{ nome = 'flutter';      resto = ' format';             escrita = $null },
    @{ nome = 'dart';         resto = ' fix';                escrita = '--apply' },
    @{ nome = 'prettier';     resto = '';                    escrita = '(--write|-w)' },
    @{ nome = 'eslint';       resto = '';                    escrita = '--fix' },
    @{ nome = 'stylelint';    resto = '';                    escrita = '--fix' },
    @{ nome = 'biome';        resto = ' (format|check|lint)'; escrita = '--(write|apply|apply-unsafe|fix)' },
    @{ nome = 'black';        resto = '';                    escrita = $null },
    @{ nome = 'ruff';         resto = ' format';             escrita = $null },
    @{ nome = 'ruff';         resto = ' check';              escrita = '--fix' },
    @{ nome = 'isort';        resto = '';                    escrita = $null },
    @{ nome = 'autopep8';     resto = '';                    escrita = '(-i|--in-place)' },
    @{ nome = 'yapf';         resto = '';                    escrita = '(-i|--in-place)' },
    @{ nome = 'gofmt';        resto = '';                    escrita = '-w' },
    @{ nome = 'goimports';    resto = '';                    escrita = '-w' },
    @{ nome = 'go';           resto = ' fmt';                escrita = $null },
    @{ nome = 'cargo';        resto = ' fmt';                escrita = $null },
    @{ nome = 'rustfmt';      resto = '';                    escrita = $null },
    @{ nome = 'dotnet';       resto = ' format';             escrita = $null },
    @{ nome = 'clang-format'; resto = '';                    escrita = '-i' },
    @{ nome = 'swiftformat';  resto = '';                    escrita = $null },
    @{ nome = 'ktlint';       resto = '';                    escrita = '(-F|--format)' },
    @{ nome = 'rubocop';      resto = '';                    escrita = '(-a|-A|-x|--autocorrect|--autocorrect-all|--fix-layout)' },
    @{ nome = 'php-cs-fixer'; resto = ' fix';                escrita = $null },
    @{ nome = 'terraform';    resto = ' fmt';                escrita = $null },
    @{ nome = 'shfmt';        resto = '';                    escrita = '-w' }
)
# O que pode vir antes do formatador e ainda executa-lo.
$prefixos = '(xargs|-exec|-c|-command|npx|bunx|uvx|fvm|env|sudo|time|nice|%|foreach-object|foreach|pnpm exec|pnpm dlx|yarn dlx|uv run|poetry run|pipx run|python3? -m|py -m|dart run|flutter pub run)'
$soConferencia = '(^| )(--check|-check|--diff|--dry-run|--verify-no-changes|--list-different|(-o|--output)[= ]none)( |$)'
$scriptsFormatacao = '(^| )((npm|pnpm|yarn|bun)( run)? (format|fmt|prettier|lint:fix|fix)|make (format|fmt)|melos (run )?format|just (format|fmt))( |$)'

function Testar-Formatadores([string]$texto, [string]$pastaAtual) {
    foreach ($parte in ($texto -split '[;&|\r\n]+')) {
        $seg = ($parte -replace '[''"(){}]', ' ' -replace '\s+', ' ').Trim()
        if (-not $seg) { continue }
        if ($seg -match $scriptsFormatacao) {
            Bloquear "script de formatacao ('$seg') formata o projeto inteiro. Rode o formatador direto, so com os arquivos que voce alterou."
        }
        foreach ($f in $formatadores) {
            $padrao = '(?i)(^|(^| )' + $prefixos + '( (-\S+|\d+|\S+=\S*))* )(\S*[\\/])?' + [regex]::Escape($f.nome) + '(\.(exe|bat|cmd))?' + $f.resto + '( |$)'
            $m = [regex]::Match($seg, $padrao)
            if (-not $m.Success) { continue }
            if ($seg -match $soConferencia) { continue }
            if ($f.escrita -and ($seg -notmatch ('(?i)(^| )' + $f.escrita + '( |$|=)'))) { continue }
            $resto = $seg.Substring($m.Index + $m.Length)
            $arquivos = 0
            foreach ($t in ($resto -split ' ')) {
                if (-not $t -or $t.StartsWith('-') -or $t -match '^\d+$') { continue }
                $ehArquivo = ($t -notmatch '[*?$\[\]]') -and ($t -match '\.[A-Za-z0-9_]+$') -and ($t -notmatch '(^|[\\/])\.\.?$')
                if ($ehArquivo -and $pastaAtual) {
                    try { if (Test-Path -LiteralPath (Join-Path $pastaAtual $t) -PathType Container) { $ehArquivo = $false } } catch { }
                }
                if (-not $ehArquivo) {
                    Bloquear "o formatador so pode receber arquivos, um a um. '$t' nao e um arquivo. Formate so os arquivos que voce alterou."
                }
                $arquivos++
            }
            if ($arquivos -eq 0) {
                Bloquear "formatador sem arquivo formata a pasta inteira. Passe so os arquivos que voce alterou."
            }
        }
    }
}

try {
    try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
    $bruto = [Console]::In.ReadToEnd()
    $entrada = $bruto | ConvertFrom-Json

    $ferramenta = [string]$entrada.tool_name
    if ($ferramenta -ne 'Bash' -and $ferramenta -ne 'PowerShell') { exit 0 }

    $comando = ([string]$entrada.tool_input.command).Trim()
    if (-not $comando) { Bloquear 'comando vazio.' }

    if ($Perfil -eq 'implementador') {
        Testar-Formatadores $comando ([string]$entrada.cwd)
        exit 0
    }

    if ($comando -match '[\r\n]') { Bloquear 'um comando por vez, em uma linha so.' }
    if ($comando -match '\.env') { Bloquear 'comando que cita .env nao e permitido.' }
    $comando = $comando -replace '\s+', ' '

    switch ($Perfil) {
        'explore' {
            if ($comando -match $operadores) {
                Bloquear 'sem pipe, redirecionamento, encadeamento, variavel ou parenteses.'
            }
            if ($comando -notmatch '^git (log|blame|show|diff|status|ls-files)( |$)') {
                Bloquear 'o Explore so pode rodar git log, blame, show, diff, status e ls-files.'
            }
            if ($comando -match '(^| )--(output|ext-diff|no-index)') {
                Bloquear 'as opcoes --output, --ext-diff e --no-index nao sao permitidas.'
            }
            exit 0
        }
        'verificador' {
            $pasta = $env:CLAUDE_PROJECT_DIR
            if (-not $pasta) { $pasta = [string]$entrada.cwd }
            $arquivoLista = Join-Path (Join-Path $pasta '.claude') 'verificador-comandos.txt'
            if (-not (Test-Path -LiteralPath $arquivoLista)) {
                Bloquear "nao existe $arquivoLista. Reporte ao mestre: a lista de comandos do projeto precisa ser criada."
            }
            $permitidos = @(
                Get-Content -LiteralPath $arquivoLista -Encoding UTF8 |
                    ForEach-Object { ($_ -replace '\s+', ' ').Trim() } |
                    Where-Object { $_ -and -not $_.StartsWith('#') }
            )
            foreach ($linha in $permitidos) {
                if ($comando -ieq $linha) { exit 0 }
                $prefixo = "$linha "
                if ($comando.StartsWith($prefixo, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $resto = $comando.Substring($prefixo.Length)
                    if ($resto -notmatch $operadores) { exit 0 }
                }
            }
            Bloquear ("comando fora da lista do projeto. Permitidos: " + ($permitidos -join ' | ') + ". Reporte como bloqueio; nao tente variacoes.")
        }
        default {
            Bloquear 'perfil desconhecido. Use explore, verificador ou implementador.'
        }
    }
} catch {
    Bloquear ("erro na guarda: " + $_.Exception.Message)
}
