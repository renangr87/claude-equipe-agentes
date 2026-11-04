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
# Confere o codigo e a mensagem: cada trecho de $trechos aparece nela, literal, e nenhum de $ausentes.
function ConferirMensagem([string]$nome, [int]$esperado, [int]$obtido, [string[]]$trechos, [string[]]$ausentes = @()) {
    $script:total++
    $erros = @()
    if ($esperado -ne $obtido) { $erros += "esperado $esperado, veio $obtido" }
    foreach ($t in $trechos) { if (-not $script:mensagem.Contains($t)) { $erros += "sem '$t'" } }
    foreach ($t in $ausentes) { if ($script:mensagem.Contains($t)) { $erros += "com '$t'" } }
    if ($erros.Count -gt 0) {
        $script:falhas++
        Avisar "FALHOU ($($erros -join '; ')): $nome :: $script:mensagem"
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

# Mensagens do implementador: dizem o que fazer no lugar do que foi barrado.
ConferirMensagem 'mensagem do stash: worktree no HEAD' 2 (Rodar 'implementador' (Json 'Bash' 'git stash push -m x')) @('git worktree add <pasta temporaria fora do projeto> HEAD', 'git worktree remove <pasta>', 'talvez anterior a mudanca')
ConferirMensagem 'mensagem do checkout de arquivo: Edit olhando o diff' 2 (Rodar 'implementador' (Json 'Bash' 'git checkout -- lib/a.dart')) @('ferramenta Edit', 'git diff HEAD -- <arquivo>', 'git show HEAD:<arquivo>, sem gravar') @('relate ao mestre')
ConferirMensagem 'mensagem do checkout de arquivo sem --' 2 (Rodar 'implementador' (Json 'Bash' 'git checkout lib/a.dart')) @('ferramenta Edit')
ConferirMensagem 'mensagem do checkout de versao e arquivo' 2 (Rodar 'implementador' (Json 'Bash' 'git checkout HEAD~1 lib/a.dart')) @('ferramenta Edit')
ConferirMensagem 'mensagem do restore: Edit olhando o diff' 2 (Rodar 'implementador' (Json 'PowerShell' 'git restore --staged --worktree lib/a.dart')) @('ferramenta Edit', 'git diff HEAD -- <arquivo>')
ConferirMensagem 'mensagem do checkout de branch: relatar ao mestre' 2 (Rodar 'implementador' (Json 'Bash' 'git checkout main')) @('relate ao mestre') @('ferramenta Edit')
ConferirMensagem 'mensagem do checkout -b: relatar ao mestre' 2 (Rodar 'implementador' (Json 'Bash' 'git checkout -b tarefa')) @('relate ao mestre')
ConferirMensagem 'mensagem do switch: relatar ao mestre' 2 (Rodar 'implementador' (Json 'Bash' 'git switch main')) @('relate ao mestre')
ConferirMensagem 'mensagem do reset: relatar ao mestre' 2 (Rodar 'implementador' (Json 'Bash' 'git reset --hard')) @('relate ao mestre')
ConferirMensagem 'mensagem do clean: relatar ao mestre' 2 (Rodar 'implementador' (Json 'Bash' 'git clean -fd')) @('relate ao mestre')
$caminhoCerto = @('git show HEAD:<arquivo> ou git diff HEAD -- <arquivo>, sem gravar: a saida volta para voce', 'git worktree add <pasta temporaria fora do projeto> HEAD')
ConferirMensagem 'mensagem do git show gravado no projeto' 2 (Rodar 'implementador' (Json 'Bash' 'git show HEAD:lib/a.dart > lib/a.dart')) ($caminhoCerto + @("gravada em arquivo ('lib/a.dart')")) @('grave em .revisao/')
ConferirMensagem 'mensagem do git show gravado num caminho com variavel' 2 (Rodar 'implementador' (Json 'PowerShell' 'git show HEAD:lib/a.dart | Out-File $env:TEMP/a.dart')) ($caminhoCerto + @("gravada em arquivo ('`$env:TEMP/a.dart')"))
ConferirMensagem 'mensagem do formatador em pasta: exemplo e git status' 2 (Rodar 'implementador' (Json 'Bash' 'dart format .')) @('Exemplo: dart format lib/a.dart lib/b.dart', 'git status --short')
ConferirMensagem 'mensagem do formatador sem arquivo: exemplo e git status' 2 (Rodar 'implementador' (Json 'Bash' 'dart format')) @('Exemplo: dart format lib/a.dart lib/b.dart', 'git status --short')
ConferirMensagem 'mensagem do dart fix: exemplo com --apply' 2 (Rodar 'implementador' (Json 'Bash' 'dart fix --apply lib')) @('Exemplo: dart fix --apply lib/a.dart lib/b.dart')
ConferirMensagem 'mensagem do prettier: exemplo do proprio formatador' 2 (Rodar 'implementador' (Json 'Bash' 'npx prettier --write src')) @('Exemplo: prettier --write src/a.ts src/b.ts', 'git status --short')
ConferirMensagem 'mensagem do script npm: exemplo com prettier' 2 (Rodar 'implementador' (Json 'Bash' 'npm run format')) @('Exemplo: npx prettier --write src/a.ts src/b.ts', 'git status --short')
ConferirMensagem 'mensagem do script melos: exemplo com dart' 2 (Rodar 'implementador' (Json 'Bash' 'melos format')) @('Exemplo: dart format lib/a.dart lib/b.dart')
ConferirMensagem 'mensagem do Start-Process: exemplo e git status' 2 (Rodar 'implementador' (Json 'PowerShell' "Start-Process dart -ArgumentList 'format','.'")) @('Exemplo: dart format lib/a.dart lib/b.dart', 'git status --short')

[System.IO.File]::AppendAllText($lista, "rm -rf`n", $utf8)
Conferir 'lista do verificador alterada fora de commit' 2 (Rodar 'verificador' (Json 'Bash' 'flutter test'))
& git -C $proj checkout -q -- .claude/verificador-comandos.txt 2>$null

# Worktree do projeto: vale a lista do worktree (cwd) quando ela esta em commit nele.
function JsonEm([string]$pasta, [string]$comando) {
    return (@{ tool_name = 'Bash'; tool_input = @{ command = $comando }; cwd = $pasta } | ConvertTo-Json -Compress)
}
$wt = Join-Path ([System.IO.Path]::GetTempPath()) ("guarda-wt-" + [guid]::NewGuid().ToString('N'))
& git -C $proj worktree add -q -b wt $wt 2>$null
$listaWt = Join-Path $wt '.claude\verificador-comandos.txt'
[System.IO.File]::WriteAllText($listaWt, "dart test`n", $utf8)
& git -C $wt -c user.email=t@t -c user.name=t commit -q -a -m lista-wt 2>$null
Conferir 'worktree: comando da lista do worktree' 0 (Rodar 'verificador' (JsonEm $wt 'dart test'))
Conferir 'worktree: comando so da lista do projeto' 2 (Rodar 'verificador' (JsonEm $wt 'flutter test'))
[System.IO.File]::AppendAllText($listaWt, "rm -rf`n", $utf8)
Conferir 'worktree: lista alterada fora de commit' 2 (Rodar 'verificador' (JsonEm $wt 'dart test'))
# git show num worktree: gravar no projeto principal (outro repositorio) barra; no .revisao/ do worktree, passa.
$arquivoProj = Join-Path (Join-Path $proj 'lib') 'a.dart'
Conferir 'worktree: git show gravado no projeto principal' 2 (Rodar 'implementador' (JsonEm $wt "git show HEAD:lib/a.dart > `"$arquivoProj`""))
Conferir 'worktree: git show gravado no .revisao/ do worktree' 2 (Rodar 'implementador' (JsonEm $wt 'git show HEAD:lib/a.dart > .revisao/a.dart'))
& git -C $proj worktree remove --force $wt 2>$null

# Repositorio que nao e do projeto: a lista dele nao vale; vale a do projeto.
$outro = Join-Path ([System.IO.Path]::GetTempPath()) ("guarda-outro-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path (Join-Path $outro '.claude') | Out-Null
[System.IO.File]::WriteAllText((Join-Path $outro '.claude\verificador-comandos.txt'), "dart test`n", $utf8)
& git -C $outro init -q 2>$null
& git -C $outro -c user.email=t@t -c user.name=t add .claude/verificador-comandos.txt 2>$null
& git -C $outro -c user.email=t@t -c user.name=t commit -q -m lista 2>$null
Conferir 'outro repositorio: lista dele nao vale' 2 (Rodar 'verificador' (JsonEm $outro 'dart test'))
Conferir 'outro repositorio: vale a do projeto' 0 (Rodar 'verificador' (JsonEm $outro 'flutter test'))

# git show gravado em arquivo barra em qualquer lugar: fora de repositorio, em .revisao/, no
# projeto, noutro repositorio e sem a pasta atual. So o nulo passa.
$fora = Join-Path ([System.IO.Path]::GetTempPath()) ("guarda-fora-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $fora | Out-Null
$arquivoFora = Join-Path $fora 'a.dart'
$sumiu = Join-Path ([System.IO.Path]::GetTempPath()) ("guarda-sumiu-" + [guid]::NewGuid().ToString('N'))
Conferir 'git show: caminho absoluto fora de repositorio' 2 (Rodar 'implementador' (Json 'Bash' "git show HEAD:lib/a.dart > `"$arquivoFora`""))
Conferir 'git show: caminho absoluto fora de repositorio, Out-File' 2 (Rodar 'implementador' (Json 'PowerShell' "git show HEAD:lib/a.dart | Out-File -FilePath `"$arquivoFora`""))
Conferir 'git show: caminho absoluto em .revisao/' 2 (Rodar 'implementador' (Json 'PowerShell' "git show HEAD:lib/a.dart | Out-File -FilePath `"$(Join-Path (Join-Path $proj '.revisao') 'a.dart')`""))
Conferir 'git show: caminho absoluto no projeto' 2 (Rodar 'implementador' (Json 'Bash' "git show HEAD:lib/a.dart > `"$arquivoProj`""))
Conferir 'git show: caminho absoluto no projeto, tee' 2 (Rodar 'implementador' (Json 'Bash' "git show HEAD:lib/a.dart | tee `"$arquivoFora`" `"$arquivoProj`""))
Conferir 'git show: caminho absoluto noutro repositorio' 2 (Rodar 'implementador' (Json 'Bash' "git show HEAD:lib/a.dart > `"$(Join-Path $outro 'a.dart')`""))
if ([System.IO.Path]::DirectorySeparatorChar -eq '\') {
    # No Git Bash do Windows, /c/pasta e C:\pasta: o projeto escrito assim continua barrado.
    $projBash = '/' + $proj.Substring(0, 1).ToLowerInvariant() + $proj.Substring(2).Replace('\', '/')
    Conferir 'git show: projeto no formato do Git Bash (/c/...)' 2 (Rodar 'implementador' (Json 'Bash' "git show HEAD:lib/a.dart > `"$projBash/lib/a.dart`""))
}
$semPasta = (@{ tool_name = 'Bash'; tool_input = @{ command = "git show HEAD:lib/a.dart > `"$arquivoFora`"" } } | ConvertTo-Json -Compress)
Conferir 'git show: sem a pasta atual' 2 (Rodar 'implementador' $semPasta)
Conferir 'git show: pasta atual que sumiu, caminho relativo' 2 (Rodar 'implementador' (JsonEm $sumiu 'git show HEAD:lib/a.dart > ../a.dart'))
Conferir 'git show: pasta atual que sumiu, caminho absoluto fora de repositorio' 2 (Rodar 'implementador' (JsonEm $sumiu "git show HEAD:lib/a.dart > `"$arquivoFora`""))
Remove-Item -LiteralPath $outro, $fora -Recurse -Force

# Sessao aberta fora do repositorio (pasta temporaria sem git e sem lista): vale a lista do
# repositorio em que o comando entra com "cd <pasta absoluta> &&", se estiver em commit.
$solta = Join-Path ([System.IO.Path]::GetTempPath()) ("guarda-solta-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $solta | Out-Null
# A sessao "s1" editou o projeto: os hooks da equipe anotam a raiz do repositorio (como o git
# a escreve) em <pasta do Claude>\equipe-diario\estado\s1-sessao.base.
$claudeFalso = Join-Path ([System.IO.Path]::GetTempPath()) ("guarda-claude-" + [guid]::NewGuid().ToString('N'))
$pastaEstado = Join-Path (Join-Path $claudeFalso 'equipe-diario') 'estado'
New-Item -ItemType Directory -Force -Path $pastaEstado | Out-Null
$raizGit = ([string](& git -C $proj rev-parse --show-toplevel 2>$null)).Trim()
[System.IO.File]::WriteAllText((Join-Path $pastaEstado 's1-sessao.base'), (@{ $raizGit = 'abc' } | ConvertTo-Json -Compress), $utf8)
# Verificador com a pasta atual, a pasta do projeto da sessao e a sessao escolhidas.
function RodarVerificador([string]$pastaAtual, [string]$projeto, [string]$comando, [string]$ferramenta = 'Bash', [string]$sessao = 's1') {
    $cmd = "try { & '$guarda' -Perfil verificador; exit `$LASTEXITCODE } catch { exit 2 }"
    $env:CLAUDE_PROJECT_DIR = $projeto
    $env:EQUIPE_PASTA_CLAUDE = $claudeFalso
    $json = (@{ tool_name = $ferramenta; tool_input = @{ command = $comando }; cwd = $pastaAtual; session_id = $sessao } | ConvertTo-Json -Compress)
    $saida = $json | & $exe -NoProfile -ExecutionPolicy Bypass -Command $cmd 2>&1
    $codigo = $LASTEXITCODE
    $script:mensagem = (($saida | ForEach-Object { "$_" }) -join ' ').Trim()
    $env:CLAUDE_PROJECT_DIR = $proj
    Remove-Item Env:\EQUIPE_PASTA_CLAUDE -ErrorAction SilentlyContinue
    return $codigo
}
function RodarSolta([string]$comando, [string]$ferramenta = 'Bash', [string]$sessao = 's1') {
    return (RodarVerificador $solta $solta $comando $ferramenta $sessao)
}
$semLista = Join-Path ([System.IO.Path]::GetTempPath()) ("guarda-semlista-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $semLista | Out-Null
& git -C $semLista init -q 2>$null
Conferir 'fora do repositorio: cd na raiz e comando da lista' 0 (RodarSolta "cd `"$proj`" && flutter test")
Conferir 'fora do repositorio: cd na raiz com argumentos' 0 (RodarSolta "cd `"$proj`" && flutter test test/x_test.dart")
Conferir 'fora do repositorio: cd numa subpasta, como a linha da lista' 0 (RodarSolta "cd $(Join-Path $proj 'app') && flutter test")
Conferir 'fora do repositorio: PowerShell com ;' 0 (RodarSolta "cd `"$proj`"; flutter analyze" 'PowerShell')
Conferir 'fora do repositorio: comando fora da lista' 2 (RodarSolta "cd `"$proj`" && rm -rf build")
Conferir 'fora do repositorio: comando composto depois do cd' 2 (RodarSolta "cd `"$proj`" && flutter test && rm -rf build")
Conferir 'fora do repositorio: cd relativo nao vale' 2 (RodarSolta 'cd app && flutter test')
Conferir 'fora do repositorio: repositorio sem lista' 2 (RodarSolta "cd `"$semLista`" && flutter test")
Conferir 'fora do repositorio: sem cd' 2 (RodarSolta 'flutter test')
Conferir 'fora do repositorio: repositorio que a sessao nao editou' 2 (RodarSolta "cd `"$proj`" && flutter test" 'Bash' 'outra')
Conferir 'fora do repositorio: ; so vale no PowerShell' 2 (RodarSolta "cd `"$proj`"; flutter analyze")

# Sem lista na pasta atual (ou ela ja sumiu): a mensagem diz a pasta do projeto que a sessao
# editou, como rodar de la e as linhas da lista, e o comando sugerido passa. So sem repositorio
# com lista e que a mensagem fala em criar a lista.
# Sempre entre aspas e com barra normal (no Git Bash, a barra invertida some).
$cdProjeto = "cd `"$($raizGit.Replace('\', '/'))`""
$linhasLista = 'Linhas da lista: flutter test | flutter analyze | cd app && flutter test | cd app; flutter test.'
ConferirMensagem 'pasta que sumiu: mensagem com a pasta do projeto e a lista' 2 (RodarVerificador $sumiu $solta 'flutter test') @("a pasta atual ($sumiu) nao existe mais", "$cdProjeto && <linha da lista>", "por exemplo $cdProjeto && flutter test", $linhasLista) @('precisa ser criada')
Conferir 'pasta que sumiu: o comando sugerido passa' 0 (RodarVerificador $sumiu $solta "$cdProjeto && flutter test")
ConferirMensagem 'pasta que sumiu: no PowerShell, com ;' 2 (RodarVerificador $sumiu $solta 'flutter test' 'PowerShell') @("por exemplo $cdProjeto; flutter test")
Conferir 'pasta que sumiu: o comando sugerido no PowerShell passa' 0 (RodarVerificador $sumiu $solta "$cdProjeto; flutter test" 'PowerShell')
ConferirMensagem 'pasta sem lista: mensagem com a pasta do projeto' 2 (RodarSolta 'flutter test') @("nao existe $(Join-Path (Join-Path $solta '.claude') 'verificador-comandos.txt')", "por exemplo $cdProjeto && flutter test", $linhasLista) @('precisa ser criada', 'nao existe mais')
ConferirMensagem 'pasta que sumiu sem projeto com lista: a lista precisa ser criada' 2 (RodarVerificador $sumiu $solta 'flutter test' 'Bash' 'outra') @('precisa ser criada')
ConferirMensagem 'pasta que sumiu sem projeto da sessao: a lista precisa ser criada' 2 (RodarVerificador $sumiu '' 'flutter test' 'Bash' 'outra') @('precisa ser criada')
# Pasta atual que e um repositorio sem a lista: nao manda rodar do projeto da sessao (daria verde
# no lugar errado); o mestre decide no briefing.
ConferirMensagem 'repositorio sem a lista: nao manda rodar de outro projeto' 2 (RodarVerificador $semLista '' 'flutter test') @('esta pasta e um repositorio sem a lista', 'o mestre diz isso no briefing') @('<linha da lista>', 'precisa ser criada')
Conferir 'repositorio sem a lista: com o cd do briefing, passa' 0 (RodarVerificador $semLista '' "$cdProjeto && flutter test")
# O caminho do cd com barra normal (como o contexto do verificador escreve) vale igual.
Conferir 'lista do projeto: cd com barra normal' 0 (RodarVerificador $sumiu $proj "cd `"$($proj.Replace('\', '/'))`" && flutter test")
# Repositorio editado com a lista fora do git: o cd nao valeria, entao a mensagem pede o commit.
$naoCommit = Join-Path ([System.IO.Path]::GetTempPath()) ("guarda-naocommit-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path (Join-Path $naoCommit '.claude') | Out-Null
[System.IO.File]::WriteAllText((Join-Path $naoCommit '.claude\verificador-comandos.txt'), "flutter test`n", $utf8)
& git -C $naoCommit init -q 2>$null
$raizNaoCommit = ([string](& git -C $naoCommit rev-parse --show-toplevel 2>$null)).Trim()
[System.IO.File]::WriteAllText((Join-Path $pastaEstado 's2-sessao.base'), (@{ $raizNaoCommit = 'abc' } | ConvertTo-Json -Compress), $utf8)
ConferirMensagem 'pasta que sumiu, lista do projeto fora do git: commit pelo mestre' 2 (RodarVerificador $sumiu $solta 'flutter test' 'Bash' 's2') @('nao esta em commit') @('precisa ser criada', '<linha da lista>')
Remove-Item -LiteralPath $naoCommit -Recurse -Force

# Lista em vigor de outra pasta (a do projeto da sessao, com a pasta atual fora dele ou que
# sumiu): "cd <pasta da lista> && <linha>" passa; cd para outra pasta continua barrado.
Conferir 'lista do projeto: cd para a pasta da lista' 0 (RodarVerificador $sumiu $proj "cd `"$proj`" && flutter test")
Conferir 'lista do projeto: cd com argumentos a mais' 0 (RodarVerificador $sumiu $proj "cd `"$proj`" && flutter test test/x_test.dart")
Conferir 'lista do projeto: cd com barra no fim, pasta atual sem git' 0 (RodarVerificador $solta $proj "cd `"$proj/`" && flutter analyze")
Conferir 'lista do projeto: cd e linha da lista que tem cd' 0 (RodarVerificador $sumiu $proj "cd `"$proj`" && cd app && flutter test")
Conferir 'lista do projeto: PowerShell com ;' 0 (RodarVerificador $sumiu $proj "cd `"$proj`"; flutter analyze" 'PowerShell')
Conferir 'lista do projeto: ; so vale no PowerShell' 2 (RodarVerificador $sumiu $proj "cd `"$proj`"; flutter analyze")
Conferir 'lista do projeto: cd para outro repositorio continua barrado' 2 (RodarVerificador $sumiu $proj "cd `"$semLista`" && flutter test")
Conferir 'lista do projeto: cd para pasta sem git continua barrado' 2 (RodarVerificador $sumiu $proj "cd `"$solta`" && flutter test")
Conferir 'lista do projeto: cd para subpasta da lista nao vale' 2 (RodarVerificador $sumiu $proj "cd `"$(Join-Path $proj 'app')`" && flutter test")
Conferir 'lista do projeto: cd relativo nao vale' 2 (RodarVerificador $sumiu $proj 'cd . && flutter test')
Conferir 'lista do projeto: comando fora da lista depois do cd' 2 (RodarVerificador $sumiu $proj "cd `"$proj`" && rm -rf build")
Conferir 'lista do projeto: comando composto depois do cd' 2 (RodarVerificador $sumiu $proj "cd `"$proj`" && flutter test && rm -rf build")
$estranho = Join-Path ([System.IO.Path]::GetTempPath()) ('guarda-r$(id)-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $estranho | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $estranho '.claude') | Out-Null
[System.IO.File]::WriteAllText((Join-Path $estranho '.claude\verificador-comandos.txt'), "flutter test`n", $utf8)
& git -C $estranho init -q 2>$null
& git -C $estranho -c user.email=t@t -c user.name=t add .claude/verificador-comandos.txt 2>$null
& git -C $estranho -c user.email=t@t -c user.name=t commit -q -m lista 2>$null
$raizEstranho = ([string](& git -C $estranho rev-parse --show-toplevel 2>$null)).Trim()
[System.IO.File]::WriteAllText((Join-Path $pastaEstado 's1-sessao.base'), (@{ $raizGit = 'abc'; $raizEstranho = 'def' } | ConvertTo-Json -Compress), $utf8)
Conferir 'fora do repositorio: caminho com $( ) nao vale' 2 (RodarSolta "cd `"$estranho`" && flutter test")
# So esse repositorio tem lista: a mensagem nao sugere um cd que a guarda recusaria.
[System.IO.File]::WriteAllText((Join-Path $pastaEstado 's3-sessao.base'), (@{ $raizEstranho = 'def' } | ConvertTo-Json -Compress), $utf8)
ConferirMensagem 'pasta que sumiu, projeto com caminho com $( ): reporte' 2 (RodarVerificador $sumiu $solta 'flutter test' 'Bash' 's3') @('nao aceita cd') @('<linha da lista>', 'precisa ser criada')
Remove-Item -LiteralPath $estranho -Recurse -Force
Conferir 'com lista no projeto: cd noutro repositorio nao troca a lista' 2 (Rodar 'verificador' (Json 'Bash' "cd `"$semLista`" && flutter test"))
Remove-Item -LiteralPath $solta, $semLista, $claudeFalso -Recurse -Force

Remove-Item -LiteralPath $lista
Conferir 'lista do verificador ausente' 2 (Rodar 'verificador' (Json 'Bash' 'flutter test'))

Remove-Item -LiteralPath $proj -Recurse -Force
Write-Host "PowerShell $($PSVersionTable.PSVersion): $($total - $falhas) de $total casos certos."
if ($falhas -gt 0) { exit 1 }
exit 0
