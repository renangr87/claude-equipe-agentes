<#
.SYNOPSIS
  Guarda de terminal dos subagentes Explore, verificador e implementador (hook PreToolUse).

.DESCRIPTION
  O Claude Code chama este script antes de cada comando de terminal do subagente
  e entrega o JSON da chamada pela entrada padrao.

  Saida 0: o comando segue o fluxo normal de permissoes.
  Saida 2: o comando e bloqueado e a mensagem vai para o subagente.

  Qualquer erro, inclusive entrada vazia ou invalida, tambem sai com 2. Com saida 1
  o Claude Code deixaria o comando passar. Os agentes chamam este script por dentro
  de um try/catch que sai com 2 se o script nem chegar a rodar.

  Perfis:
    explore        so historico e estado do git: log, blame, show, diff, status, ls-files.
    verificador    so os comandos listados em .claude/verificador-comandos.txt, e so se essa
                   lista nao tiver mudanca fora de commit. Vale a lista do repositorio da
                   pasta atual (worktree) quando ela esta no git; senao, a do projeto.
                   Cada linha libera o comando exato e o mesmo comando com argumentos a mais,
                   tambem depois de "cd <pasta da lista> &&". Sem lista (pasta que sumiu ou
                   fora de repositorio), a mensagem diz de qual pasta rodar (o repositorio com
                   lista que a sessao editou); num repositorio sem lista, devolve ao mestre.
    implementador  terminal livre, menos formatadores: so passam com arquivos nomeados um
                   a um. Pasta, '.', curinga, variavel ou nenhum arquivo sao bloqueados,
                   em qualquer parte de um comando composto. Scripts de formatacao
                   (npm run format e parecidos) sao bloqueados. Tambem bloqueia o git que
                   descarta trabalho (checkout, restore, reset, stash, clean, switch,
                   read-tree, archive, apply -R, worktree remove --force), git show/cat-file
                   gravado em qualquer arquivo (so o nulo passa) e os comandos que alteram o banco
                   remoto ou apagam dados (supabase db push, psql, prisma migrate reset...).
                   E bloqueia acao sem volta: git que grava historico ou mexe no remoto
                   (commit, push, merge, pull...), instalar dependencia nova (npm install
                   pacote, pip install pacote, flutter pub add...) e apagar pasta inteira
                   (rm -r, Remove-Item -Recurse, rd /s).

  Compativel com Windows PowerShell 5.1 e PowerShell 7. Os casos de teste ficam em
  testes/casos-guarda.txt.

.PARAMETER Perfil
  explore, verificador ou implementador.
#>
param([string]$Perfil = '')

function Bloquear([string]$motivo) {
    [Console]::Error.WriteLine("Bloqueado pela guarda ($Perfil): $motivo")
    exit 2
}

# Explore e verificador: encadeamento, redirecionamento, subcomando e variavel nao
# sao permitidos fora do texto que uma linha da lista ja traz.
$operadores = '[;&|<>`$(){}]'

# Formatadores. nome: o programa. sub: o subcomando que precisa vir logo depois ($null:
# nenhum). escrita: a opcao que faz gravar, quando o padrao do programa e so conferir
# ($null: grava sempre).
$formatadores = @(
    @{ nome = 'dart';         sub = '^format$';               escrita = $null },
    @{ nome = 'flutter';      sub = '^format$';               escrita = $null },
    @{ nome = 'dart';         sub = '^fix$';                  escrita = '^--apply$' },
    @{ nome = 'prettier';     sub = $null;                    escrita = '^(--write|-w)$' },
    @{ nome = 'eslint';       sub = $null;                    escrita = '^--fix$' },
    @{ nome = 'stylelint';    sub = $null;                    escrita = '^--fix$' },
    @{ nome = 'biome';        sub = '^(format|check|lint)$';  escrita = '^--(write|apply|apply-unsafe|fix)$' },
    @{ nome = 'black';        sub = $null;                    escrita = $null },
    @{ nome = 'ruff';         sub = '^format$';               escrita = $null },
    @{ nome = 'ruff';         sub = '^check$';                escrita = '^--fix$' },
    @{ nome = 'isort';        sub = $null;                    escrita = $null },
    @{ nome = 'autopep8';     sub = $null;                    escrita = '^(-i|--in-place)$' },
    @{ nome = 'yapf';         sub = $null;                    escrita = '^(-i|--in-place)$' },
    @{ nome = 'gofmt';        sub = $null;                    escrita = '^-w$' },
    @{ nome = 'goimports';    sub = $null;                    escrita = '^-w$' },
    @{ nome = 'go';           sub = '^fmt$';                  escrita = $null },
    @{ nome = 'cargo';        sub = '^fmt$';                  escrita = $null },
    @{ nome = 'rustfmt';      sub = $null;                    escrita = $null },
    @{ nome = 'dotnet';       sub = '^format$';               escrita = $null },
    @{ nome = 'clang-format'; sub = $null;                    escrita = '^-i$' },
    @{ nome = 'swiftformat';  sub = $null;                    escrita = $null },
    @{ nome = 'ktlint';       sub = $null;                    escrita = '^(-F|--format)$' },
    @{ nome = 'rubocop';      sub = $null;                    escrita = '^(-a|-A|-x|--autocorrect|--autocorrect-all|--fix-layout)$' },
    @{ nome = 'php-cs-fixer'; sub = '^fix$';                  escrita = $null },
    @{ nome = 'terraform';    sub = '^fmt$';                  escrita = $null },
    @{ nome = 'shfmt';        sub = $null;                    escrita = '^-w$' }
)
$nomesFormatadores = @($formatadores | ForEach-Object { $_.nome } | Select-Object -Unique)

# Opcoes que deixam o formatador so conferindo, sem gravar.
$soConferencia = '^(--check|-check|--diff|--dry-run|--verify-no-changes|--list-different|--output=none|-o=none)$'

# Scripts que rodam o formatador do projeto inteiro.
$scriptsFormatacao = '(^| )((npm|pnpm|yarn|bun)( run)? (format|fmt|prettier|lint:fix|fix)|make (format|fmt)|melos (run )?format|just (format|fmt))( |$)'

# Comandos cujo texto e dado, nao execucao (mensagem de commit, busca, eco).
$comandosDeTexto = '^(git|grep|egrep|fgrep|rg|ag|findstr|select-string|sls|echo|printf|write-output|write-host|cat|type|get-content|gc|head|tail|less|more|wc|ls|dir|gci|get-childitem)$'

# Comandos que executam outro programa a partir de texto.
$executores = '^(start-process|saps|start|iex|invoke-expression)$'

# Valores de opcao que nao sao caminho: numero, codigo em maiusculas, chave=valor.
$valorDeOpcao = '^(\d+|[A-Z][A-Z0-9,]*|[^\\/=]+=[^\\/]*)$'

# Extensao dos arquivos de cada formatador, para o exemplo das mensagens.
$extensoes = @{ dart = 'dart'; flutter = 'dart'; prettier = 'ts'; eslint = 'ts'; stylelint = 'css'; biome = 'ts'
    black = 'py'; ruff = 'py'; isort = 'py'; autopep8 = 'py'; yapf = 'py'; gofmt = 'go'; goimports = 'go'; go = 'go'
    cargo = 'rs'; rustfmt = 'rs'; dotnet = 'cs'; 'clang-format' = 'cpp'; swiftformat = 'swift'; ktlint = 'kt'
    rubocop = 'rb'; 'php-cs-fixer' = 'php'; terraform = 'tf'; shfmt = 'sh' }

