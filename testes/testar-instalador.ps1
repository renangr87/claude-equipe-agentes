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

# Sempre sem instalar nem baixar nada (-SemInstalar). Dart e Apoio Local ficam de fora,
# a menos que o cenario peca por eles: assim um Dart ou Ollama da maquina nao muda o resultado.
function Instalar([string]$destino, [string[]]$extra = @()) {
    $padrao = @('-SemInstalar')
    if ($extra -notcontains '-ComDart') { $padrao += '-SemDart' }
    if ($extra -notcontains '-ApoioLocal' -and $extra -notcontains '-PastaApoio') { $padrao += '-SemApoio' }
    $saida = & $exe -NoProfile -ExecutionPolicy Bypass -File $instalador -Destino $destino @padrao @extra 2>&1
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
    Conferir "limpa: $a.md sem marcador" (-not $texto.Contains('__PASTA_CLAUDE__') -and -not $texto.Contains('__NODE__'))
}
$explore = [System.IO.File]::ReadAllText((Join-Path $d1 'agents\Explore.md'), $utf8)
$destinoBruto = (Resolve-Path -LiteralPath $d1).ProviderPath -replace '\\', '/'
Conferir 'limpa: Explore com a trava de leitura no caminho real' ($explore.Contains('"' + $destinoBruto + '/hooks/equipe-leitura.mjs"'))
Conferir 'limpa: guarda copiada' (Test-Path (Join-Path $d1 'hooks\guarda-comandos.ps1'))
Conferir 'limpa: regra copiada' (Test-Path (Join-Path $d1 'rules\equipe-agentes.md'))
$s = Ler-Json (Join-Path $d1 'settings.json')
Conferir 'limpa: todas as regras deny' (@($s.permissions.deny).Count -eq $nDeny)
Conferir 'limpa: todas as regras ask' (@($s.permissions.ask).Count -eq $nAsk)

# 1b. Scripts, skill da retrospectiva, versao instalada e hooks da equipe
foreach ($n in 'equipe-comum.mjs', 'equipe-boletim.mjs', 'equipe-contexto.mjs', 'equipe-medir.mjs', 'equipe-sql.mjs', 'equipe-leitura.mjs', 'equipe-banco.mjs', 'equipe-segredos.mjs', 'equipe-aviso.mjs', 'equipe-memoria.mjs') {
    Conferir "limpa: $n copiado" (Test-Path (Join-Path $d1 "hooks\$n"))
}
$caminhoSkill = Join-Path $d1 'skills\retro-equipe\SKILL.md'
$skill = if (Test-Path $caminhoSkill) { [System.IO.File]::ReadAllText($caminhoSkill, $utf8) } else { '__PASTA_CLAUDE__' }
Conferir 'limpa: skill /retro-equipe sem marcadores' (-not $skill.Contains('__PASTA_CLAUDE__') -and -not $skill.Contains('__NODE__'))
$versao = $null
if (Test-Path (Join-Path $d1 'equipe-versao.json')) { $versao = Ler-Json (Join-Path $d1 'equipe-versao.json') }
Conferir 'limpa: versao instalada gravada' ($null -ne $versao -and [string]$versao.pasta -ne '')
$temNode = [bool](Get-Command node -ErrorAction SilentlyContinue)
if ($temNode) {
    $ini = @($s.hooks.SessionStart)
    $sub = @($s.hooks.SubagentStart)
    Conferir 'limpa: hook de inicio aponta para o boletim' ($ini.Count -eq 1 -and [string](@(@($ini[0].hooks)[0].args)[0]) -like '*/hooks/equipe-boletim.mjs')
    Conferir 'limpa: hook dos subagentes so para Explore, verificador e revisor' ($sub.Count -eq 1 -and $sub[0].matcher -eq 'Explore|verificador|revisor')
    # O hook registrado roda de verdade e devolve o JSON que o Claude Code espera.
    $h = @($ini[0].hooks)[0]
    $env:EQUIPE_SEM_REDE = '1'
    $entrada = '{"cwd":"' + ($raiz -replace '\\', '/') + '","source":"startup"}'
    $saidaHook = ($entrada | & $h.command @($h.args) 2>&1 | Out-String)
    Remove-Item Env:\EQUIPE_SEM_REDE
    Conferir 'limpa: hook de inicio roda e devolve contexto' ($saidaHook -match '"hookEventName":"SessionStart"' -and $saidaHook -match 'additionalContext')
    if ($saidaHook -notmatch 'additionalContext') { Write-Host $saidaHook }
}

