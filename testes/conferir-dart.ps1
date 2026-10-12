<#
.SYNOPSIS
  Confere se as ferramentas do servidor MCP do Dart usadas pela equipe existem com
  esses nomes e se so elas ficam ligadas.

.DESCRIPTION
  Parte fixa (sempre roda): compara testes/dart-ferramentas.txt com
    - os argumentos de projeto/mcp.dart.json: "--disable all" e um --enable para cada
      ferramenta leitura, livre ou confirmar, e nenhum para as desligadas;
    - as ferramentas mcp__dart__* do Explore e do revisor (so classe "leitura");
    - as regras de confirmacao mcp__dart__* de settings/global.json (toda "confirmar"
      tem regra, e so ha regra para "confirmar" ou "desligada").

  Parte ao vivo (so se o dart estiver no PATH): sobe o servidor com os argumentos de
  projeto/mcp.dart.json, pede a lista de ferramentas pelo protocolo MCP e confere que
  ela e exatamente a lista habilitada. Se um nome nao existir na versao instalada, o
  servidor recusa o argumento e nao sobe, e o teste falha. Depois sobe com
  "--enable all" so para avisar (sem falhar) de ferramentas novas que ainda nao
  estao classificadas.

  Serve tambem para conferir a sua maquina: rode depois de atualizar o Flutter.
  Sai com 0 se tudo bater e com 1 se algo falhar.
#>
$ErrorActionPreference = 'Continue'
$raiz = Split-Path -Parent $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding($false)
. (Join-Path (Join-Path $raiz 'ferramentas') 'servidor-dart.ps1')

$falhas = 0
$total  = 0
function Conferir([string]$nome, [bool]$ok) {
    $script:total++
    if (-not $ok) {
        $script:falhas++
        if ($env:GITHUB_ACTIONS) { Write-Host "::error::Dart MCP - FALHOU: $nome" } else { Write-Host "FALHOU: $nome" }
    }
}
function Avisar([string]$texto) {
    if ($env:GITHUB_ACTIONS) { Write-Host "::warning::Dart MCP - $texto" } else { Write-Host "AVISO: $texto" }
}

# Classificacao
$classe = @{}
foreach ($linha in [System.IO.File]::ReadAllLines((Join-Path $PSScriptRoot 'dart-ferramentas.txt'), $utf8)) {
    if (-not $linha.Trim() -or $linha.StartsWith('#')) { continue }
    $p = $linha -split "`t"
    $classe[$p[0].Trim()] = $p[1].Trim()
}
function NomesDaClasse([string[]]$classes) { return @($classe.Keys | Where-Object { $classes -contains $classe[$_] } | Sort-Object) }
$esperadas = NomesDaClasse @('leitura', 'livre', 'confirmar')

# Parte fixa
$argsServidor = Get-ArgsServidorDart $raiz
$habilitadas = Get-NomesHabilitados $argsServidor
Conferir 'mcp.dart.json comeca com mcp-server --disable all' (($argsServidor[0..2] -join ' ') -eq 'mcp-server --disable all')
$desligadosNoModelo = @(for ($i = 0; $i -lt $argsServidor.Count - 1; $i++) { if ($argsServidor[$i] -eq '--disable') { $argsServidor[$i + 1] } })
Conferir 'mcp.dart.json so tem o --disable all' (($desligadosNoModelo -join ',') -eq 'all')
foreach ($n in $esperadas) { Conferir "'$n' ($($classe[$n])) tem --enable em mcp.dart.json" ($habilitadas -contains $n) }
foreach ($n in $habilitadas) { Conferir "--enable '$n' esta classificada como leitura, livre ou confirmar" ($esperadas -contains $n) }

$ask = @((Get-Content -Raw -LiteralPath (Join-Path $raiz 'settings\global.json') | ConvertFrom-Json).permissions.ask |
    Where-Object { $_ -like 'mcp__dart__*' } | ForEach-Object { $_.Substring(11) })
foreach ($n in $ask) { Conferir "regra de confirmacao '$n' esta classificada como confirmar ou desligada" ($classe[$n] -eq 'confirmar' -or $classe[$n] -eq 'desligada') }
foreach ($n in (NomesDaClasse @('confirmar'))) { Conferir "'$n' (confirmar) tem regra em global.json" ($ask -contains $n) }

foreach ($agente in 'Explore', 'revisor') {
    $texto = [System.IO.File]::ReadAllText((Join-Path $raiz "agents\$agente.md"), $utf8)
    $linhaTools = ($texto -split "`n" | Where-Object { $_ -match '^tools:' } | Select-Object -First 1)
    $nomes = @([regex]::Matches($linhaTools, 'mcp__dart__([a-z_]+)') | ForEach-Object { $_.Groups[1].Value })
    Conferir "$agente tem ferramentas do Dart" ($nomes.Count -gt 0)
    foreach ($n in $nomes) { Conferir "$agente so recebe leitura: '$n'" ($classe[$n] -eq 'leitura') }
}

# Parte ao vivo
$dartExe = Find-DartExe
if ($dartExe) {
    $versao = (& $dartExe --version 2>&1 | Out-String).Trim()
    if ($env:GITHUB_ACTIONS) { Write-Host "::notice::Dart MCP - $versao" } else { Write-Host $versao }

    $r = Get-FerramentasDart $dartExe $argsServidor
    Conferir 'servidor subiu com os argumentos de mcp.dart.json e listou as ferramentas' ($null -ne $r.Ferramentas)
    if ($null -eq $r.Ferramentas) {
        Write-Host "  saida de erro do servidor: $($r.Erro)"
    } else {
        Write-Host "  ferramentas publicadas: $($r.Ferramentas -join ', ')"
        foreach ($n in $r.Ferramentas) { Conferir "ferramenta publicada '$n' foi habilitada por nome" ($habilitadas -contains $n) }
        foreach ($n in $habilitadas) { Conferir "'$n' existe no servidor" ($r.Ferramentas -contains $n) }
    }

    $todas = Get-FerramentasDart $dartExe @('mcp-server', '--enable', 'all')
    if ($null -ne $todas.Ferramentas) {
        $novas = @($todas.Ferramentas | Where-Object { -not $classe.ContainsKey($_) })
        if ($novas.Count -gt 0) { Avisar "ferramentas sem classificacao (ficam desligadas): $($novas -join ', ')" }
    }
} else {
    Write-Host "Sem dart no PATH: so a parte fixa foi conferida."
}

Write-Host "Dart MCP: $($total - $falhas) de $total verificacoes certas."
if ($falhas -gt 0) { exit 1 }
exit 0