# Exemplo de chamada certa: o formatador com dois arquivos do tipo dele, nomeados um a um.
function Exemplo-Formatador([string]$chamada, [string]$nome) {
    $fim = ', com os arquivos que voce editou (git status --short mostra quais sao).'
    # cargo fmt nao recebe arquivos (o rustfmt recebe); dotnet format, so com --include.
    if ($nome -eq 'cargo') { return " Exemplo: rustfmt src/a.rs src/b.rs$fim" }
    if ($nome -eq 'dotnet') { return " Exemplo: dotnet format --include src/a.cs src/b.cs$fim" }
    $ext = $extensoes[$nome]
    $pasta = 'src'
    if ($ext -eq 'dart') { $pasta = 'lib' }
    return " Exemplo: $chamada $pasta/a.$ext $pasta/b.$ext$fim"
}

function Nome-Programa([string]$token) {
    $base = ($token -split '[\\/]')[-1].ToLowerInvariant()
    return ($base -replace '\.(exe|bat|cmd|ps1)$', '')
}

function Separar-Tokens([string]$texto) {
    $limpo = $texto -replace '[{}(),]', ' '
    $lista = @()
    foreach ($m in [regex]::Matches($limpo, '"[^"]*"|''[^'']*''|\S+')) {
        $t = $m.Value -replace '["'']', ''
        if ($t) { $lista += $t }
    }
    return ,$lista
}

# Comando dentro de $(...), <(...), >(...), @(...), (...) ou de crases roda mesmo dentro de
# echo, de cat e de Write-Output (no PowerShell, "Write-Output (git push)" roda o git): o texto de
# dentro de cada um.
function Comandos-Embutidos([string]$texto) {
    $r = @()
    foreach ($m in [regex]::Matches($texto, '[$<>@]?\(([^()]*)\)|`([^`]+)`')) {
        if ($m.Groups[1].Success) { $r += $m.Groups[1].Value } else { $r += $m.Groups[2].Value }
    }
    return ,$r
}

# Partes do comando separadas por &&, ||, ;, &, | e quebra de linha, de dois jeitos, e quem chama
# confere todas: barra se qualquer uma barrar. Fora de aspas, o ";" de "a.b=x;y" nao separa
# (git -c "a.b=x;y" checkout -- x e um comando so). A divisao simples, que ignora as aspas, pega
# o que uma aspa escapada (\") ou um apostrofo num comentario esconderiam da outra.
function Dividir-Partes([string]$texto) {
    $partes = New-Object System.Collections.Generic.List[string]
    foreach ($p in ($texto -split '&&|\|\||[;&|\r\n]')) { $partes.Add($p) }
    $atual = New-Object System.Text.StringBuilder
    $aspas = [char]0
    foreach ($c in $texto.ToCharArray()) {
        if ($aspas -ne [char]0) {
            if ($c -eq $aspas) { $aspas = [char]0 }
            [void]$atual.Append($c)
        } elseif ($c -eq [char]'"' -or $c -eq [char]"'") {
            $aspas = $c
            [void]$atual.Append($c)
        } elseif ($c -eq [char]';' -or $c -eq [char]'&' -or $c -eq [char]'|' -or $c -eq [char]"`r" -or $c -eq [char]"`n") {
            $partes.Add($atual.ToString())
            [void]$atual.Clear()
        } else {
            [void]$atual.Append($c)
        }
    }
    $partes.Add($atual.ToString())
    return ,$partes.ToArray()
}

# Programas que executam o texto que recebem entre aspas (bash -c "...", iex '...').
$avaliadores = '^(bash|sh|zsh|dash|cmd|powershell|pwsh|iex|invoke-expression|start-process|saps|xargs|sudo|env|nohup|watch)$'

# Tira redirecionamentos (2>&1, > arquivo, < arquivo): o alvo nao e argumento do comando.
function Tirar-Redirecionamentos([string]$texto) {
    $semRedir = $texto -replace '(\*|\d)?>&\d+', ' '
    $semRedir = $semRedir -replace '(\*|\d)?>>?\s*("[^"]*"|''[^'']*''|[^\s;&|]+)', ' '
    return ($semRedir -replace '<\s*("[^"]*"|''[^'']*''|[^\s;&|]+)', ' ')
}

function Testar-Formatadores([string]$texto, [string]$pastaAtual) {
    # Tira redirecionamentos antes de separar as partes.
    $semRedir = Tirar-Redirecionamentos $texto

    foreach ($parte in (Dividir-Partes $semRedir)) {
        $seg = ($parte -replace '\s+', ' ').Trim()
        if (-not $seg) { continue }
        if ($seg -match $scriptsFormatacao) {
            $exemplo = Exemplo-Formatador 'dart format' 'dart'
            if ($seg -match '(^| )(npm|pnpm|yarn|bun) ') { $exemplo = Exemplo-Formatador 'npx prettier --write' 'prettier' }
            Bloquear "script de formatacao ('$seg') formata o projeto inteiro. Rode o formatador direto, so com os arquivos que voce alterou.$exemplo"
        }
        $tokens = Separar-Tokens $seg
        if ($tokens.Count -eq 0) { continue }
        $nomes = @($tokens | ForEach-Object { Nome-Programa $_ })

        if (@($nomes | Where-Object { $_ -match $executores }).Count -gt 0 -and
            @($nomes | Where-Object { $nomesFormatadores -contains $_ }).Count -gt 0) {
            Bloquear ("formatador chamado por Start-Process ou Invoke-Expression. Rode o formatador direto, so com os arquivos que voce alterou." + (Exemplo-Formatador 'dart format' 'dart'))
        }

        $primeiroEhTexto = $nomes[0] -match $comandosDeTexto
        if (-not $primeiroEhTexto) {
            # Texto entre aspas pode ser outro comando (bash -c "...", iex '...').
            foreach ($t in $tokens) {
                if ($t -match '\s') { Testar-Formatadores $t $pastaAtual }
            }
        }
        for ($i = 0; $i -lt $tokens.Count; $i++) {
            if ($i -gt 0 -and $primeiroEhTexto) { break }
            foreach ($f in $formatadores) {
                if ($nomes[$i] -ne $f.nome) { continue }
                $inicio = $i + 1
                if ($f.sub) {
                    if ($inicio -ge $tokens.Count -or $tokens[$inicio] -notmatch $f.sub) { continue }
                    $inicio++
                }
                $args_ = @()
                if ($inicio -lt $tokens.Count) { $args_ = @($tokens[$inicio..($tokens.Count - 1)]) }

                if ($f.escrita) {
                    if (@($args_ | Where-Object { $_ -cmatch $f.escrita }).Count -eq 0) { continue }
                } else {
                    $conferindo = @($args_ | Where-Object { $_ -match $soConferencia }).Count -gt 0
                    for ($k = 0; $k -lt $args_.Count - 1; $k++) {
                        if ($args_[$k] -match '^(-o|--output)$' -and $args_[$k + 1] -eq 'none') { $conferindo = $true }
                    }
                    if ($conferindo) { continue }
                }

                # A chamada como ela deve ficar, para o exemplo: dart format, prettier --write...
                $chamada = $nomes[$i]
                if ($f.sub) { $chamada += ' ' + $tokens[$i + 1] }
                if ($f.escrita) { $chamada += ' ' + @($args_ | Where-Object { $_ -cmatch $f.escrita })[0] }
                $exemplo = Exemplo-Formatador $chamada $f.nome
                # cargo fmt formata o projeto todo mesmo com argumentos (--manifest-path), e
                # dotnet format sem --include formata o projeto ou a solucao que recebe.
                if ($f.nome -eq 'cargo') {
                    Bloquear "cargo fmt formata o projeto inteiro (nao recebe arquivos, nem com --manifest-path).$exemplo"
                }
                if ($f.nome -eq 'dotnet' -and @($args_ | Where-Object { $_ -match '^--include(=.*)?$' }).Count -eq 0) {
                    Bloquear "dotnet format sem --include formata o projeto ou a solucao inteira.$exemplo"
                }

                $arquivos = 0
                foreach ($t in $args_) {
                    # --include=arquivo (dotnet format): o valor e o arquivo.
                    if ($t -match '^--include=(.+)$') { $t = $Matches[1] }
                    if ($t.StartsWith('-')) { continue }
                    if ($t -cmatch $valorDeOpcao) { continue }
                    $ehArquivo = ($t -notmatch '[*?$\[\]]') -and
                                 ($t -match '\.[A-Za-z0-9_]+$') -and
                                 ($t -notmatch '(^|[\\/])\.\.?$') -and
                                 ($t -notmatch '[\\/]$')
                    if ($ehArquivo) {
                        try {
                            $alvo = $t
                            if ($pastaAtual -and -not [System.IO.Path]::IsPathRooted($t)) { $alvo = Join-Path $pastaAtual $t }
                            if (Test-Path -LiteralPath $alvo -PathType Container) { $ehArquivo = $false }
                        } catch { }
                    }
                    if (-not $ehArquivo) {
                        Bloquear "o formatador so pode receber arquivos, um a um. '$t' nao e um arquivo. Formate so os arquivos que voce alterou.$exemplo"
                    }
                    $arquivos++
                }
                if ($arquivos -eq 0) {
                    Bloquear "formatador sem arquivo formata a pasta inteira. Passe so os arquivos que voce alterou.$exemplo"
                }
            }
        }
    }
}

