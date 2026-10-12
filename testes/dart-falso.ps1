# Dart falso usado por testar-instalador.ps1. Responde a "--version" e imita o
# "dart mcp-server" pelo protocolo MCP (uma mensagem JSON por linha).
# DART_FALSO_VERSAO: versao mostrada.
# DART_FALSO_MODO:
#   ok      publica exatamente as ferramentas passadas com --enable
#   antigo  recusa a opcao --disable, como o Dart 3.11
#   extra   publica tambem uma ferramenta que nao foi habilitada
$argumentos = @($args)
if ($argumentos -contains '--version') {
    [Console]::Out.WriteLine("Dart SDK version: $($env:DART_FALSO_VERSAO) (stable)")
    exit 0
}
if ($env:DART_FALSO_MODO -eq 'antigo') {
    [Console]::Error.WriteLine('Could not find an option named "--disable".')
    exit 64
}
$nomes = @()
for ($i = 0; $i -lt $argumentos.Count - 1; $i++) { if ($argumentos[$i] -eq '--enable') { $nomes += $argumentos[$i + 1] } }
if ($env:DART_FALSO_MODO -eq 'extra') { $nomes += 'ferramenta_nova' }
while ($true) {
    $linha = [Console]::In.ReadLine()
    if ($null -eq $linha) { break }
    $msg = $linha | ConvertFrom-Json
    if (-not $msg.PSObject.Properties['id']) { continue }
    if ($msg.method -eq 'initialize') {
        $r = @{ jsonrpc = '2.0'; id = $msg.id; result = @{ protocolVersion = '2025-06-18'; capabilities = @{ tools = @{} }; serverInfo = @{ name = 'falso'; version = '1' } } }
    } elseif ($msg.method -eq 'tools/list') {
        $r = @{ jsonrpc = '2.0'; id = $msg.id; result = @{ tools = @($nomes | ForEach-Object { @{ name = $_ } }) } }
    } else { continue }
    [Console]::Out.WriteLine(($r | ConvertTo-Json -Compress -Depth 10))
    [Console]::Out.Flush()
}
exit 0
