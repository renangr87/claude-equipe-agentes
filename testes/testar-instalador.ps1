<#
.SYNOPSIS
  Testa o instalar.ps1 em pastas temporarias, sem tocar na sua configuracao.

.DESCRIPTION
  Cenarios: instalacao limpa, repeticao, mescla com settings.json existente,
  JSON invalido, -SemBloqueios e caminho com espaco e aspa simples.
  Rode com os dois PowerShell para cobrir o Windows:
    powershell -ExecutionPolicy Bypass -File .\testes\testar-instalador.ps1
    pwsh -File ./testes/testar-instalador.ps1
  Sai com 0 se tudo passar e com 1 se algo falhar.
#>
# Continue: no Windows PowerShell 5.1, saida de erro de programa externo com Stop vira excecao.
$ErrorActionPreference = 'Continue'
$raiz       = Split-Path -Parent $PSScriptRoot
$instalador = Join-Path $raiz 'instalar.ps1'
$exe        = (Get-Process -Id $PID).Path
$utf8       = New-Object System.Text.UTF8Encoding($false)
$base       = Join-Path ([System.IO.Path]::GetTempPath()) ("instalador-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $base | Out-Null

$falhas = 0
$total  = 0
function Conferir([string]$nome, [bool]$ok) {
    $script:total++
    if (-not $ok) {
        $script:falhas++
        if ($env:GITHUB_ACTIONS) { Write-Host "::error::PowerShell $($PSVersionTable.PSVersion) - FALHOU: $nome" } else { Write-Host "FALHOU: $nome" }
    }
}

function Instalar([string]$destino, [string[]]$extra = @()) {
    $saida = & $exe -NoProfile -ExecutionPolicy Bypass -File $instalador -Destino $destino @extra 2>&1
    return @{ codigo = $LASTEXITCODE; texto = ($saida | Out-String) }
}

function Ler-Json([string]$caminho) {
    return ([System.IO.File]::ReadAllText($caminho, $utf8) | ConvertFrom-Json)
}

$global = Ler-Json (Join-Path (Join-Path $raiz 'settings') 'global.json')
$nDeny  = @($global.permissions.deny).Count
$nAsk   = @($global.permissions.ask).Count

# 1. Instalacao limpa
$d1 = Join-Path $base 'limpa'
$r = Instalar $d1
Conferir 'limpa: saiu com 0' ($r.codigo -eq 0)
foreach ($a in 'Explore', 'implementador', 'revisor', 'verificador') {
    $texto = [System.IO.File]::ReadAllText((Join-Path $d1 "agents\$a.md"), $utf8)
    Conferir "limpa: $a.md sem marcador" (-not $texto.Contains('__PASTA_CLAUDE__'))
}
Conferir 'limpa: guarda copiada' (Test-Path (Join-Path $d1 'hooks\guarda-comandos.ps1'))
Conferir 'limpa: regra copiada' (Test-Path (Join-Path $d1 'rules\equipe-agentes.md'))
$s = Ler-Json (Join-Path $d1 'settings.json')
Conferir 'limpa: todas as regras deny' (@($s.permissions.deny).Count -eq $nDeny)
Conferir 'limpa: todas as regras ask' (@($s.permissions.ask).Count -eq $nAsk)

# 2. Repeticao: nada muda, nenhum backup novo
$r = Instalar $d1
Conferir 'repeticao: saiu com 0' ($r.codigo -eq 0)
Conferir 'repeticao: sem backup' (@(Get-ChildItem -LiteralPath $d1 -Recurse -Filter '*.bak-*').Count -eq 0)

# 3. Mescla com settings.json existente
$d3 = Join-Path $base 'mescla'
New-Item -ItemType Directory -Force -Path $d3 | Out-Null
[System.IO.File]::WriteAllText((Join-Path $d3 'settings.json'), '{"model":"opus","permissions":{"allow":["Bash(npm test)"],"deny":["Read(.env)"]},"hooks":{}}', $utf8)
$r = Instalar $d3
$s = Ler-Json (Join-Path $d3 'settings.json')
Conferir 'mescla: saiu com 0' ($r.codigo -eq 0)
Conferir 'mescla: manteve model' ($s.model -eq 'opus')
Conferir 'mescla: manteve allow' (@($s.permissions.allow) -contains 'Bash(npm test)')
Conferir 'mescla: manteve deny antigo' (@($s.permissions.deny) -contains 'Read(.env)')
Conferir 'mescla: acrescentou deny' (@($s.permissions.deny).Count -eq $nDeny + 1)
Conferir 'mescla: manteve hooks' ($null -ne $s.PSObject.Properties['hooks'])
Conferir 'mescla: fez backup' (@(Get-ChildItem -LiteralPath $d3 -Filter 'settings.json.bak-*').Count -eq 1)

# 4. JSON invalido: falha sem alterar o arquivo
$d4 = Join-Path $base 'invalido'
New-Item -ItemType Directory -Force -Path $d4 | Out-Null
[System.IO.File]::WriteAllText((Join-Path $d4 'settings.json'), '{ isto nao e json', $utf8)
$r = Instalar $d4
Conferir 'invalido: saiu com erro' ($r.codigo -ne 0)
Conferir 'invalido: arquivo intacto' ([System.IO.File]::ReadAllText((Join-Path $d4 'settings.json'), $utf8) -eq '{ isto nao e json')

# 5. -SemBloqueios: nao cria settings.json
$d5 = Join-Path $base 'sem-bloqueios'
$r = Instalar $d5 @('-SemBloqueios')
Conferir 'sem bloqueios: saiu com 0' ($r.codigo -eq 0)
Conferir 'sem bloqueios: sem settings.json' (-not (Test-Path (Join-Path $d5 'settings.json')))

# 6. Caminho com espaco e aspa simples: o hook continua valido
$d6 = Join-Path $base "pasta d'agua"
$r = Instalar $d6
Conferir 'aspa: saiu com 0' ($r.codigo -eq 0)
$texto = [System.IO.File]::ReadAllText((Join-Path $d6 'agents\Explore.md'), $utf8)
$linha = ($texto -split "`n" | Where-Object { $_ -match '"-Command"' })
$comando = ([regex]::Match($linha, '"-Command", "(.*)"\]')).Groups[1].Value
$json = '{"tool_name":"Bash","tool_input":{"command":"git log -1"},"cwd":"."}'
$null = $json | & $exe -NoProfile -ExecutionPolicy Bypass -Command $comando 2>&1
Conferir 'aspa: hook roda a guarda e libera git log' ($LASTEXITCODE -eq 0)
$json = '{"tool_name":"Bash","tool_input":{"command":"rm -rf ."},"cwd":"."}'
$null = $json | & $exe -NoProfile -ExecutionPolicy Bypass -Command $comando 2>&1
Conferir 'aspa: hook roda a guarda e bloqueia rm' ($LASTEXITCODE -eq 2)

Remove-Item -LiteralPath $base -Recurse -Force
Write-Host "PowerShell $($PSVersionTable.PSVersion): $($total - $falhas) de $total verificacoes certas."
if ($falhas -gt 0) { exit 1 }
exit 0