# Git que descarta trabalho nao commitado ou troca o que esta na pasta (so o mestre, com o
# OK do usuario).
$gitDescarte = '^(checkout|checkout-index|restore|reset|stash|clean|switch|read-tree)$'
# Opcoes do git que levam um valor no token seguinte.
$gitOpcaoComValor = '^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env)$'

# Posicao do subcomando do git que esta na posicao $i (pula as opcoes globais e seus
# valores); -1 se nao ha subcomando.
function Indice-SubGit([string[]]$tokens, [int]$i) {
    $j = $i + 1
    while ($j -lt $tokens.Count -and $tokens[$j].StartsWith('-')) {
        if ($tokens[$j] -cmatch $gitOpcaoComValor) { $j++ }
        $j++
    }
    if ($j -ge $tokens.Count) { return -1 }
    return $j
}

# Os tokens a partir de $desde; nenhum quando $desde passa do fim (o intervalo a..b do
# PowerShell anda para tras quando a > b).
function Tokens-Desde([string[]]$tokens, [int]$desde) {
    if ($desde -ge $tokens.Count) { return @() }
    return @($tokens[$desde..($tokens.Count - 1)])
}

# git checkout de um arquivo, e nao de um branch: com --, -p, versao e caminho, ou um caminho
# que existe.
function Checkout-DeArquivo([string[]]$tokens, [int]$j, [string]$pastaAtual) {
    $posicionais = @()
    for ($k = $j + 1; $k -lt $tokens.Count; $k++) {
        $t = $tokens[$k]
        if ($t -ceq '--' -or $t -cmatch '^(-p|--patch|--pathspec-from-file=.*)$') { return $true }
        if ($t -cmatch '^(-b|-B|--orphan|--detach|-)$') { return $false }
        if ($t.StartsWith('-') -or $t -match '[<>]') { continue }
        $posicionais += $t
    }
    if ($posicionais.Count -ge 2) { return $true }
    if ($posicionais.Count -eq 1) {
        try {
            $alvo = $posicionais[0]
            # Caminho de rede (\\servidor, //servidor): o Test-Path pode passar do tempo do hook.
            if ($alvo -match '^(\\\\|//)') { return $true }
            if ($pastaAtual -and -not [System.IO.Path]::IsPathRooted($alvo)) { $alvo = [System.IO.Path]::Combine($pastaAtual, $alvo) }
            if (Test-Path -LiteralPath $alvo) { return $true }
        } catch { }
    }
    return $false
}

# O que fazer no lugar do git que descarta trabalho.
function Mensagem-Descarte([string]$sub, [string[]]$tokens, [int]$j, [string]$pastaAtual) {
    if ($sub -eq 'archive') {
        return "git archive com tar -x refaz arquivos a partir de uma versao antiga e apaga o trabalho nao commitado. Para ver a versao anterior, git show HEAD:<arquivo>, sem gravar; para rodar o teste nela, git worktree add <pasta temporaria fora do projeto> HEAD."
    }
    if ($sub -eq 'stash') {
        return "git stash esconde o trabalho nao commitado, o seu e o de outros agentes. Para saber se uma falha ja existia antes da mudanca sem esconder nada: git worktree add <pasta temporaria fora do projeto> HEAD, rode o teste la e depois git worktree remove <pasta>. Ou relate a falha como 'talvez anterior a mudanca'."
    }
    $deArquivo = ($sub -eq 'restore' -or $sub -eq 'checkout-index')
    if ($sub -eq 'checkout') { $deArquivo = Checkout-DeArquivo $tokens $j $pastaAtual }
    if ($deArquivo) {
        return "git $sub refaz o arquivo a partir de uma versao antiga e apaga o trabalho nao commitado, o seu e o de outros agentes. Para desfazer uma mudanca sua, edite o arquivo de volta (ferramenta Edit) olhando git diff HEAD -- <arquivo>. Para ver a versao anterior, git show HEAD:<arquivo>, sem gravar."
    }
    return "git $sub descarta ou troca trabalho nao commitado. Nao use: relate ao mestre o que precisa voltar, e ele decide com o usuario."
}

