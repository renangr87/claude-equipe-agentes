<#
.SYNOPSIS
  Instala a equipe de agentes na pasta de configuracao do Claude Code.

.DESCRIPTION
  1. Copia os subagentes para <Destino>\agents, com o caminho da guarda ajustado
  2. Copia a guarda de terminal (guarda-comandos.ps1) para <Destino>\hooks
  3. Copia a regra global para <Destino>\rules
  4. Acrescenta os bloqueios ao <Destino>\settings.json, sem remover o que ja existe
  5. Com -ComMapa: registra o servidor codebase-memory (mapa do codigo) na
     configuracao do usuario (.claude.json), para o Explore e o revisor consultarem
     o mapa em todos os projetos

  Nada e apagado. Antes de alterar um arquivo que ja existe, o script grava
  uma copia ao lado dele com o sufixo .bak-<data>-<hora>.
  Pode ser executado mais de uma vez: o que ja esta igual e mantido.

.PARAMETER Destino
  Pasta de configuracao do Claude Code.
  Padrao: a variavel CLAUDE_CONFIG_DIR, se existir; senao, a pasta .claude do usuario.

.PARAMETER SemBloqueios
  Nao altera o settings.json. Instala so os subagentes, a guarda e a regra global.

.PARAMETER ComMapa
  Registra o servidor codebase-memory no .claude.json do usuario, com o caminho completo
  do executavel codebase-memory-mcp encontrado no PATH. O programa e instalado antes,
  pelo instalador oficial do projeto, so o binario (--skip-config). Precisa do Node.js,
  que faz a juncao do JSON (o .claude.json pode ser grande demais para o Windows
  PowerShell 5.1), e do app do Claude fechado, porque ele reescreve esse arquivo.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\instalar.ps1 -ComMapa

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\instalar.ps1 -SemBloqueios
#>
[CmdletBinding()]
param(
    [string]$Destino = '',
    [switch]$SemBloqueios,
    [switch]$ComMapa
)

$ErrorActionPreference = 'Stop'

# O .claude.json do usuario fica ao lado da pasta .claude no caso padrao, e dentro
# da pasta de configuracao quando ela e outra (CLAUDE_CONFIG_DIR ou -Destino).
$arquivoUsuario = ''
if (-not $Destino) {
    if ($env:CLAUDE_CONFIG_DIR) {
        $Destino = $env:CLAUDE_CONFIG_DIR
    } else {
        $Destino = Join-Path $HOME '.claude'
        $arquivoUsuario = Join-Path $HOME '.claude.json'
    }
}
if (-not $arquivoUsuario) { $arquivoUsuario = Join-Path $Destino '.claude.json' }

$origem  = $PSScriptRoot
$utf8    = New-Object System.Text.UTF8Encoding($false)
$carimbo = Get-Date -Format 'yyyyMMdd-HHmmss'

function Read-Texto([string]$caminho) {
    return [System.IO.File]::ReadAllText($caminho, $utf8)
}

function Write-ComBackup([string]$texto, [string]$para) {
    if (Test-Path -LiteralPath $para) {
        if ($texto -ceq (Read-Texto $para)) {
            Write-Host "  igual, mantido: $para"
            return
        }
        $bak = "$para.bak-$carimbo"
        Copy-Item -LiteralPath $para -Destination $bak
        Write-Host "  copia de seguranca: $bak"
    }
    [System.IO.File]::WriteAllText($para, $texto, $utf8)
    Write-Host "  gravado: $para"
}

function Copy-ComBackup([string]$de, [string]$para) {
    Write-ComBackup (Read-Texto $de) $para
}

function Merge-Bloqueios([string]$arquivoNovo, [string]$arquivoDestino) {
    $novo   = (Read-Texto $arquivoNovo) | ConvertFrom-Json
    $existe = Test-Path -LiteralPath $arquivoDestino
    $atual  = New-Object PSObject

    if ($existe) {
        $texto = Read-Texto $arquivoDestino
        if ($texto.Trim().Length -gt 0) {
            try {
                $atual = $texto | ConvertFrom-Json
            } catch {
                throw "O arquivo $arquivoDestino nao e um JSON valido. Ele nao foi alterado. Corrija o arquivo ou rode de novo com -SemBloqueios."
            }
        }
    }
    if ($null -eq $atual -or $atual -isnot [System.Management.Automation.PSCustomObject]) {
        throw "O arquivo $arquivoDestino nao tem o formato esperado (um objeto JSON). Ele nao foi alterado."
    }

    if (-not $atual.PSObject.Properties['permissions']) {
        $atual | Add-Member -NotePropertyName 'permissions' -NotePropertyValue (New-Object PSObject)
    }
    $perm = $atual.permissions
    if ($null -eq $perm -or $perm -isnot [System.Management.Automation.PSCustomObject]) {
        throw "A chave permissions de $arquivoDestino nao e um objeto. O arquivo nao foi alterado."
    }

    $adicionadas = 0
    foreach ($chave in @('deny', 'ask')) {
        $regrasNovas  = @($novo.permissions.$chave | Where-Object { $null -ne $_ })
        $regrasAtuais = @()
        $temChave     = [bool]$perm.PSObject.Properties[$chave]
        if ($temChave) {
            $regrasAtuais = @($perm.$chave | Where-Object { $null -ne $_ })
        }
        $faltam = @($regrasNovas | Where-Object { $regrasAtuais -cnotcontains $_ })
        if ($faltam.Count -gt 0) {
            $juntas = @($regrasAtuais) + @($faltam)
            if ($temChave) {
                $perm.$chave = $juntas
            } else {
                $perm | Add-Member -NotePropertyName $chave -NotePropertyValue $juntas
            }
            $adicionadas += $faltam.Count
        }
    }

    if ($adicionadas -eq 0) {
        Write-Host "  bloqueios ja presentes, mantido: $arquivoDestino"
        return
    }
    if ($existe) {
        $bak = "$arquivoDestino.bak-$carimbo"
        Copy-Item -LiteralPath $arquivoDestino -Destination $bak
        Write-Host "  copia de seguranca: $bak"
    }
    $json = $atual | ConvertTo-Json -Depth 32
    [System.IO.File]::WriteAllText($arquivoDestino, $json + "`n", $utf8)
    Write-Host "  $adicionadas regras acrescentadas: $arquivoDestino"
}

