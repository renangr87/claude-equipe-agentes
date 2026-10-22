# Python falso usado por testar-instalador.ps1 para o Apoio Local.
# PYTHON_FALSO_EXE: caminho que ele diz ser o seu (sys.executable).
# PYTHON_FALSO_MCP: "sim" se "import mcp" funciona; senao, so funciona depois de um
#                   "pip install" feito por este mesmo python (marca ao lado dele).
# PYTHON_FALSO_PIP: "falha" faz o "pip install" sair com erro.
# "-m venv <pasta>" cria <pasta>\Scripts\python.cmd (Windows) ou <pasta>/bin/python,
# outro python falso, sem o pacote mcp.
$texto = ($args -join ' ')
$marca = Join-Path (Split-Path -Parent $env:PYTHON_FALSO_EXE) 'mcp-instalado'
if ($texto -match 'sys\.executable') { [Console]::Out.WriteLine($env:PYTHON_FALSO_EXE); exit 0 }
if ($texto -match '-m venv') {
    $pasta = $args[-1]
    $pwshExe = (Get-Process -Id $PID).Path
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    if ($env:OS -eq 'Windows_NT') {
        $dir = Join-Path $pasta 'Scripts'
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $exePy = Join-Path $dir 'python.cmd'
        $conteudo = "@set PYTHON_FALSO_EXE=$exePy`r`n@set PYTHON_FALSO_MCP=nao`r`n@set PYTHON_FALSO_PIP=$env:PYTHON_FALSO_PIP`r`n@`"$pwshExe`" -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" %*`r`n"
    } else {
        $dir = Join-Path $pasta 'bin'
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $exePy = Join-Path $dir 'python'
        $conteudo = "#!/bin/sh`nPYTHON_FALSO_EXE='$exePy' PYTHON_FALSO_MCP='nao' PYTHON_FALSO_PIP='$env:PYTHON_FALSO_PIP' exec '$pwshExe' -NoProfile -File '$PSCommandPath' `"`$@`"`n"
    }
    [System.IO.File]::WriteAllText($exePy, $conteudo, $utf8)
    if ($env:OS -ne 'Windows_NT') { & chmod +x $exePy }
    exit 0
}
if ($texto -match '-m pip install') {
    if ($env:PYTHON_FALSO_PIP -eq 'falha') { [Console]::Error.WriteLine('ERROR: falha simulada do pip'); exit 1 }
    [System.IO.File]::WriteAllText($marca, 'sim')
    exit 0
}
if ($texto -match 'import mcp') {
    if ($env:PYTHON_FALSO_MCP -eq 'sim' -or (Test-Path -LiteralPath $marca)) { exit 0 }
    [Console]::Error.WriteLine("ModuleNotFoundError: No module named 'mcp'")
    exit 1
}
exit 0