# Programas e cmdlets que gravam a entrada em arquivo (sc e ac: apelidos no Windows PowerShell).
$gravadores = '^(out-file|set-content|sc|add-content|ac|tee-object|tee|sponge)$'
# Opcoes deles cujo valor e o caminho, e opcoes cujo valor nao e (estas com 2 letras ou mais;
# PowerShell aceita o comeco do nome).
$opcoesCaminho = @('filepath', 'path', 'literalpath', 'pspath', 'lp')
$opcoesValor = @('encoding', 'width', 'value', 'stream', 'inputobject', 'variable', 'erroraction', 'ea', 'warningaction', 'wa', 'errorvariable', 'ev', 'outvariable', 'ov')
# Destinos em que o comando grava: o alvo de cada >, >>, 2>, &> e os arquivos de Out-File,
# Set-Content, Add-Content, Tee-Object e tee, com aspas. '' quando o alvo falta.
function Destinos-Gravacao([string]$texto) {
    $destinos = @()
    # 2>&1, >&2 e 2>&- so juntam ou fecham saidas.
    $semJuncao = $texto -replace '(\*|\d)?>&(\d+|-)', ' '
    foreach ($m in [regex]::Matches($semJuncao, '(\*|\d|&)?>>?\|?[ \t]*((?:"[^"]*"|''[^'']*''|[^\s;&|<>)"''])*)')) {
        $destinos += $m.Groups[2].Value
    }
    foreach ($parte in (Dividir-Partes $texto)) {
        $tokens = @([regex]::Matches($parte, '(?:"[^"]*"|''[^'']*''|[^\s"''])+') | ForEach-Object { $_.Value })
        for ($i = 0; $i -lt $tokens.Count; $i++) {
            # dd grava no of=.
            if ((Nome-Programa ($tokens[$i] -replace '["'']', '')) -eq 'dd') {
                foreach ($t in $tokens) { if ($t -match '^["'']?of=(.*)$') { $destinos += $Matches[1] } }
                break
            }
            if ((Nome-Programa ($tokens[$i] -replace '["'']', '')) -notmatch $gravadores) { continue }
            for ($k = $i + 1; $k -lt $tokens.Count; $k++) {
                $t = $tokens[$k]
                if (-not $t.StartsWith('-')) { $destinos += $t; continue }
                # --append, -a e outras opcoes sem valor ficam de fora.
                if (-not ($t -match '^-([A-Za-z]+)(:(.*))?$')) { continue }
                $op = $Matches[1].ToLowerInvariant()
                $junto = $Matches[2]
                $valor = $Matches[3]
                $ehCaminho = @($opcoesCaminho | Where-Object { $_.StartsWith($op, [System.StringComparison]::Ordinal) }).Count -gt 0
                $ehValor = ($op.Length -ge 2) -and (@($opcoesValor | Where-Object { $_.StartsWith($op, [System.StringComparison]::Ordinal) }).Count -gt 0)
                if ($ehCaminho) {
                    if ($junto) { $destinos += $valor }
                    elseif ($k + 1 -lt $tokens.Count) { $k++; $destinos += $tokens[$k] }
                    else { $destinos += '' }
                } elseif ($ehValor -and -not $junto) {
                    $k++
                }
            }
            break
        }
    }
    return $destinos
}

# O nulo: /dev/null, e $null e NUL no PowerShell. No Git Bash do Windows, > NUL cria um arquivo
# "nul" de verdade, dificil de apagar.
function Destino-Nulo([string]$bruto) {
    if ($bruto -match '^\$null$') { return $true }
    $d = $bruto -replace '["'']', ''
    if ($d -ceq '/dev/null') { return $true }
    return ($ferramenta -eq 'PowerShell' -and $d -match '^nul$')
}

$semGravarShow = 'Para ver a versao anterior, git show HEAD:<arquivo> ou git diff HEAD -- <arquivo>, sem gravar: a saida volta para voce. Para rodar o teste na versao anterior, git worktree add <pasta temporaria fora do projeto> HEAD e rode la.'

# git show/cat-file com a saida gravada em qualquer arquivo (menos o nulo): refaz um arquivo a
# partir de uma versao antiga. Barra sem olhar onde: o destino cai no projeto de muitas formas
# (cd antes, link, lista de arquivos, copia depois).
$copiadores = '^(cp|mv|install|rsync|ditto|copy-item|cpi|copy|move-item|mi|move)$'
$destinosPorComando = @{}
function Testar-GravacaoGit([string]$sub, [string[]]$tokens, [int]$j, [string]$completo) {
    if (-not $destinosPorComando.ContainsKey($completo)) {
        $copia = $false
        foreach ($parte in (Dividir-Partes $completo)) {
            foreach ($t in (Separar-Tokens $parte)) { if ((Nome-Programa $t) -match $copiadores) { $copia = $true } }
        }
        $destinosPorComando[$completo] = @{ destinos = @(Destinos-Gravacao $completo); copia = $copia }
    }
    $calculo = $destinosPorComando[$completo]
    # cp ou mv no mesmo comando leva a versao antiga para o arquivo (cp <(git show ...) x,
    # git show ... | cp /dev/stdin x).
    if ($calculo.copia) {
        Bloquear "git $sub com cp ou mv no mesmo comando pode refazer um arquivo a partir de uma versao antiga e apagar o trabalho de outros agentes. $semGravarShow"
    }
    $destinos = @($calculo.destinos)
    # --output do proprio git tambem grava, e esvazia o arquivo antes.
    for ($k = $j + 1; $k -lt $tokens.Count; $k++) {
        if ($tokens[$k] -cmatch '^--output=(.*)$') { $destinos += $Matches[1] }
        elseif ($tokens[$k] -ceq '--output') {
            if ($k + 1 -lt $tokens.Count) { $destinos += $tokens[$k + 1] } else { $destinos += '' }
        }
    }
    foreach ($d in $destinos) {
        if (-not (Destino-Nulo $d)) {
            Bloquear "git $sub com a saida gravada em arquivo ('$d') refaz um arquivo a partir de uma versao antiga e pode apagar o trabalho de outros agentes. $semGravarShow"
        }
    }
}

# $completo: o comando inteiro, para achar onde a saida vai parar mesmo com o git dentro de
# $(...) ou de bash -c "...".
function Testar-Descarte([string]$texto, [string]$pastaAtual, [string]$completo = '') {
    if (-not $completo) { $completo = $texto }
    foreach ($dentro in (Comandos-Embutidos $texto)) { if ($dentro.Trim()) { Testar-Descarte $dentro $pastaAtual $completo } }

    foreach ($parte in (Dividir-Partes $texto)) {
        $seg = ($parte -replace '\s+', ' ').Trim()
        if (-not $seg) { continue }
        $tokens = Separar-Tokens $seg
        if ($tokens.Count -eq 0) { continue }
        $nomes = @($tokens | ForEach-Object { Nome-Programa $_ })

        if ($nomes[0] -ne 'git' -and $nomes[0] -match $comandosDeTexto) { continue }
        if ($nomes[0] -ne 'git') {
            # Texto entre aspas pode ser outro comando (bash -c "...").
            foreach ($t in $tokens) {
                if ($t -match '\s') { Testar-Descarte $t $pastaAtual $completo }
            }
        }
        for ($i = 0; $i -lt $tokens.Count; $i++) {
            if ($nomes[$i] -ne 'git') { continue }
            $j = Indice-SubGit $tokens $i
            if ($j -lt 0) { break }
            $sub = $tokens[$j].ToLowerInvariant()
            if ($sub -match $gitDescarte) {
                Bloquear (Mensagem-Descarte $sub $tokens $j $pastaAtual)
            }
            $depois = @(Tokens-Desde $tokens ($j + 1))
            # git apply -R desfaz a mudanca nos arquivos: o mesmo que descartar.
            # O git aceita opcao abreviada (--rev) e agrupada (-Rp1).
            if ($sub -eq 'apply' -and @($depois | Where-Object { $_ -cmatch '^(-[^-]*R|--rev(e(r(s(e)?)?)?)?$)' }).Count -gt 0) {
                Bloquear "git apply -R desfaz a mudanca nos arquivos e apaga o trabalho nao commitado, o seu e o de outros agentes. Para desfazer uma mudanca sua, edite o arquivo de volta (ferramenta Edit) olhando git diff HEAD -- <arquivo>."
            }
            # git worktree remove --force apaga a pasta com o trabalho nao commitado de quem esta nela.
            if ($sub -eq 'worktree' -and $depois.Count -gt 0 -and $depois[0] -match '^(remove|rm)$' -and
                @($depois | Where-Object { $_ -cmatch '^(--f(o(r(c(e)?)?)?)?|-[A-Za-z]*f[A-Za-z]*)$' }).Count -gt 0) {
                Bloquear "git worktree remove --force apaga a pasta do worktree com o trabalho nao commitado de quem estiver nela. Sem --force, o git so remove o worktree limpo; se ele recusar, relate ao mestre."
            }
            # git archive extraido (tar, unzip) refaz arquivos a partir de uma versao antiga; o
            # arquivo .zip ou .tar sozinho, nao.
            if ($sub -eq 'archive' -and $completo -match '(?i)(^|[\s|;&(])(tar|bsdtar|unzip|7z|expand-archive)(\.exe)?([\s;&|)]|$)') {
                Bloquear (Mensagem-Descarte $sub $tokens $j $pastaAtual)
            }
            if ($sub -eq 'show' -or $sub -eq 'cat-file') {
                Testar-GravacaoGit $sub $tokens $j $completo
            }
            break
        }
    }
}

