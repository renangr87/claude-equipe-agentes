# Python falso usado por testar-instalador.ps1 para o -ApoioLocal.
# PYTHON_FALSO_EXE: caminho que ele diz ser o seu (sys.executable).
# PYTHON_FALSO_MCP: "sim" se "import mcp" funciona; qualquer outra coisa, falha.
$texto = ($args -join ' ')
if ($texto -match 'sys\.executable') { [Console]::Out.WriteLine($env:PYTHON_FALSO_EXE); exit 0 }
if ($texto -match 'import mcp') {
    if ($env:PYTHON_FALSO_MCP -eq 'sim') { exit 0 }
    [Console]::Error.WriteLine("ModuleNotFoundError: No module named 'mcp'")
    exit 1
}
exit 0
