<#
.SYNOPSIS
  Roda os casos de testes/casos-guarda.txt contra hooks/guarda-comandos.ps1.

.DESCRIPTION
  Chama a guarda do mesmo jeito que o hook dos agentes: com o PowerShell que esta
  rodando este script e por dentro do try/catch que bloqueia se a guarda nao rodar.
  Rode com os dois PowerShell para cobrir o Windows:
    powershell -ExecutionPolicy Bypass -File .\testes\testar-guarda.ps1
    pwsh -File ./testes/testar-guarda.ps1
  Sai com 0 se todos os casos passarem e com 1 se algum falhar.
#>
# Continue: no Windows PowerShell 5.1, saida de erro de programa externo com Stop vira excecao.
$ErrorActionPreference = 'Continue'
$raiz   = Split-Path -Parent $PSScriptRoot
$guarda = Join-Path (Join-Path $raiz 'hooks') 'guarda-comandos.ps1'
$casos  = Join-Path $PSScriptRoot 'casos-guarda.txt'
$exe    = (Get-Process -Id $PID).Path
$utf8   = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = $utf8

# Projeto de teste: git com a lista do verificador em commit.
$proj = Join-Path ([System.IO.Path]::GetTempPath()) ("guarda-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path (Join-Path $proj '.claude'), (Join-Path $proj 'lib\src'), (Join-Path $proj 'app') | Out-Null
'' | Set-Content -LiteralPath (Join-Path $proj 'lib\a.dart')
'' | Set-Content -LiteralPath (Join-Path $proj 'lib\b.dart')
$lista = Join-Path $proj '.claude\verificador-comandos.txt'
[System.IO.File]::WriteAllText($lista, "# comandos do verificador`n`nflutter test`nflutter analyze`ncd app && flutter test`ncd app; flutter test`n", $utf8)
& git -C $proj init -q 2>$null
& git -C $proj -c user.email=t@t -c user.name=t add .claude/verificador-comandos.txt 2>$null
& git -C $proj -c user.email=t@t -c user.name=t commit -q -m lista 2>$null

function Rodar([string]$perfil, [string]$json, [string]$script = $guarda) {
    $cmd = "try { & '$script' -Perfil $perfil; exit `$LASTEXITCODE } catch { exit 2 }"
    $env:CLAUDE_PROJECT_DIR = $proj
    $saida = $json | & $exe -NoProfile -ExecutionPolicy Bypass -Command $cmd 2>&1
    $codigo = $LASTEXITCODE
    $script:mensagem = (($saida | ForEach-Object { "$_" }) -join ' ').Trim()
    return $codigo
}

function Json([string]$ferramenta, [string]$comando) {
    return (@{ tool_name = $ferramenta; tool_input = @{ command = $comando }; cwd = $proj } | ConvertTo-Json -Compress)
}

$falhas = 0
$total  = 0
# No GitHub Actions, cada falha vira uma anotacao visivel na pagina da execucao.
function Avisar([string]$texto) {
    if ($env:GITHUB_ACTIONS) { Write-Host "::error::PowerShell $($PSVersionTable.PSVersion) - $texto" } else { Write-Host $texto }
}
function Conferir([string]$nome, [int]$esperado, [int]$obtido) {
    $script:total++
    if ($esperado -ne $obtido) {
        $script:falhas++
        Avisar "FALHOU (esperado $esperado, veio $obtido): $nome :: $script:mensagem"
    }
}

foreach ($linha in [System.IO.File]::ReadAllLines($casos, $utf8)) {
    if (-not $linha.Trim() -or $linha.StartsWith('#')) { continue }
    $p = $linha -split "`t", 4
    $comando = $p[3].Replace('\n', "`n")
    $inicio = Get-Date
    $saida = Rodar $p[0] (Json $p[2] $comando)
    $segundos = ((Get-Date) - $inicio).TotalSeconds
    Conferir "[$($p[0])] $($p[3])" ([int]$p[1]) $saida
    if ($segundos -gt 10) { $script:falhas++; Avisar "LENTO ($([int]$segundos) s): $($p[3])" }
}

# Cenarios que nao cabem na tabela.
Conferir 'entrada vazia' 2 (Rodar 'explore' '')
Conferir 'entrada que nao e JSON' 2 (Rodar 'explore' 'nao e json')
Conferir 'script da guarda ausente' 2 (Rodar 'explore' (Json 'Bash' 'git log') (Join-Path $proj 'nao-existe.ps1'))

[System.IO.File]::AppendAllText($lista, "rm -rf`n", $utf8)
Conferir 'lista do verificador alterada fora de commit' 2 (Rodar 'verificador' (Json 'Bash' 'flutter test'))
& git -C $proj checkout -q -- .claude/verificador-comandos.txt 2>$null

Remove-Item -LiteralPath $lista
Conferir 'lista do verificador ausente' 2 (Rodar 'verificador' (Json 'Bash' 'flutter test'))

Remove-Item -LiteralPath $proj -Recurse -Force
Write-Host "PowerShell $($PSVersionTable.PSVersion): $($total - $falhas) de $total casos certos."
if ($falhas -gt 0) { exit 1 }
exit 0
