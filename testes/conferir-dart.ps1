<#
.SYNOPSIS
  Confere se os nomes das ferramentas do servidor MCP do Dart usados pela equipe
  existem de verdade, e se toda ferramenta que o servidor publica foi classificada.

.DESCRIPTION
  Parte fixa (sempre roda): compara testes/dart-ferramentas.txt com
    - as ferramentas mcp__dart__* do Explore e do revisor (so classe "leitura");
    - as regras de confirmacao mcp__dart__* de settings/global.json (toda "confirmar"
      esta la, e so ha "confirmar" ou "desligada");
    - os --disable de projeto/mcp.dart.json (toda "desligada" esta la).

  Parte ao vivo (so se o dart estiver no PATH): sobe o servidor com os mesmos
  argumentos do projeto/mcp.dart.json, pede a lista de ferramentas pelo protocolo MCP
  e confere que:
    - toda ferramenta publicada esta classificada no arquivo;
    - nenhuma "desligada" aparece;
    - as de "leitura" aparecem.
  Depois sobe de novo com --enable para cada "confirmar" que nao veio por padrao: se
  um nome nao existir mais, o servidor recusa o argumento e o teste falha.

  Sai com 0 se tudo bater e com 1 se algo falhar.
#>
$ErrorActionPreference = 'Continue'
$raiz = Split-Path -Parent $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding($false)

$falhas = 0
$total  = 0
function Conferir([string]$nome, [bool]$ok) {
    $script:total++
    if (-not $ok) {
        $script:falhas++
        if ($env:GITHUB_ACTIONS) { Write-Host "::error::Dart MCP - FALHOU: $nome" } else { Write-Host "FALHOU: $nome" }
    }
}

# Classificacao
$classe = @{}
foreach ($linha in [System.IO.File]::ReadAllLines((Join-Path $PSScriptRoot 'dart-ferramentas.txt'), $utf8)) {
    if (-not $linha.Trim() -or $linha.StartsWith('#')) { continue }
    $p = $linha -split "`t"
    $classe[$p[0].Trim()] = $p[1].Trim()
}
function NomesDaClasse([string]$c) { return @($classe.Keys | Where-Object { $classe[$_] -eq $c } | Sort-Object) }

# Parte fixa
$ask = @((Get-Content -Raw -LiteralPath (Join-Path $raiz 'settings\global.json') | ConvertFrom-Json).permissions.ask |
    Where-Object { $_ -like 'mcp__dart__*' } | ForEach-Object { $_.Substring(11) })
foreach ($n in $ask) { Conferir "regra de confirmacao '$n' esta classificada como confirmar ou desligada" ($classe[$n] -eq 'confirmar' -or $classe[$n] -eq 'desligada') }
foreach ($n in (NomesDaClasse 'confirmar')) { Conferir "'$n' (confirmar) tem regra em global.json" ($ask -contains $n) }

foreach ($agente in 'Explore', 'revisor') {
    $texto = [System.IO.File]::ReadAllText((Join-Path $raiz "agents\$agente.md"), $utf8)
    $linhaTools = ($texto -split "`n" | Where-Object { $_ -match '^tools:' } | Select-Object -First 1)
    $nomes = @([regex]::Matches($linhaTools, 'mcp__dart__([a-z_]+)') | ForEach-Object { $_.Groups[1].Value })
    Conferir "$agente tem ferramentas do Dart" ($nomes.Count -gt 0)
    foreach ($n in $nomes) { Conferir "$agente so recebe leitura: '$n'" ($classe[$n] -eq 'leitura') }
}

$modelo = (Get-Content -Raw -LiteralPath (Join-Path $raiz 'projeto\mcp.dart.json') | ConvertFrom-Json).mcpServers.dart
$argsServidor = @($modelo.args)
$desligadasNoModelo = @()
for ($i = 0; $i -lt $argsServidor.Count - 1; $i++) {
    if ($argsServidor[$i] -eq '--disable') { $desligadasNoModelo += $argsServidor[$i + 1] }
}
foreach ($n in (NomesDaClasse 'desligada')) { Conferir "'$n' (desligada) tem --disable em mcp.dart.json" ($desligadasNoModelo -contains $n) }
foreach ($n in $desligadasNoModelo) { Conferir "--disable '$n' esta classificada como desligada" ($classe[$n] -eq 'desligada') }

