<#
.SYNOPSIS
  Guarda de terminal dos subagentes Explore e verificador (hook PreToolUse).

.DESCRIPTION
  O Claude Code chama este script antes de cada comando de terminal do subagente
  e entrega o JSON da chamada pela entrada padrao.

  Saida 0: o comando segue o fluxo normal de permissoes.
  Saida 2: o comando e bloqueado e a mensagem vai para o subagente.

  Qualquer erro inesperado tambem sai com 2. Com saida 1 o Claude Code
  deixaria o comando passar.

  Perfis:
    explore      so historico e estado do git: log, blame, show, diff, status, ls-files.
    verificador  so os comandos listados em .claude/verificador-comandos.txt do projeto.
                 Cada linha libera o comando exato e o mesmo comando com argumentos a mais.

.PARAMETER Perfil
  explore ou verificador.
#>
param([string]$Perfil = '')

function Bloquear([string]$motivo) {
    [Console]::Error.WriteLine("Bloqueado pela guarda ($Perfil): $motivo")
    exit 2
}

# Encadeamento, redirecionamento, subcomando e variavel: nada disso e permitido
# fora do texto que uma linha da lista ja traz.
$operadores = '[;&|<>`$(){}]'

try {
    try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
    $bruto = [Console]::In.ReadToEnd()
    $entrada = $bruto | ConvertFrom-Json

    $ferramenta = [string]$entrada.tool_name
    if ($ferramenta -ne 'Bash' -and $ferramenta -ne 'PowerShell') { exit 0 }

    $comando = ([string]$entrada.tool_input.command).Trim()
    if (-not $comando) { Bloquear 'comando vazio.' }
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
            Bloquear 'perfil desconhecido. Use explore ou verificador.'
        }
    }
} catch {
    Bloquear ("erro na guarda: " + $_.Exception.Message)
}