# 2. Repeticao: nada muda, nenhum backup novo
$versaoAntes = [System.IO.File]::ReadAllText((Join-Path $d1 'equipe-versao.json'), $utf8)
$r = Instalar $d1
Conferir 'repeticao: saiu com 0' ($r.codigo -eq 0)
Conferir 'repeticao: sem backup' (@(Get-ChildItem -LiteralPath $d1 -Recurse -Filter '*.bak-*').Count -eq 0)
Conferir 'repeticao: versao instalada nao foi regravada' ([System.IO.File]::ReadAllText((Join-Path $d1 'equipe-versao.json'), $utf8) -ceq $versaoAntes)

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

# 3c. Hooks que o usuario escreveu ficam; a entrada antiga da equipe e trocada
if ($temNode) {
    $d3c = Join-Path $base 'hooks-usuario'
    New-Item -ItemType Directory -Force -Path $d3c | Out-Null
    # Um hook do usuario foi acrescentado dentro do grupo antigo da equipe, e outro do
    # usuario tem nome parecido com os da equipe: os dois ficam.
    # Num evento que a equipe deixou de usar, sai so o hook da equipe.
    $inicial = '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo","args":["oi"]}]},{"hooks":[{"type":"command","command":"node","args":["C:/velho/.claude/hooks/equipe-boletim.mjs"],"timeout":5},{"type":"command","command":"meu-no-grupo"}]}],"Stop":[{"hooks":[{"type":"command","command":"node","args":["C:/meus/hooks/equipe-outro.mjs"]}]}],"SubagentStop":[{"hooks":[{"type":"command","command":"node","args":["C:/velho/.claude/hooks/equipe-contexto.mjs"]},{"type":"command","command":"meu-stop"}]},{"hooks":[{"type":"command","command":"node","args":["C:/velho/.claude/hooks/equipe-boletim.mjs"]}]}],"PreCompact":[{"hooks":[{"type":"command","command":"node","args":["C:/velho/.claude/hooks/equipe-sql.mjs"]}]}]}}'
    [System.IO.File]::WriteAllText((Join-Path $d3c 'settings.json'), $inicial, $utf8)
    $r = Instalar $d3c
    $s = Ler-Json (Join-Path $d3c 'settings.json')
    $ini = @($s.hooks.SessionStart)
    Conferir 'hooks: saiu com 0' ($r.codigo -eq 0)
    Conferir 'hooks: manteve o hook do usuario' ($ini.Count -eq 3 -and @($ini[0].hooks)[0].command -eq 'echo')
    Conferir 'hooks: manteve o hook do usuario que estava no grupo da equipe' ($ini.Count -eq 3 -and @($ini[1].hooks).Count -eq 1 -and @($ini[1].hooks)[0].command -eq 'meu-no-grupo')
    Conferir 'hooks: trocou a entrada antiga da equipe' ($ini.Count -eq 3 -and @($ini[2].hooks)[0].timeout -eq 15 -and [string](@(@($ini[2].hooks)[0].args)[0]) -notlike 'C:/velho/*')
    $todosArgs = @($ini | ForEach-Object { @($_.hooks) } | ForEach-Object { @($_.args) }) -join ' '
    Conferir 'hooks: nenhuma entrada antiga da equipe sobrou' ($todosArgs -notmatch 'C:/velho/')
    Conferir 'hooks: manteve o hook do usuario de nome parecido' ([string](@(@(@($s.hooks.Stop)[0].hooks)[0].args)[0]) -eq 'C:/meus/hooks/equipe-outro.mjs')
    $parado = @($s.hooks.SubagentStop)
    Conferir 'hooks: evento retirado perdeu so o hook da equipe' ($parado.Count -eq 1 -and @($parado[0].hooks).Count -eq 1 -and @($parado[0].hooks)[0].command -eq 'meu-stop')
    Conferir 'hooks: evento retirado so com hook da equipe saiu' ($null -eq $s.hooks.PSObject.Properties['PreCompact'])
    $argsDe = { param($evento) (@($s.hooks.$evento) | ForEach-Object { @($_.hooks) } | ForEach-Object { @($_.args) }) -join ' ' }
    Conferir 'hooks: aviso no celular registrado' ((& $argsDe 'Notification') -match '/hooks/equipe-aviso\.mjs')
    Conferir 'hooks: memoria registrada no inicio e no fim' (((& $argsDe 'SessionStart') -match '/hooks/equipe-memoria\.mjs') -and ((& $argsDe 'Stop') -match '/hooks/equipe-memoria\.mjs') -and ((& $argsDe 'SessionEnd') -match '/hooks/equipe-memoria\.mjs'))
    $edicao = @(@($s.hooks.PreToolUse) | Where-Object { $_.matcher -eq 'Write|Edit|MultiEdit|NotebookEdit' })
    Conferir 'hooks: trava de segredos nas edicoes e no terminal' ($edicao.Count -eq 1 -and ((& $argsDe 'PreToolUse') -match 'equipe-segredos\.mjs.*equipe-segredos\.mjs'))
    $aviso = Join-Path $d3c 'equipe-aviso.json'
    Conferir 'aviso: topico secreto criado' ((Test-Path $aviso) -and ([string]((Ler-Json $aviso).ntfy) -match '^https://ntfy\.sh/equipe-[0-9a-f]{20}$'))
    $topicoAntes = [System.IO.File]::ReadAllText($aviso, $utf8)
    $sql = @(@($s.hooks.PreToolUse) | Where-Object { $_.matcher -eq 'mcp__.*__execute_sql' })
    Conferir 'hooks: hook de SQL registrado' ($sql.Count -eq 1 -and [string](@(@($sql[0].hooks)[0].args)[0]) -like '*/hooks/equipe-sql.mjs')
    $banco = @(@($s.hooks.PreToolUse) | Where-Object { $_.matcher -eq 'Bash|PowerShell' })
    Conferir 'hooks: hook de banco no terminal registrado' ($banco.Count -eq 1 -and [string](@(@($banco[0].hooks)[0].args)[0]) -like '*/hooks/equipe-banco.mjs')
    Conferir 'hooks: um backup so, com bloqueios e hooks' (@(Get-ChildItem -LiteralPath $d3c -Filter 'settings.json.bak-*').Count -eq 1)
    $r = Instalar $d3c
    Conferir 'hooks: repeticao nao muda nada' ($r.texto -match 'hooks ja presentes')
    Conferir 'aviso: repeticao mantem o topico' ([System.IO.File]::ReadAllText($aviso, $utf8) -ceq $topicoAntes)
    # Memoria: com a pasta de um clone, grava a configuracao apontando para ela.
    $clone = Join-Path $base 'memoria-clone'
    New-Item -ItemType Directory -Force -Path (Join-Path $clone '.git') | Out-Null
    $r = Instalar $d3c @('-Memoria', $clone)
    $cfgMem = Join-Path $d3c 'equipe-memoria.json'
    Conferir 'memoria: configuracao gravada' ((Test-Path $cfgMem) -and ([string]((Ler-Json $cfgMem).pasta) -eq ((Resolve-Path $clone).ProviderPath -replace '\\', '/')))
}

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
Conferir 'sem bloqueios: skill copiada mesmo assim' (Test-Path (Join-Path $d5 'skills\retro-equipe\SKILL.md'))