# Parte ao vivo
function Listar-Ferramentas([string[]]$argumentos) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $script:dartExe
    $info.Arguments = ($argumentos | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = $utf8
    $p = [System.Diagnostics.Process]::Start($info)
    $erro = $p.StandardError.ReadToEndAsync()
    $p.StandardInput.AutoFlush = $true
    $enviar = { param($obj) $p.StandardInput.Write(($obj | ConvertTo-Json -Compress -Depth 10) + "`n") }
    & $enviar @{ jsonrpc = '2.0'; id = 1; method = 'initialize'; params = @{ protocolVersion = '2025-06-18'; capabilities = @{}; clientInfo = @{ name = 'teste-equipe'; version = '1' } } }
    $ferramentas = $null
    $limite = (Get-Date).AddSeconds(90)
    $pediuLista = $false
    while ((Get-Date) -lt $limite -and $null -eq $ferramentas) {
        $tarefa = $p.StandardOutput.ReadLineAsync()
        if (-not $tarefa.Wait(30000)) { break }
        $linha = $tarefa.Result
        if ($null -eq $linha) { break }
        try { $msg = $linha | ConvertFrom-Json } catch { continue }
        if ($msg.PSObject.Properties['method'] -and $msg.PSObject.Properties['id']) {
            # Pedido do servidor (por exemplo roots/list): responde vazio.
            & $enviar @{ jsonrpc = '2.0'; id = $msg.id; result = @{ roots = @() } }
            continue
        }
        if ($msg.PSObject.Properties['id'] -and $msg.id -eq 1 -and -not $pediuLista) {
            & $enviar @{ jsonrpc = '2.0'; method = 'notifications/initialized' }
            & $enviar @{ jsonrpc = '2.0'; id = 2; method = 'tools/list'; params = @{} }
            $pediuLista = $true
            continue
        }
        if ($msg.PSObject.Properties['id'] -and $msg.id -eq 2) {
            $ferramentas = @($msg.result.tools | ForEach-Object { $_.name })
        }
    }
    try { $p.StandardInput.Close() } catch { }
    if (-not $p.WaitForExit(10000)) { try { $p.Kill() } catch { } }
    if ($null -eq $ferramentas) {
        Write-Host "  servidor nao devolveu a lista. Saida de erro: $($erro.Result)"
        return $null
    }
    return ,$ferramentas
}

$dart = Get-Command 'dart' -ErrorAction SilentlyContinue
if ($dart) {
    $script:dartExe = $dart.Source
    if ($script:dartExe -match '\.bat$') {
        $embutido = Join-Path (Split-Path -Parent $script:dartExe) 'cache\dart-sdk\bin\dart.exe'
        if (Test-Path -LiteralPath $embutido) { $script:dartExe = $embutido }
    }
    Write-Host "Dart: $((& $script:dartExe --version 2>&1 | Out-String).Trim())"

    $publicadas = Listar-Ferramentas $argsServidor
    Conferir 'servidor subiu com os argumentos de mcp.dart.json e listou as ferramentas' ($null -ne $publicadas)
    if ($null -ne $publicadas) {
        Write-Host "  ferramentas publicadas: $($publicadas -join ', ')"
        foreach ($n in $publicadas) { Conferir "ferramenta publicada '$n' esta classificada" ($classe.ContainsKey($n)) }
        foreach ($n in (NomesDaClasse 'desligada')) { Conferir "'$n' esta desligada no servidor" (-not ($publicadas -contains $n)) }
        foreach ($n in (NomesDaClasse 'leitura')) { Conferir "'$n' (leitura) existe no servidor" ($publicadas -contains $n) }

        $faltam = @((NomesDaClasse 'confirmar') + (NomesDaClasse 'livre') | Where-Object { -not ($publicadas -contains $_) })
        if ($faltam.Count -gt 0) {
            $argsHabilitar = @('mcp-server')
            foreach ($n in $faltam) { $argsHabilitar += @('--enable', $n) }
            $comTodas = Listar-Ferramentas $argsHabilitar
            Conferir "servidor aceitou --enable para: $($faltam -join ', ')" ($null -ne $comTodas)
            if ($null -ne $comTodas) {
                foreach ($n in $faltam) { Conferir "'$n' existe no servidor quando habilitada" ($comTodas -contains $n) }
            }
        }
    }
} else {
    Write-Host "Sem dart no PATH: so a parte fixa foi conferida."
}

Write-Host "Dart MCP: $($total - $falhas) de $total verificacoes certas."
if ($falhas -gt 0) { exit 1 }
exit 0