# Comandos de terminal que alteram o banco remoto ou apagam dados (so o mestre, com o OK do
# usuario). O texto comparado comeca no programa, em minusculas: "supabase db push --linked".
# O implementador escreve a migracao; quem aplica e o mestre.
# ( -\S+( [^-\s]\S*)?)* pula opcoes globais, com ou sem valor (--workdir pasta, --debug).
$bancoSempre = '^(supabase( -\S+( [^-\s]\S*)?)* (db (push|remote)|migration (repair|squash)|functions (deploy|delete)|secrets (set|unset)|projects (create|delete)|branches (create|delete|update|pause)|storage (rm|mv|cp))|psql|dropdb|pg_restore|prisma( -\S+( [^-\s]\S*)?)* (migrate (reset|deploy|resolve)|db (push|execute))|drizzle-kit (push|drop|migrate))( |$)'
# Estes so mexem no banco local, a menos que apontem para o remoto.
$bancoRemoto = '^supabase( -\S+( [^-\s]\S*)?)* (db reset|migration (up|down))( .*)? --?(linked|db-url|project-ref)( |=|$)'
$programasBanco = '^(supabase|psql|dropdb|pg_restore|prisma|drizzle-kit)$'

function Testar-Banco([string]$texto) {
    foreach ($dentro in (Comandos-Embutidos $texto)) { if ($dentro.Trim()) { Testar-Banco $dentro } }
    foreach ($parte in (Dividir-Partes $texto)) {
        $seg = ($parte -replace '\s+', ' ').Trim()
        if (-not $seg) { continue }
        $tokens = Separar-Tokens $seg
        if ($tokens.Count -eq 0) { continue }
        # Versao no nome (npx supabase@latest) nao muda o programa.
        $nomes = @($tokens | ForEach-Object { (Nome-Programa $_) -replace '(?<=.)@[^@]*$', '' })
        # Mensagem de commit, busca e eco so citam o comando.
        if ($nomes[0] -match $comandosDeTexto) { continue }
        foreach ($t in $tokens) {
            # Texto entre aspas pode ser outro comando (bash -c "...").
            if ($t -match '\s') { Testar-Banco $t }
        }
        for ($i = 0; $i -lt $tokens.Count; $i++) {
            if ($nomes[$i] -notmatch $programasBanco) { continue }
            $resto = @()
            # Caminho entre aspas com espaco ("C:\Meus Projetos") continua uma palavra so.
            if ($i + 1 -lt $tokens.Count) { $resto = @($tokens[($i + 1)..($tokens.Count - 1)] | ForEach-Object { $_ -replace '\s', '_' }) }
            $linha = ((@($nomes[$i]) + $resto) -join ' ').ToLowerInvariant()
            if ($linha -match $bancoSempre -or $linha -match $bancoRemoto) {
                Bloquear "comando que altera o banco ou aponta para o banco remoto ('$($nomes[$i])'). Escreva a migracao ou o script e relate ao mestre: quem aplica e ele, com o OK do usuario."
            }
            break
        }
    }
}

# Acao sem volta (so o mestre, com o OK do usuario): git que grava historico ou mexe no
# remoto, dependencia nova e apagar pasta inteira.

# Git que grava historico ou mexe no remoto. git tag so e bloqueado quando nao e listagem;
# git branch, so com -d, -D ou --delete.
$gitGrava = '^(commit|push|merge|rebase|tag|cherry-pick|am|pull|revert)$'
# Letras de opcao do git branch que podem vir juntas (-dr, -Df); com d ou D, apaga.
$gitBranchApaga = '^-[afqrvdD]*[dD][afqrvdD]*$'

# Instaladores de dependencia. nome: o programa. subs: os subcomandos, em ordem (opcoes no
# meio sao puladas; '.' aceita qualquer palavra, como o projeto em "dotnet add app.csproj
# package"). valor: opcoes cujo token seguinte e um valor, nao um pacote ($null: nenhuma).
# Qualquer outra palavra depois do subcomando e pacote: o comando e bloqueado.
$instaladores = @(
    @{ nome = '^npm$';                subs = @('^(install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall|add|install-test|it)$'); valor = '^(--prefix|-C|--workspace|-w)$' },
    @{ nome = '^pnpm$';               subs = @('^(add|install|i)$');            valor = '^(--filter|-F|--dir|-C)$' },
    @{ nome = '^yarn$';               subs = @('^add$');                        valor = '^--cwd$' },
    @{ nome = '^yarn$';               subs = @('^global$', '^add$');            valor = $null },
    @{ nome = '^yarn$';               subs = @('^workspace$', '.', '^add$');    valor = $null },
    @{ nome = '^bun$';                subs = @('^(add|a|install|i)$');          valor = '^--cwd$' },
    @{ nome = '^pip(3(\.\d+)?)?$';    subs = @('^install$');                    valor = '^(-r|--requirement|-c|--constraint|-e|--editable|-t|--target|--prefix|--root|-i|--index-url|--extra-index-url|-f|--find-links|-p|--python)$' },
    @{ nome = '^uv$';                 subs = @('^add$');                        valor = $null },
    @{ nome = '^poetry$';             subs = @('^add$');                        valor = $null },
    @{ nome = '^flutter$';            subs = @('^(pub|packages)$', '^add$');    valor = $null },
    @{ nome = '^dart$';               subs = @('^pub$', '^add$');               valor = $null },
    @{ nome = '^cargo$';              subs = @('^add$');                        valor = $null },
    @{ nome = '^go$';                 subs = @('^(get|install)$');              valor = $null },
    @{ nome = '^dotnet$';             subs = @('^add$', '^package$');           valor = $null },
    @{ nome = '^dotnet$';             subs = @('^add$', '.', '^package$');      valor = $null },
    @{ nome = '^dotnet$';             subs = @('^package$', '^add$');           valor = $null },
    @{ nome = '^composer$';           subs = @('^req(u(i(r(e)?)?)?)?$');        valor = $null },
    @{ nome = '^gem$';                subs = @('^install$');                    valor = $null }
)
# python -m pip, uv pip, sudo npm...: a varredura acha o instalador em qualquer posicao.