# 5b. -SemHooks: bloqueios sim, hooks nao
$d5b = Join-Path $base 'sem-hooks'
$r = Instalar $d5b @('-SemHooks')
$s = Ler-Json (Join-Path $d5b 'settings.json')
Conferir 'sem hooks: saiu com 0' ($r.codigo -eq 0)
Conferir 'sem hooks: sem aviso no celular' (-not (Test-Path (Join-Path $d5b 'equipe-aviso.json')))
Conferir 'sem hooks: bloqueios gravados' (@($s.permissions.deny).Count -eq $nDeny)
Conferir 'sem hooks: nenhum hook no settings.json' (-not $s.PSObject.Properties['hooks'])

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
if ($temNode) {
    $s = Ler-Json (Join-Path $d6 'settings.json')
    Conferir 'aspa: caminho do hook da equipe sem escape' ([string](@(@(@($s.hooks.SessionStart)[0].hooks)[0].args)[0]) -like "*pasta d'agua/hooks/equipe-boletim.mjs")
    $skill = [System.IO.File]::ReadAllText((Join-Path $d6 'skills\retro-equipe\SKILL.md'), $utf8)
    Conferir 'aspa: caminho da skill sem escape' ($skill.Contains("pasta d'agua/hooks/equipe-medir.mjs"))
}

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
    # (LOCALAPPDATA trocado: o instalador tambem procura na pasta padrao do programa)
    $d10 = Join-Path $base 'mapa-ausente'
    New-Item -ItemType Directory -Force -Path $d10 | Out-Null
    $localOriginal = $env:LOCALAPPDATA
    $env:LOCALAPPDATA = Join-Path $base 'localappdata-vazio'
    $r = Instalar $d10 @('-ComMapa')
    $env:LOCALAPPDATA = $localOriginal
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
    function Instalar-ComApoio([string]$nome, [string]$comMcp, [string[]]$extra, [string]$pip = '', [string]$jsonInicial = '') {
        $pasta = Join-Path $base "python-$nome"
        New-Item -ItemType Directory -Force -Path $pasta | Out-Null
        if ($env:OS -eq 'Windows_NT') {
            $exePy = Join-Path $pasta 'python.cmd'
            $texto = "@set PYTHON_FALSO_EXE=$exePy`r`n@set PYTHON_FALSO_MCP=$comMcp`r`n@set PYTHON_FALSO_PIP=$pip`r`n@`"$exe`" -NoProfile -ExecutionPolicy Bypass -File `"$pyFalso`" %*`r`n"
        } else {
            $exePy = Join-Path $pasta 'python'
            $texto = "#!/bin/sh`nPYTHON_FALSO_EXE='$exePy' PYTHON_FALSO_MCP='$comMcp' PYTHON_FALSO_PIP='$pip' exec '$exe' -NoProfile -File '$pyFalso' `"`$@`"`n"
        }
        [System.IO.File]::WriteAllText($exePy, $texto, $utf8)
        if ($env:OS -ne 'Windows_NT') { & chmod +x $exePy }
        $destino = Join-Path $base "cfg-apoio-$nome"
        New-Item -ItemType Directory -Force -Path $destino | Out-Null
        $json = Join-Path $destino '.claude.json'
        if ($jsonInicial) { [System.IO.File]::WriteAllText($json, $jsonInicial, $utf8) }
        $env:PATH = $pasta + [System.IO.Path]::PathSeparator + $pathOriginal
        $r = Instalar $destino (@('-SemBloqueios') + $extra)
        $env:PATH = $pathOriginal
        return @{ r = $r; py = $exePy; json = $json; destino = $destino }
    }
    # Copia falsa do Apoio Local com requirements.txt: o instalador cria o .venv ao lado
    function Nova-CopiaApoio([string]$nome) {
        $pasta = Join-Path $base "copia-$nome"
        New-Item -ItemType Directory -Force -Path $pasta | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $pasta 'servidor.py'), "# servidor falso`n", $utf8)
        [System.IO.File]::WriteAllText((Join-Path $pasta 'requirements.txt'), "mcp==2.3.0`n", $utf8)
        if ($env:OS -eq 'Windows_NT') { $py = Join-Path $pasta '.venv\Scripts\python.cmd' } else { $py = Join-Path $pasta '.venv/bin/python' }
        return @{ pasta = $pasta; servidor = (Join-Path $pasta 'servidor.py'); py = $py }
    }

    # 16. Python com o pacote mcp: registra com o caminho completo do Python e do servidor
    $c = Instalar-ComApoio 'ok' 'sim' @('-ApoioLocal', $servidorFalso)
    $u = $null
    if (Test-Path $c.json) { $u = Ler-Json $c.json }
    Conferir 'apoio: saiu com 0' ($c.r.codigo -eq 0)
    Conferir 'apoio: registrou com o Python encontrado' ($null -ne $u -and $u.mcpServers.'apoio-local'.command -eq $c.py)
    Conferir 'apoio: argumento e o servidor.py' ($null -ne $u -and (@($u.mcpServers.'apoio-local'.args) -join '|') -eq $servidorFalso)
    if ($null -eq $u) { Write-Host $c.r.texto }

    # 17. Python sem o pacote mcp: avisa e nao registra
    $c = Instalar-ComApoio 'sem-mcp' 'nao' @('-ApoioLocal', $servidorFalso)
    Conferir 'apoio sem mcp: saiu com 0' ($c.r.codigo -eq 0)
    Conferir 'apoio sem mcp: avisou' ($c.r.texto -match 'pacote mcp')
    Conferir 'apoio sem mcp: nao registrou' (-not (Test-Path $c.json))

    # 18. Caminho do servidor que nao existe: avisa e nao registra
    $c = Instalar-ComApoio 'sem-arquivo' 'sim' @('-ApoioLocal', (Join-Path $base 'nao-existe\servidor.py'))
    Conferir 'apoio sem servidor: avisou' ($c.r.texto -match 'nao existe')
    Conferir 'apoio sem servidor: nao registrou' (-not (Test-Path $c.json))

    # 19. Copia com requirements.txt: cria o .venv, instala com o pip e registra o Python dele
    $copia = Nova-CopiaApoio 'venv'
    $c = Instalar-ComApoio 'venv' 'nao' @('-ApoioLocal', $copia.servidor)
    $u = $null
    if (Test-Path $c.json) { $u = Ler-Json $c.json }
    Conferir 'apoio venv: saiu com 0' ($c.r.codigo -eq 0)
    Conferir 'apoio venv: criou o ambiente' (Test-Path -LiteralPath $copia.py)
    Conferir 'apoio venv: registrou o Python do .venv' ($null -ne $u -and $u.mcpServers.'apoio-local'.command -eq $copia.py)
    if ($null -eq $u) { Write-Host $c.r.texto }
    $r = Instalar $c.destino @('-SemBloqueios', '-ApoioLocal', $copia.servidor)
    Conferir 'apoio venv: repeticao nao muda nada' ($r.codigo -eq 0 -and $r.texto -match 'igual ao modelo' -and @(Get-ChildItem -LiteralPath $c.destino -Filter '.claude.json.bak-*' -Force).Count -eq 0)

    # 20. pip com erro: avisa e nao registra
    $copia = Nova-CopiaApoio 'pip-falha'
    $c = Instalar-ComApoio 'pip-falha' 'nao' @('-ApoioLocal', $copia.servidor) 'falha'
    Conferir 'apoio pip falhou: avisou' ($c.r.texto -match 'pip nao conseguiu')
    Conferir 'apoio pip falhou: nao registrou' (-not (Test-Path $c.json))

    # 21. Registro que ja existe (clone do git): usa a copia registrada e mantem os ajustes (env, type)
    $copia = Nova-CopiaApoio 'registrada'
    New-Item -ItemType Directory -Force -Path (Join-Path $copia.pasta '.git') | Out-Null
    $servidorJson = $copia.servidor.Replace('\', '\\')
    $inicial = '{"mcpServers":{"apoio-local":{"type":"stdio","command":"velho","args":["' + $servidorJson + '"],"env":{"APOIO_LOCAL_URL":"http://127.0.0.1:11435","APOIO_LOCAL_MODELO":"meu-modelo"}}}}'
    $c = Instalar-ComApoio 'registrada' 'nao' @('-PastaApoio', (Join-Path $base 'nao-baixar')) '' $inicial
    $u = Ler-Json $c.json
    $e = $u.mcpServers.'apoio-local'
    Conferir 'apoio registrado: saiu com 0' ($c.r.codigo -eq 0)
    Conferir 'apoio registrado: usou a copia registrada' ($c.r.texto -match 'copia ja registrada' -and (@($e.args) -join '|') -eq $copia.servidor)
    Conferir 'apoio registrado: trocou o Python pelo do .venv' ($e.command -eq $copia.py)
    Conferir 'apoio registrado: manteve env e type' ($e.env.APOIO_LOCAL_URL -eq 'http://127.0.0.1:11435' -and $e.env.APOIO_LOCAL_MODELO -eq 'meu-modelo' -and $e.type -eq 'stdio')
    Conferir 'apoio registrado: nao mexeu no Ollama local' ($c.r.texto -match 'registro atual usa http://127\.0\.0\.1:11435')
    Conferir 'apoio registrado: nao baixou nada' (-not (Test-Path (Join-Path $base 'nao-baixar')))

    # 21b. Registro que aponta para copia solta (ZIP, sem .git): passa a usar a copia de
    # -PastaApoio e mantem os ajustes
    $solta = Nova-CopiaApoio 'solta'
    $clone = Nova-CopiaApoio 'clone'
    $inicial = '{"mcpServers":{"apoio-local":{"command":"velho","args":["' + $solta.servidor.Replace('\', '\\') + '"],"env":{"APOIO_LOCAL_URL":"http://127.0.0.1:11435"}}}}'
    $c = Instalar-ComApoio 'solta' 'nao' @('-PastaApoio', $clone.pasta) '' $inicial
    $e = (Ler-Json $c.json).mcpServers.'apoio-local'
    Conferir 'apoio copia solta: avisou' ($c.r.texto -match 'nao e um clone do git')
    Conferir 'apoio copia solta: passou para a copia da pasta' ((@($e.args) -join '|') -eq $clone.servidor -and $e.command -eq $clone.py)
    Conferir 'apoio copia solta: manteve os ajustes' ($e.env.APOIO_LOCAL_URL -eq 'http://127.0.0.1:11435')

    # 22. Copia na pasta padrao (-PastaApoio): registra sem baixar
    $copia = Nova-CopiaApoio 'pasta'
    $c = Instalar-ComApoio 'pasta' 'nao' @('-PastaApoio', $copia.pasta)
    $u = $null
    if (Test-Path $c.json) { $u = Ler-Json $c.json }
    Conferir 'apoio na pasta: registrou' ($null -ne $u -and (@($u.mcpServers.'apoio-local'.args) -join '|') -eq $copia.servidor)

    # 23. Sem copia e com -SemInstalar: avisa, nao baixa e nao registra
    $c = Instalar-ComApoio 'ausente' 'sim' @('-PastaApoio', (Join-Path $base 'apoio-ausente'))
    Conferir 'apoio ausente: avisou' ($c.r.texto -match 'nao foi encontrado em')
    Conferir 'apoio ausente: nao baixou' (-not (Test-Path (Join-Path $base 'apoio-ausente')))
    Conferir 'apoio ausente: nao registrou' (-not (Test-Path $c.json))

    # 24. -ApoioEmpresa: registra com o atalho para o Ollama de casa; o pedido explicito
    # troca a URL antiga e mantem os outros ajustes. Com -SemInstalar, o Tailscale e pulado.
    $copia = Nova-CopiaApoio 'empresa'
    $servidorJson = $copia.servidor.Replace('\', '\\')
    $inicial = '{"mcpServers":{"apoio-local":{"command":"velho","args":["' + $servidorJson + '"],"env":{"APOIO_LOCAL_URL":"http://127.0.0.1:9999","APOIO_LOCAL_TIMEOUT_S":"900"}}}}'
    $c = Instalar-ComApoio 'empresa' 'nao' @('-PastaApoio', $copia.pasta, '-ApoioEmpresa') '' $inicial
    $e = (Ler-Json $c.json).mcpServers.'apoio-local'
    Conferir 'apoio empresa: saiu com 0' ($c.r.codigo -eq 0)
    Conferir 'apoio empresa: URL do atalho de casa' ($e.env.APOIO_LOCAL_URL -eq 'http://127.0.0.1:11435')
    Conferir 'apoio empresa: modelo fixado' ($e.env.APOIO_LOCAL_MODELO -eq 'gemma4:12b')
    Conferir 'apoio empresa: manteve outro ajuste' ($e.env.APOIO_LOCAL_TIMEOUT_S -eq '900')
    Conferir 'apoio empresa: Tailscale pulado com -SemInstalar' ($c.r.texto -match 'pulado \(-SemInstalar\)')
    $env:PATH = (Split-Path -Parent $c.py) + [System.IO.Path]::PathSeparator + $pathOriginal
    $r = Instalar $c.destino @('-SemBloqueios', '-PastaApoio', $copia.pasta, '-ApoioEmpresa')
    $env:PATH = $pathOriginal
    Conferir 'apoio empresa: repeticao nao muda nada' ($r.texto -match 'igual ao modelo')

    # 25. -ApoioCasa e -ApoioEmpresa juntos: recusa antes de mexer em qualquer coisa
    $d25 = Join-Path $base 'casa-e-empresa'
    $r = Instalar $d25 @('-PastaApoio', $copia.pasta, '-ApoioCasa', '-ApoioEmpresa')
    Conferir 'apoio casa e empresa: saiu com erro' ($r.codigo -ne 0)
    Conferir 'apoio casa e empresa: nao instalou nada' (-not (Test-Path (Join-Path $d25 'agents')))
} else {
    Write-Host "Sem Node.js: cenarios do -ComMapa e do -ComDart pulados."
}

Remove-Item -LiteralPath $base -Recurse -Force
Write-Host "PowerShell $($PSVersionTable.PSVersion): $($total - $falhas) de $total verificacoes certas."
if ($falhas -gt 0) { exit 1 }
exit 0
