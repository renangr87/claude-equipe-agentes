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

# 3b. Regras antigas da equipe saem; regra parecida escrita pelo usuario fica
$d3b = Join-Path $base 'retiradas'
New-Item -ItemType Directory -Force -Path $d3b | Out-Null
[System.IO.File]::WriteAllText((Join-Path $d3b 'settings.json'), '{"permissions":{"ask":["Bash(git push *)","mcp__dart__hot_reload","Bash(git push origin main)"]}}', $utf8)
$r = Instalar $d3b
$s = Ler-Json (Join-Path $d3b 'settings.json')
Conferir 'retiradas: saiu com 0' ($r.codigo -eq 0)
Conferir 'retiradas: removeu git push *' (@($s.permissions.ask) -notcontains 'Bash(git push *)')
Conferir 'retiradas: removeu hot_reload' (@($s.permissions.ask) -notcontains 'mcp__dart__hot_reload')
Conferir 'retiradas: manteve regra do usuario' (@($s.permissions.ask) -contains 'Bash(git push origin main)')
Conferir 'retiradas: acrescentou allow da leitura do Supabase' (@($s.permissions.allow) -contains 'mcp__supabase-leitura')
$r = Instalar $d3b
Conferir 'retiradas: repeticao nao muda nada' ($r.texto -match 'bloqueios ja presentes')
$retiradas = Ler-Json (Join-Path (Join-Path $raiz 'settings') 'retiradas.json')
foreach ($regra in @($retiradas.ask)) { Conferir "retiradas: '$regra' nao esta em global.json" (@($global.permissions.ask) -cnotcontains $regra) }

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