Write-Host "Instalando em: $Destino"

$pastaAgentes = Join-Path $Destino 'agents'
$pastaRegras  = Join-Path $Destino 'rules'
$pastaHooks   = Join-Path $Destino 'hooks'
New-Item -ItemType Directory -Force -Path $pastaAgentes | Out-Null
New-Item -ItemType Directory -Force -Path $pastaRegras  | Out-Null
New-Item -ItemType Directory -Force -Path $pastaHooks   | Out-Null

# Caminho absoluto da pasta de configuracao, com barras normais, para o hook dos agentes.
$pastaClaude = (Resolve-Path -LiteralPath $Destino).ProviderPath -replace '\\', '/'
# O caminho vai entre aspas simples no comando do hook: aspa simples vira duas.
$pastaClaude = $pastaClaude -replace "'", "''"

Write-Host "Guarda de terminal:"
Copy-ComBackup (Join-Path (Join-Path $origem 'hooks') 'guarda-comandos.ps1') (Join-Path $pastaHooks 'guarda-comandos.ps1')

Write-Host "Subagentes:"
$origemAgentes = Join-Path $origem 'agents'
foreach ($arquivo in (Get-ChildItem -LiteralPath $origemAgentes -Filter '*.md' | Sort-Object Name)) {
    $texto = (Read-Texto $arquivo.FullName).Replace('__PASTA_CLAUDE__', $pastaClaude)
    Write-ComBackup $texto (Join-Path $pastaAgentes $arquivo.Name)
}

Write-Host "Regra global:"
$origemRegra = Join-Path (Join-Path $origem 'rules') 'equipe-agentes.md'
Copy-ComBackup $origemRegra (Join-Path $pastaRegras 'equipe-agentes.md')

if ($SemBloqueios) {
    Write-Host "Bloqueios: ignorados (-SemBloqueios)."
} else {
    Write-Host "Bloqueios:"
    $origemBloqueios = Join-Path (Join-Path $origem 'settings') 'global.json'
    Merge-Bloqueios $origemBloqueios (Join-Path $Destino 'settings.json')
}

function Registrar-Servidor([string]$titulo, [string]$nome, [string]$modelo, [string]$comando) {
    Write-Host "$($titulo):"
    $node = Get-Command node -ErrorAction SilentlyContinue
    $appAberto = $false
    if ($env:OS -eq 'Windows_NT') {
        $appAberto = [bool](Get-Process -Name 'Claude' -ErrorAction SilentlyContinue)
    }
    if (-not $node) {
        Write-Host "  nao registrado: o Node.js nao foi encontrado. Instale o Node 20.19 ou mais novo e rode de novo."
        return
    }
    if ($appAberto) {
        Write-Host "  nao registrado: o app do Claude esta aberto e reescreve o .claude.json. Feche o app e rode de novo."
        return
    }
    $script = Join-Path (Join-Path $origem 'ferramentas') 'registrar-mcp.mjs'
    $argumentos = @($script, $arquivoUsuario, $modelo, $carimbo, $nome)
    if ($comando) { $argumentos += $comando }
    & $node.Source @argumentos
    if ($LASTEXITCODE -ne 0) {
        throw "O servidor $nome nao foi registrado. Veja a mensagem acima."
    }
}

if ($ComMapa) {
    $mapa = Get-Command 'codebase-memory-mcp' -ErrorAction SilentlyContinue
    if (-not $mapa) {
        Write-Host "Mapa do codigo (codebase-memory):"
        Write-Host "  nao registrado: o programa codebase-memory-mcp nao foi encontrado. Instale com o instalador oficial, so o binario (--skip-config), e rode de novo com -ComMapa."
    } else {
        Registrar-Servidor 'Mapa do codigo (codebase-memory)' 'codebase-memory' (Join-Path (Join-Path $origem 'projeto') 'mcp.codebase-memory.json') $mapa.Source
    }
}

Write-Host ""
Write-Host "Pronto. Abra uma sessao nova no Claude Code para carregar tudo."