# Comandos que apagam (rm do bash; Remove-Item e seus apelidos no PowerShell; rd e del do cmd).
$programasApagar = '^(rm|remove-item|ri|del|erase|rd|rmdir)$'
# rm -r, -R, -rf, -fr, -rfv...: letras de opcao do rm juntas, com r ou R.
$rmRecursivo = '^-[fiIrRdv]*[rR][fiIrRdv]*$'
# -Recurse do PowerShell e suas abreviacoes (-r, -rec...), com ou sem :$true.
$psRecurse = '(?i)^-r(e(c(u(r(s(e)?)?)?)?)?)?(:\S*)?$'
# /s do cmd (rd /s, rmdir /s, del /s), sozinho ou junto de outras (/s/q).
$cmdSubpastas = '(?i)^(/[a-z](:[a-z-]+)?)*/s(/[a-z](:[a-z-]+)?)*$'

# Posicao do primeiro token, a partir de $inicio, que casa com $padrao. Pula opcoes e a palavra
# logo depois de uma opcao (o valor dela); outra palavra antes do subcomando: -1.
function Indice-Sub([string[]]$tokens, [int]$inicio, [string]$padrao) {
    for ($k = $inicio; $k -lt $tokens.Count; $k++) {
        $t = $tokens[$k]
        if ($t.StartsWith('-')) { continue }
        if ($t -match $padrao) { return $k }
        $ehValor = ($k -gt $inicio) -and $tokens[$k - 1].StartsWith('-') -and -not $tokens[$k - 1].Contains('=')
        if (-not $ehValor) { return -1 }
    }
    return -1
}

function Testar-GitGrava([string[]]$tokens, [int]$i) {
    $j = Indice-SubGit $tokens $i
    if ($j -lt 0) { return }
    $sub = $tokens[$j].ToLowerInvariant()
    $resto = @()
    if ($j + 1 -lt $tokens.Count) { $resto = @($tokens[($j + 1)..($tokens.Count - 1)]) }
    $grava = $sub -match $gitGrava
    # git tag so lista quando tem -l/--list, ou quando nao cria nem apaga e nao da nome a uma tag
    # (--sort, --contains abc, -n).
    if ($sub -eq 'tag') {
        $cria = @($resto | Where-Object { $_ -cmatch '^(-a|-s|-u|-f|-d|-m.*|-F.*|--annotate|--sign|--force|--delete|--local-user.*|--message.*|--file.*)$' }).Count -gt 0
        $lista = @($resto | Where-Object { $_ -cmatch '^(-l|--list)$' }).Count -gt 0
        $nomesTag = 0
        for ($k = 0; $k -lt $resto.Count; $k++) {
            if ($resto[$k].StartsWith('-')) { continue }
            if ($k -gt 0 -and $resto[$k - 1] -cmatch '^(--contains|--no-contains|--merged|--no-merged|--points-at|--sort|--format|--color|--column)$') { continue }
            $nomesTag++
        }
        $grava = $cria -or (-not $lista -and $nomesTag -gt 0)
    }
    if ($sub -eq 'branch') {
        # --delete aceita abreviacao (--del).
        $apaga = @($resto | Where-Object { $_ -cmatch $gitBranchApaga -or ($_.Length -ge 3 -and '--delete'.StartsWith($_, [System.StringComparison]::Ordinal)) })
        if ($apaga.Count -gt 0) { $grava = $true; $sub = "branch $($apaga[0])" }
    }
    if ($grava) {
        Bloquear "acao sem volta: git $sub mexe no historico ou no remoto, e commit e push sao do mestre; reporte ao mestre como pendencia."
    }
}

function Testar-Instalacao([string[]]$tokens, [string]$nome, [int]$i) {
    foreach ($inst in $instaladores) {
        if ($nome -notmatch $inst.nome) { continue }
        $k = $i
        $palavras = @($nome)
        foreach ($padrao in $inst.subs) {
            $k = Indice-Sub $tokens ($k + 1) $padrao
            if ($k -lt 0) { break }
            $palavras += $tokens[$k]
        }
        if ($k -lt 0) { continue }
        for ($m = $k + 1; $m -lt $tokens.Count; $m++) {
            $t = $tokens[$m]
            if ($t.StartsWith('-')) { continue }
            # O proprio projeto ou uma pasta dele (pip install ., go install ./cmd/x) nao e dependencia nova.
            if ($t -eq '.' -or $t -match '^\.{1,2}([\\/]|$)') { continue }
            $anterior = $tokens[$m - 1]
            if ($inst.valor -and $anterior -cmatch $inst.valor) {
                # -e com endereco (git+https://...) instala pacote de fora; -e . e o proprio projeto.
                $deFora = ($anterior -cmatch '^(-e|--editable)$') -and ($t -match '://|^[A-Za-z]+\+|^git@')
                if (-not $deFora) { continue }
            }
            Bloquear "acao sem volta: $($palavras -join ' ') com '$t' instala dependencia nova; reporte ao mestre como pendencia, com o pacote e o motivo."
        }
    }
}

function Testar-Apagar([string[]]$tokens, [string]$nome, [int]$i) {
    if ($nome -notmatch $programasApagar) { return }
    for ($m = $i + 1; $m -lt $tokens.Count; $m++) {
        $t = $tokens[$m]
        # --recursive aceita abreviacao (--rec).
        $recursivo = ($t -cmatch $rmRecursivo) -or ($t -match $psRecurse) -or
                     ($t.Length -ge 3 -and '--recursive'.StartsWith($t, [System.StringComparison]::Ordinal))
        if ($nome -match '^(rd|rmdir|del|erase)$' -and $t -match $cmdSubpastas) { $recursivo = $true }
        if ($recursivo) {
            Bloquear "acao sem volta: $($tokens[$i]) com $t apaga uma pasta inteira; reporte ao mestre como pendencia."
        }
    }
}

function Testar-SemVolta([string]$texto) {
    foreach ($dentro in (Comandos-Embutidos $texto)) { if ($dentro.Trim()) { Testar-SemVolta $dentro } }
    foreach ($parte in (Dividir-Partes (Tirar-Redirecionamentos $texto))) {
        $seg = ($parte -replace '\s+', ' ').Trim()
        if (-not $seg) { continue }
        $tokens = Separar-Tokens $seg
        if ($tokens.Count -eq 0) { continue }
        $nomes = @($tokens | ForEach-Object { Nome-Programa $_ })

        # Busca e eco so citam o comando.
        if ($nomes[0] -ne 'git' -and $nomes[0] -match $comandosDeTexto) { continue }
        # Texto entre aspas so e comando quando quem recebe o executa (bash -c "...", cmd /c
        # "...", iex '...'): o filtro de um teste ("rd -r") nao e.
        if (@($nomes | Where-Object { $_ -match $avaliadores }).Count -gt 0) {
            foreach ($t in $tokens) {
                if ($t -match '\s') { Testar-SemVolta $t }
            }
        }
        for ($i = 0; $i -lt $tokens.Count; $i++) {
            if ($nomes[$i] -eq 'git') {
                # O resto e argumento do git (mensagem de commit, busca).
                Testar-GitGrava $tokens $i
                break
            }
            # Versao no nome (npx pnpm@8) nao muda o programa.
            Testar-Instalacao $tokens ($nomes[$i] -replace '(?<=.)@[^@]*$', '') $i
            Testar-Apagar $tokens $nomes[$i] $i
        }
    }
}

# Verificador: a lista de comandos de uma pasta e os repositorios que a sessao editou.

