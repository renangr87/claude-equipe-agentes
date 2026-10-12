<#
  Funcoes usadas pelo instalador (-ComDart) e por testes/conferir-dart.ps1 para
  perguntar ao servidor MCP do Dart quais ferramentas ele publica.

  Carregue com:  . (Join-Path <pasta do repositorio> 'ferramentas\servidor-dart.ps1')
#>

# Caminho do executavel do Dart. No Flutter, bin\dart.bat e um atalho; o executavel
# de verdade fica no SDK embutido. Devolve $null se o dart nao estiver no PATH.
function Find-DartExe {
    $dart = Get-Command 'dart' -ErrorAction SilentlyContinue
    if (-not $dart) { return $null }
    $exe = $dart.Source
    if ($exe -match '\.bat$') {
        $embutido = Join-Path (Split-Path -Parent $exe) 'cache\dart-sdk\bin\dart.exe'
        if (Test-Path -LiteralPath $embutido) { $exe = $embutido }
    }
    return $exe
}

# Argumentos do servidor 'dart' em projeto\mcp.dart.json.
function Get-ArgsServidorDart([string]$raiz) {
    $texto = [System.IO.File]::ReadAllText((Join-Path (Join-Path $raiz 'projeto') 'mcp.dart.json'))
    return @(($texto | ConvertFrom-Json).mcpServers.dart.args)
}

# Nomes passados com --enable.
function Get-NomesHabilitados([string[]]$argumentos) {
    $nomes = @()
    for ($i = 0; $i -lt $argumentos.Count - 1; $i++) {
        if ($argumentos[$i] -eq '--enable') { $nomes += $argumentos[$i + 1] }
    }
    return ,$nomes
}

# Sobe o servidor com os argumentos dados, pede tools/list pelo protocolo MCP (stdio,
# JSON-RPC uma mensagem por linha) e encerra. Devolve um objeto com:
#   Ferramentas: nomes publicados, ou $null se o servidor nao respondeu
#   Erro:        saida de erro do servidor, quando ele nao respondeu
function Get-FerramentasDart([string]$dartExe, [string[]]$argumentos, [int]$segundos = 120) {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $dartExe
    $info.Arguments = ($argumentos | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = $utf8
    try {
        $p = [System.Diagnostics.Process]::Start($info)
    } catch {
        return [pscustomobject]@{ Ferramentas = $null; Erro = $_.Exception.Message }
    }
    $erro = $p.StandardError.ReadToEndAsync()
    $p.StandardInput.AutoFlush = $true
    $enviar = { param($obj) try { $p.StandardInput.Write(($obj | ConvertTo-Json -Compress -Depth 10) + "`n") } catch { } }
    & $enviar @{ jsonrpc = '2.0'; id = 1; method = 'initialize'; params = @{ protocolVersion = '2025-06-18'; capabilities = @{}; clientInfo = @{ name = 'equipe-agentes'; version = '1' } } }
    $ferramentas = $null
    $limite = (Get-Date).AddSeconds($segundos)
    $pediuLista = $false
    while ((Get-Date) -lt $limite -and $null -eq $ferramentas) {
        $tarefa = $p.StandardOutput.ReadLineAsync()
        $restante = [int][Math]::Max(1000, ($limite - (Get-Date)).TotalMilliseconds)
        if (-not $tarefa.Wait($restante)) { break }
        $linha = $tarefa.Result
        if ($null -eq $linha) { break }
        try { $msg = $linha | ConvertFrom-Json } catch { continue }
        if ($null -eq $msg) { continue }
        $temId = [bool]$msg.PSObject.Properties['id']
        if ($msg.PSObject.Properties['method'] -and $temId) {
            # Pedido do servidor (por exemplo roots/list): responde vazio.
            & $enviar @{ jsonrpc = '2.0'; id = $msg.id; result = @{ roots = @() } }
            continue
        }
        if ($temId -and $msg.id -eq 1 -and -not $pediuLista) {
            & $enviar @{ jsonrpc = '2.0'; method = 'notifications/initialized' }
            & $enviar @{ jsonrpc = '2.0'; id = 2; method = 'tools/list'; params = @{} }
            $pediuLista = $true
            continue
        }
        if ($temId -and $msg.id -eq 2) {
            $ferramentas = @($msg.result.tools | ForEach-Object { $_.name })
        }
    }
    try { $p.StandardInput.Close() } catch { }
    if (-not $p.WaitForExit(10000)) { try { $p.Kill() } catch { } }
    $textoErro = ''
    if ($erro.Wait(5000)) { $textoErro = $erro.Result }
    return [pscustomobject]@{ Ferramentas = $ferramentas; Erro = $textoErro.Trim() }
}