# 7 a 11. -ComMapa: registra o codebase-memory no .claude.json (precisa do Node)
if (Get-Command node -ErrorAction SilentlyContinue) {
    # Executavel falso do mapa, para o instalador achar no PATH
    $falso = Join-Path $base 'bin-falso'
    New-Item -ItemType Directory -Force -Path $falso | Out-Null
    if ($env:OS -eq 'Windows_NT') {
        $exeMapa = Join-Path $falso 'codebase-memory-mcp.cmd'
        [System.IO.File]::WriteAllText($exeMapa, "@echo off`r`n", $utf8)
    } else {
        $exeMapa = Join-Path $falso 'codebase-memory-mcp'
        [System.IO.File]::WriteAllText($exeMapa, "#!/bin/sh`n", $utf8)
        & chmod +x $exeMapa
    }
    $pathOriginal = $env:PATH
    $pathComMapa = $falso + [System.IO.Path]::PathSeparator + $env:PATH

    # 7. Registro e repeticao, mantendo o resto do arquivo
    $d7 = Join-Path $base 'mapa'
    New-Item -ItemType Directory -Force -Path $d7 | Out-Null
    $usuario = Join-Path $d7 '.claude.json'
    [System.IO.File]::WriteAllText($usuario, '{"numStartups":5,"projects":{"C:/x":{"allowedTools":[]}},"mcpServers":{"outro":{"command":"x"}}}', $utf8)
    $env:PATH = $pathComMapa
    $r = Instalar $d7 @('-ComMapa')
    $u = Ler-Json $usuario
    Conferir 'mapa: saiu com 0' ($r.codigo -eq 0)
    Conferir 'mapa: registrou com o caminho completo' ($u.mcpServers.'codebase-memory'.command -eq $exeMapa)
    Conferir 'mapa: manteve o servidor que existia' ($u.mcpServers.outro.command -eq 'x')
    Conferir 'mapa: manteve o resto do arquivo' ($u.numStartups -eq 5 -and $null -ne $u.projects)
    $baks = @(Get-ChildItem -LiteralPath $d7 -Filter '.claude.json.bak-*' -Force)
    Conferir 'mapa: fez backup do original' ($baks.Count -eq 1 -and [System.IO.File]::ReadAllText($baks[0].FullName, $utf8).Contains('"outro"') -and -not [System.IO.File]::ReadAllText($baks[0].FullName, $utf8).Contains('codebase-memory'))
    $r = Instalar $d7 @('-ComMapa')
    Conferir 'mapa: repeticao sai com 0' ($r.codigo -eq 0)
    Conferir 'mapa: repeticao nao faz backup novo' (@(Get-ChildItem -LiteralPath $d7 -Filter '.claude.json.bak-*' -Force).Count -eq 1)

    # 8. .claude.json grande (o Windows PowerShell 5.1 nao le JSON acima de ~2 MB)
    $d8 = Join-Path $base 'mapa-grande'
    New-Item -ItemType Directory -Force -Path $d8 | Out-Null
    $usuario = Join-Path $d8 '.claude.json'
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('{"projects":{')
    for ($i = 0; $i -lt 20000; $i++) {
        if ($i -gt 0) { [void]$sb.Append(',') }
        [void]$sb.Append('"C:/projeto/' + $i + '":{"historico":"' + ('x' * 200) + '"}')
    }
    [void]$sb.Append('}}')
    [System.IO.File]::WriteAllText($usuario, $sb.ToString(), $utf8)
    $r = Instalar $d8 @('-ComMapa')
    $texto = [System.IO.File]::ReadAllText($usuario, $utf8)
    Conferir 'mapa grande: saiu com 0' ($r.codigo -eq 0)
    Conferir 'mapa grande: registrou' ($texto.Contains('"codebase-memory"'))
    Conferir 'mapa grande: manteve os projetos' ($texto.Contains('"C:/projeto/19999"'))

    # 9. .claude.json invalido: falha sem alterar
    $d9 = Join-Path $base 'mapa-invalido'
    New-Item -ItemType Directory -Force -Path $d9 | Out-Null
    $usuario = Join-Path $d9 '.claude.json'
    [System.IO.File]::WriteAllText($usuario, '{ quebrado', $utf8)
    $r = Instalar $d9 @('-ComMapa')
    Conferir 'mapa invalido: saiu com erro' ($r.codigo -ne 0)
    Conferir 'mapa invalido: arquivo intacto' ([System.IO.File]::ReadAllText($usuario, $utf8) -eq '{ quebrado')

    # 9b. Obrigatorio: sem opcao nenhuma, o mapa e registrado; com -SemMapa, nao
    $d9b = Join-Path $base 'mapa-padrao'
    New-Item -ItemType Directory -Force -Path $d9b | Out-Null
    $r = Instalar $d9b
    $json9b = Join-Path $d9b '.claude.json'
    Conferir 'mapa padrao: registrou sem -ComMapa' ((Test-Path $json9b) -and [System.IO.File]::ReadAllText($json9b, $utf8).Contains('"codebase-memory"'))
    $d9c = Join-Path $base 'mapa-recusado'
    New-Item -ItemType Directory -Force -Path $d9c | Out-Null
    $r = Instalar $d9c @('-SemMapa')
    Conferir 'mapa recusado: -SemMapa nao registra' (-not (Test-Path (Join-Path $d9c '.claude.json')))
    $env:PATH = $pathOriginal

    # 10. Sem o programa instalado: avisa e nao registra
    $d10 = Join-Path $base 'mapa-ausente'
    New-Item -ItemType Directory -Force -Path $d10 | Out-Null
    $r = Instalar $d10 @('-ComMapa')
    Conferir 'mapa ausente: saiu com 0' ($r.codigo -eq 0)
    Conferir 'mapa ausente: avisou' ($r.texto -match 'codebase-memory-mcp nao foi encontrado')
    Conferir 'mapa ausente: nao registrou' (-not (Test-Path (Join-Path $d10 '.claude.json')))
    # 11 a 15. -ComDart com um dart falso no PATH (testes/dart-falso.ps1)
    $falso = Join-Path $PSScriptRoot 'dart-falso.ps1'
    function Novo-DartFalso([string]$pasta, [string]$versao, [string]$modo) {
        New-Item -ItemType Directory -Force -Path $pasta | Out-Null
        if ($env:OS -eq 'Windows_NT') {
            $exeDart = Join-Path $pasta 'dart.cmd'
            $texto = "@set DART_FALSO_VERSAO=$versao`r`n@set DART_FALSO_MODO=$modo`r`n@`"$exe`" -NoProfile -ExecutionPolicy Bypass -File `"$falso`" %*`r`n"
        } else {
            $exeDart = Join-Path $pasta 'dart'
            $texto = "#!/bin/sh`nDART_FALSO_VERSAO='$versao' DART_FALSO_MODO='$modo' exec '$exe' -NoProfile -File '$falso' `"`$@`"`n"
        }
        [System.IO.File]::WriteAllText($exeDart, $texto, $utf8)
        if ($env:OS -ne 'Windows_NT') { & chmod +x $exeDart }
        return $exeDart
    }
    function Instalar-ComDart([string]$nome, [string]$versao, [string]$modo) {
        $dartFalso = Novo-DartFalso (Join-Path $base "dart-$nome") $versao $modo
        $destino = Join-Path $base "cfg-$nome"
        New-Item -ItemType Directory -Force -Path $destino | Out-Null
        $env:PATH = (Split-Path -Parent $dartFalso) + [System.IO.Path]::PathSeparator + $pathOriginal
        $r = Instalar $destino @('-ComDart')
        $env:PATH = $pathOriginal
        return @{ r = $r; destino = $destino; dart = $dartFalso; json = (Join-Path $destino '.claude.json') }
    }
    $argsModelo = @((Get-Content -Raw -LiteralPath (Join-Path $raiz 'projeto\mcp.dart.json') | ConvertFrom-Json).mcpServers.dart.args)

    # 11. Versao nova e servidor que publica so o habilitado: registra
    $c = Instalar-ComDart 'ok' '3.13.1' 'ok'
    Conferir 'dart: saiu com 0' ($c.r.codigo -eq 0)
    $u = $null
    if (Test-Path $c.json) { $u = Ler-Json $c.json }
    Conferir 'dart: registrou com o caminho completo' ($null -ne $u -and $u.mcpServers.dart.command -eq $c.dart)
    Conferir 'dart: argumentos iguais aos de projeto/mcp.dart.json' ($null -ne $u -and (@($u.mcpServers.dart.args) -join ' ') -eq ($argsModelo -join ' '))
    Conferir 'dart: so ferramentas habilitadas por nome (--disable all)' (($argsModelo[0..2] -join ' ') -eq 'mcp-server --disable all')
    if ($c.r.codigo -ne 0 -or $null -eq $u) { Write-Host $c.r.texto }

    # 12. Entrada antiga diferente do modelo: e trocada, com backup
    $velho = '{"mcpServers":{"dart":{"command":"dart","args":["mcp-server","--disable","pub"]}}}'
    [System.IO.File]::WriteAllText($c.json, $velho, $utf8)
    $env:PATH = (Split-Path -Parent $c.dart) + [System.IO.Path]::PathSeparator + $pathOriginal
    $r = Instalar $c.destino @('-ComDart')
    $env:PATH = $pathOriginal
    $u = Ler-Json $c.json
    Conferir 'dart antigo registrado: entrada trocada pela do modelo' ((@($u.mcpServers.dart.args) -join ' ') -eq ($argsModelo -join ' '))
    Conferir 'dart antigo registrado: backup gravado' (@(Get-ChildItem -LiteralPath $c.destino -Filter '.claude.json.bak-*' -Force).Count -ge 1)

    # 13. Versao anterior a minima: avisa e nao registra
    $c = Instalar-ComDart 'velho' '3.11.3' 'ok'
    Conferir 'dart velho: saiu com 0' ($c.r.codigo -eq 0)
    Conferir 'dart velho: avisou a versao' ($c.r.texto -match 'Dart 3\.\d+\.\d+ ou mais novo')
    Conferir 'dart velho: nao registrou' (-not (Test-Path $c.json))

    # 14. Servidor que nao aceita os argumentos: avisa e nao registra
    $c = Instalar-ComDart 'recusa' '3.13.1' 'antigo'
    Conferir 'dart que recusa --disable: saiu com 0' ($c.r.codigo -eq 0)
    Conferir 'dart que recusa --disable: avisou' ($c.r.texto -match 'nao subiu')
    Conferir 'dart que recusa --disable: nao registrou' (-not (Test-Path $c.json))

    # 15. Servidor que publica ferramenta nao habilitada: avisa e nao registra
    $c = Instalar-ComDart 'extra' '3.13.1' 'extra'
    Conferir 'dart com ferramenta a mais: avisou' ($c.r.texto -match 'ferramenta_nova')
    Conferir 'dart com ferramenta a mais: nao registrou' (-not (Test-Path $c.json))

    # 16 a 18. -ApoioLocal com um python falso no PATH (testes/python-falso.ps1)
    $pyFalso = Join-Path $PSScriptRoot 'python-falso.ps1'
    $servidorFalso = Join-Path $base 'apoio-local\servidor.py'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $servidorFalso) | Out-Null
    [System.IO.File]::WriteAllText($servidorFalso, "# servidor falso`n", $utf8)
    function Instalar-ComApoio([string]$nome, [string]$comMcp, [string]$servidor) {
        $pasta = Join-Path $base "python-$nome"
        New-Item -ItemType Directory -Force -Path $pasta | Out-Null
        if ($env:OS -eq 'Windows_NT') {
            $exePy = Join-Path $pasta 'python.cmd'
            $texto = "@set PYTHON_FALSO_EXE=$exePy`r`n@set PYTHON_FALSO_MCP=$comMcp`r`n@`"$exe`" -NoProfile -ExecutionPolicy Bypass -File `"$pyFalso`" %*`r`n"
        } else {
            $exePy = Join-Path $pasta 'python'
            $texto = "#!/bin/sh`nPYTHON_FALSO_EXE='$exePy' PYTHON_FALSO_MCP='$comMcp' exec '$exe' -NoProfile -File '$pyFalso' `"`$@`"`n"
        }
        [System.IO.File]::WriteAllText($exePy, $texto, $utf8)
        if ($env:OS -ne 'Windows_NT') { & chmod +x $exePy }
        $destino = Join-Path $base "cfg-apoio-$nome"
        New-Item -ItemType Directory -Force -Path $destino | Out-Null
        $env:PATH = $pasta + [System.IO.Path]::PathSeparator + $pathOriginal
        $r = Instalar $destino @('-SemBloqueios', '-ApoioLocal', $servidor)
        $env:PATH = $pathOriginal
        return @{ r = $r; py = $exePy; json = (Join-Path $destino '.claude.json') }
    }

    # 16. Python com o pacote mcp: registra com o caminho completo do Python e do servidor
    $c = Instalar-ComApoio 'ok' 'sim' $servidorFalso
    $u = $null
    if (Test-Path $c.json) { $u = Ler-Json $c.json }
    Conferir 'apoio: saiu com 0' ($c.r.codigo -eq 0)
    Conferir 'apoio: registrou com o Python encontrado' ($null -ne $u -and $u.mcpServers.'apoio-local'.command -eq $c.py)
    Conferir 'apoio: argumento e o servidor.py' ($null -ne $u -and (@($u.mcpServers.'apoio-local'.args) -join '|') -eq $servidorFalso)
    if ($null -eq $u) { Write-Host $c.r.texto }

    # 17. Python sem o pacote mcp: avisa e nao registra
    $c = Instalar-ComApoio 'sem-mcp' 'nao' $servidorFalso
    Conferir 'apoio sem mcp: saiu com 0' ($c.r.codigo -eq 0)
    Conferir 'apoio sem mcp: avisou' ($c.r.texto -match 'pacote mcp')
    Conferir 'apoio sem mcp: nao registrou' (-not (Test-Path $c.json))

    # 18. Caminho do servidor que nao existe: avisa e nao registra
    $c = Instalar-ComApoio 'sem-arquivo' 'sim' (Join-Path $base 'nao-existe\servidor.py')
    Conferir 'apoio sem servidor: avisou' ($c.r.texto -match 'nao existe')
    Conferir 'apoio sem servidor: nao registrou' (-not (Test-Path $c.json))
} else {
    Write-Host "Sem Node.js: cenarios do -ComMapa e do -ComDart pulados."
}

Remove-Item -LiteralPath $base -Recurse -Force
Write-Host "PowerShell $($PSVersionTable.PSVersion): $($total - $falhas) de $total verificacoes certas."
if ($falhas -gt 0) { exit 1 }
exit 0
