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
    verificador    so os comandos listados em .claude/verificador-comandos.txt do projeto,
                   e so se essa lista nao tiver mudanca fora de commit.
                   Cada linha libera o comando exato e o mesmo comando com argumentos a mais.
    implementador  terminal livre, menos formatadores: so passam com arquivos nomeados um
                   a um. Pasta, '.', curinga, variavel ou nenhum arquivo sao bloqueados,
                   em qualquer parte de um comando composto. Scripts de formatacao
                   (npm run format e parecidos) sao bloqueados.

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

function Testar-Formatadores([string]$texto, [string]$pastaAtual) {
    # Tira redirecionamentos (2>&1, > arquivo, < arquivo) antes de separar as partes.
    $semRedir = $texto -replace '(\*|\d)?>&\d+', ' '
    $semRedir = $semRedir -replace '(\*|\d)?>>?\s*("[^"]*"|''[^'']*''|[^\s;&|]+)', ' '
    $semRedir = $semRedir -replace '<\s*("[^"]*"|''[^'']*''|[^\s;&|]+)', ' '

    foreach ($parte in ($semRedir -split '&&|\|\||[;&|\r\n]')) {
        $seg = ($parte -replace '\s+', ' ').Trim()
        if (-not $seg) { continue }
        if ($seg -match $scriptsFormatacao) {
            Bloquear "script de formatacao ('$seg') formata o projeto inteiro. Rode o formatador direto, so com os arquivos que voce alterou."
        }
        $tokens = Separar-Tokens $seg
        if ($tokens.Count -eq 0) { continue }
        $nomes = @($tokens | ForEach-Object { Nome-Programa $_ })

        if (@($nomes | Where-Object { $_ -match $executores }).Count -gt 0 -and
            @($nomes | Where-Object { $nomesFormatadores -contains $_ }).Count -gt 0) {
            Bloquear "formatador chamado por Start-Process ou Invoke-Expression. Rode o formatador direto, so com os arquivos que voce alterou."
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

                $arquivos = 0
                foreach ($t in $args_) {
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
                        Bloquear "o formatador so pode receber arquivos, um a um. '$t' nao e um arquivo. Formate so os arquivos que voce alterou."
                    }
                    $arquivos++
                }
                if ($arquivos -eq 0) {
                    Bloquear "formatador sem arquivo formata a pasta inteira. Passe so os arquivos que voce alterou."
                }
            }
        }
    }
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
        Testar-Formatadores $comando ([string]$entrada.cwd)
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
            $pasta = $env:CLAUDE_PROJECT_DIR
            if (-not $pasta) { $pasta = [string]$entrada.cwd }
            $arquivoLista = Join-Path (Join-Path $pasta '.claude') 'verificador-comandos.txt'
            if (-not (Test-Path -LiteralPath $arquivoLista)) {
                Bloquear "nao existe $arquivoLista. Reporte ao mestre: a lista de comandos do projeto precisa ser criada."
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
            $permitidos = @(
                Get-Content -LiteralPath $arquivoLista -Encoding UTF8 |
                    ForEach-Object { ($_ -replace '\s+', ' ').Trim() } |
                    Where-Object { $_ -and -not $_.StartsWith('#') }
            )
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