# Caminho para comparar: barras normais e sem barra no fim (o git escreve C:/pasta/projeto).
function Caminho-Comparavel([string]$caminho) { return $caminho.Replace('\', '/').TrimEnd('/') }

function Arquivo-Lista([string]$pasta) { return [System.IO.Path]::Combine($pasta, '.claude', 'verificador-comandos.txt') }

# A lista esta no git do repositorio: lista fora do git nao vale.
function Lista-NoGit([string]$raiz) {
    & git -C $raiz ls-files --error-unmatch -- .claude/verificador-comandos.txt 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}

# Linhas que valem: sem comentario nem linha vazia, com os espacos juntados.
function Linhas-Lista([string]$arquivo) {
    return @(Get-Content -LiteralPath $arquivo -Encoding UTF8 |
        ForEach-Object { ($_ -replace '\s+', ' ').Trim() } |
        Where-Object { $_ -and -not $_.StartsWith('#') })
}

# Repositorios que esta sessao editou, na ordem em que os hooks da equipe os anotaram (a raiz,
# como o git a escreve): as chaves de <pasta do Claude>\equipe-diario\estado\<sessao>-sessao.base.
function Raizes-Editadas([string]$sessao) {
    $sessao = $sessao -replace '[^A-Za-z0-9_-]', ''
    if (-not $sessao) { return @() }
    $pastaClaude = $env:EQUIPE_PASTA_CLAUDE
    if (-not $pastaClaude) { $pastaClaude = Split-Path -Parent $PSScriptRoot }
    try {
        $arqBase = Join-Path (Join-Path (Join-Path $pastaClaude 'equipe-diario') 'estado') "$sessao-sessao.base"
        if (-not (Test-Path -LiteralPath $arqBase)) { return @() }
        $base = [System.IO.File]::ReadAllText($arqBase) | ConvertFrom-Json
        if (-not $base) { return @() }
        return @($base.PSObject.Properties | ForEach-Object { [string]$_.Name })
    } catch { return @() }
}

try {
    # Le a entrada em bytes e detecta a codificacao: o Windows PowerShell 5.1 nao
    # usa UTF-8 por padrao no console.
    $memoria = New-Object System.IO.MemoryStream
    [Console]::OpenStandardInput().CopyTo($memoria)
    $bytes = $memoria.ToArray()
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        $bruto = [System.Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3)
    } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
        $bruto = [System.Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2)
    } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF) {
        $bruto = [System.Text.Encoding]::BigEndianUnicode.GetString($bytes, 2, $bytes.Length - 2)
    } elseif ($bytes.Length -ge 2 -and $bytes[1] -eq 0) {
        $bruto = [System.Text.Encoding]::Unicode.GetString($bytes)
    } else {
        $bruto = [System.Text.Encoding]::UTF8.GetString($bytes)
    }
    $bruto = $bruto.Trim([char]0xFEFF, [char]0, ' ', "`r", "`n", "`t")
    if (-not $bruto) { Bloquear 'entrada vazia.' }
    try {
        $entrada = $bruto | ConvertFrom-Json
    } catch {
        $inicio = $bruto.Substring(0, [Math]::Min(12, $bruto.Length))
        $codigos = (($inicio.ToCharArray() | ForEach-Object { [int]$_ }) -join ',')
        Bloquear "entrada nao e JSON (inicio: $codigos)."
    }
    if ($null -eq $entrada) { Bloquear 'entrada invalida.' }

    $ferramenta = [string]$entrada.tool_name
    if ($ferramenta -ne 'Bash' -and $ferramenta -ne 'PowerShell') { exit 0 }

    $comando = ([string]$entrada.tool_input.command).Trim()
    if (-not $comando) { Bloquear 'comando vazio.' }

    if ($Perfil -eq 'implementador') {
        # Linha continuada e um comando so: "git \<quebra>checkout -- x" (barra invertida no fim,
        # no Bash; crase no PowerShell) nao pode esconder o subcomando nem um arquivo.
        # Confere as duas formas, a juntada e a que veio: "echo a\\" seguido de outra linha nao e
        # continuacao, e a outra linha roda.
        if ($ferramenta -eq 'PowerShell') { $juntado = $comando -replace '`\r?\n', ' ' }
        else { $juntado = $comando -replace '\\\r?\n', '' }
        foreach ($versao in @($comando, $juntado | Select-Object -Unique)) {
            Testar-Formatadores $versao ([string]$entrada.cwd)
            Testar-Descarte $versao ([string]$entrada.cwd)
            Testar-Banco $versao
            Testar-SemVolta $versao
        }
        exit 0
    }

    if ($comando -match '[\r\n]') { Bloquear 'um comando por vez, em uma linha so.' }
    # Aspas, crase, circunflexo e barra invertida podem esconder o nome (.e""nv, .e`nv).
    $semEscapes = $comando -replace '["''`^\\]', ''
    if ($semEscapes -match '(?i)\.env') { Bloquear 'comando que cita .env nao e permitido.' }
    $comando = $comando -replace '\s+', ' '

    switch ($Perfil) {
        'explore' {
            if ($comando -match $operadores) {
                Bloquear 'sem pipe, redirecionamento, encadeamento, variavel ou parenteses.'
            }
            if ($comando -notmatch '^git (log|blame|show|diff|status|ls-files)( |$)') {
                Bloquear 'o Explore so pode rodar git log, blame, show, diff, status e ls-files.'
            }
            if ($comando -match '(^| )--(output|ext-diff|no-index|contents)') {
                Bloquear 'as opcoes --output, --ext-diff, --no-index e --contents nao sao permitidas.'
            }
            exit 0
        }
        'verificador' {
            # Vale a lista do repositorio onde o verificador esta (cwd), se ela estiver no git
            # e ele for worktree do proprio projeto (mesmo .git comum): cada worktree usa a
            # propria. Senao, vale a do projeto da sessao.
            $pasta = $null
            $cwd = [string]$entrada.cwd
            if ($cwd) {
                try {
                    $raiz = & git -C $cwd rev-parse --show-toplevel 2>$null
                    if ($LASTEXITCODE -eq 0 -and $raiz) {
                        $raiz = ([string]$raiz).Trim()
                        $mesmoProjeto = $true
                        if ($env:CLAUDE_PROJECT_DIR) {
                            # --git-common-dir pode vir relativo a pasta do -C: monta o caminho completo
                            # aqui (sem --path-format, que o git anterior ao 2.31 nao conhece).
                            $comumCwd = & git -C $raiz rev-parse --git-common-dir 2>$null
                            $okCwd = ($LASTEXITCODE -eq 0) -and $comumCwd
                            $comumProj = & git -C $env:CLAUDE_PROJECT_DIR rev-parse --git-common-dir 2>$null
                            $okProj = ($LASTEXITCODE -eq 0) -and $comumProj
                            $mesmoProjeto = $false
                            if ($okCwd -and $okProj) {
                                $a = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($raiz, ([string]$comumCwd).Trim()))
                                $b = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($env:CLAUDE_PROJECT_DIR, ([string]$comumProj).Trim()))
                                $mesmoProjeto = ($a.TrimEnd('\', '/') -eq $b.TrimEnd('\', '/'))
                            }
                        }
                        if ($mesmoProjeto -and (Lista-NoGit $raiz)) { $pasta = $raiz }
                    }
                } catch { $pasta = $null }
            }
            if (-not $pasta) { $pasta = $env:CLAUDE_PROJECT_DIR }
            if (-not $pasta) { $pasta = $cwd }
            $arquivoLista = Join-Path (Join-Path $pasta '.claude') 'verificador-comandos.txt'
            # Comando que entra numa pasta antes: "cd <pasta absoluta> && ..." (";" so no
            # PowerShell). Caminho com $, crase, parenteses ou outro operador seria interpretado
            # pelo shell e nao vale.
            $separador = if ($ferramenta -eq 'PowerShell') { '(&&|;)' } else { '(&&)' }
            $m = [regex]::Match($comando, '^cd ("([^"]+)"|''([^'']+)''|([^\s"'';&|]+)) ?' + $separador + ' ?(.+)$')
            $dirCd = $null
            if ($m.Success) {
                $dirCd = @($m.Groups[2].Value, $m.Groups[3].Value, $m.Groups[4].Value) | Where-Object { $_ } | Select-Object -First 1
                if (-not $dirCd -or $dirCd -match $operadores -or -not [System.IO.Path]::IsPathRooted($dirCd)) { $dirCd = $null }
            }
            if ($dirCd -and (Test-Path -LiteralPath $arquivoLista) -and (Caminho-Comparavel $dirCd) -ieq (Caminho-Comparavel $pasta)) {
                # A lista em vigor e de outra pasta (o projeto, com o cwd fora dele ou que ja
                # sumiu): "cd <pasta da lista> && <linha>" roda a linha de la. O resto do comando
                # e conferido contra a lista como sempre.
                $comando = $m.Groups[6].Value.Trim()
            }
            if (-not (Test-Path -LiteralPath $arquivoLista)) {
                # Sessao aberta fora do repositorio (numa pasta temporaria, com o projeto em
                # outra pasta) e sem lista propria: vale a lista do repositorio em que o comando
                # entra com "cd <pasta absoluta> && ...", se ela estiver no git e se a propria
                # sessao editou esse repositorio. Repositorio qualquer do disco nao vale. O resto
                # do comando e conferido contra a lista como sempre.
                $raizCd = $null
                if ($dirCd -and (Test-Path -LiteralPath $dirCd -PathType Container)) {
                    try {
                        $raizCd = & git -C $dirCd rev-parse --show-toplevel 2>$null
                        if ($LASTEXITCODE -ne 0) { $raizCd = $null }
                        $prefixoCd = & git -C $dirCd rev-parse --show-prefix 2>$null
                        if ($LASTEXITCODE -ne 0) { $raizCd = $null }
                        if ($raizCd) {
                            $raizCd = ([string]$raizCd).Trim()
                            if (-not (Lista-NoGit $raizCd)) { $raizCd = $null }
                        }
                        if ($raizCd) {
                            $editados = @(Raizes-Editadas ([string]$entrada.session_id))
                            $alvo = Caminho-Comparavel $raizCd
                            if (-not ($editados | Where-Object { (Caminho-Comparavel $_) -ieq $alvo })) { $raizCd = $null }
                        }
                    } catch { $raizCd = $null }
                }
                if ($raizCd) {
                    $pasta = $raizCd
                    $arquivoLista = Join-Path (Join-Path $pasta '.claude') 'verificador-comandos.txt'
                    $resto = $m.Groups[6].Value.Trim()
                    $relCd = ([string]$prefixoCd).Trim().TrimEnd('/')
                    # Numa subpasta, compara como as linhas "cd app && ..." da lista.
                    if (-not $relCd) { $comando = $resto }
                    elseif ($m.Groups[5].Value -eq '&&') { $comando = "cd $relCd && $resto" }
                    else { $comando = "cd $relCd; $resto" }
                }
            }
            if (-not (Test-Path -LiteralPath $arquivoLista)) {
                # Sem lista aqui (pasta temporaria, ou que ja sumiu): se um repositorio que a sessao
                # editou tem a lista, a mensagem diz como rodar de la, no formato que o trecho
                # acima aceita. So sem lista em lugar nenhum e que ela precisa ser criada.
                $projeto = $null
                foreach ($r in @(Raizes-Editadas ([string]$entrada.session_id))) {
                    if ($r -and (Test-Path -LiteralPath (Arquivo-Lista $r))) { $projeto = $r; break }
                }
                if (-not $projeto) {
                    Bloquear "nao existe $arquivoLista. Reporte ao mestre: a lista de comandos do projeto precisa ser criada."
                }
                $motivo = "nao existe $arquivoLista"
                if ($cwd -and -not (Test-Path -LiteralPath $cwd -PathType Container)) { $motivo = "a pasta atual ($cwd) nao existe mais" }
                # A pasta atual e um repositorio sem a lista: verificar outro projeto daria verde no
                # lugar errado. Quem decide e o mestre, no briefing.
                elseif ($cwd) {
                    & git -C $cwd rev-parse --show-toplevel 2>$null | Out-Null
                    if ($LASTEXITCODE -eq 0) {
                        Bloquear "$motivo. Reporte ao mestre como bloqueio: esta pasta e um repositorio sem a lista. A sessao editou $projeto, que tem a lista; se a verificacao e de la, o mestre diz isso no briefing (cd para a pasta e a linha da lista)."
                    }
                }
                if (-not (Lista-NoGit $projeto)) {
                    Bloquear "$motivo. A lista do projeto, em $projeto, nao esta em commit. Reporte ao mestre: ele mostra a lista ao usuario e faz o commit."
                }
                if ($projeto -match $operadores) {
                    Bloquear "$motivo. A lista do projeto esta em $projeto, mas a guarda nao aceita cd para um caminho com esses caracteres. Reporte como bloqueio."
                }
                # Entre aspas e com barra normal: no Git Bash, a barra invertida some.
                $cdProjeto = "cd `"$($projeto.Replace('\', '/'))`""
                $sep = ' && '
                if ($ferramenta -eq 'PowerShell') { $sep = '; ' }
                $linhas = @(Linhas-Lista (Arquivo-Lista $projeto))
                $exemplo = ''
                if ($linhas.Count -gt 0) { $exemplo = ", por exemplo $cdProjeto$sep$($linhas[0])" }
                Bloquear ("$motivo. A lista do projeto esta em ${projeto}: rode de la, com $cdProjeto$sep<linha da lista>$exemplo. Linhas da lista: " + ($linhas -join ' | ') + '. Se nenhuma cobrir o pedido, reporte como bloqueio.')
            }
            # A lista so vale depois de entrar em commit: assim uma mudanca feita por
            # outro agente aparece no git antes de liberar comandos.
            $mudou = $null
            try {
                $mudou = & git -C $pasta status --porcelain -- .claude/verificador-comandos.txt 2>$null
                if ($LASTEXITCODE -ne 0) { $mudou = $null }
            } catch { $mudou = $null }
            if ($mudou) {
                Bloquear "a lista .claude/verificador-comandos.txt tem mudanca fora de commit. Reporte ao mestre: ele mostra a mudanca ao usuario e faz o commit."
            }
            $permitidos = @(Linhas-Lista $arquivoLista)
            foreach ($linha in $permitidos) {
                if ($comando -ieq $linha) { exit 0 }
                $prefixo = "$linha "
                if ($comando.StartsWith($prefixo, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $resto = $comando.Substring($prefixo.Length)
                    if ($resto -notmatch $operadores) { exit 0 }
                }
            }
            Bloquear ("comando fora da lista do projeto. Permitidos: " + ($permitidos -join ' | ') + ". Reporte como bloqueio; nao tente variacoes.")
        }
        default {
            Bloquear 'perfil desconhecido. Use explore, verificador ou implementador.'
        }
    }
} catch {
    Bloquear ("erro na guarda: " + $_.Exception.Message)
}
