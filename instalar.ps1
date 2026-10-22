<#
.SYNOPSIS
  Instala a equipe de agentes na pasta de configuracao do Claude Code, com o mapa do
  codigo, o Apoio Local e (se houver Flutter/Dart) o servidor do Dart.

.DESCRIPTION
  1. Se o app do Claude estiver aberto, pede para fechar (ele reescreve o .claude.json)
  2. Copia os subagentes para <Destino>\agents, com o caminho da guarda ajustado
  3. Copia a guarda de terminal (guarda-comandos.ps1) para <Destino>\hooks
  4. Copia a regra global para <Destino>\rules
  5. Acrescenta os bloqueios ao <Destino>\settings.json. So remove regras antigas da
     propria equipe, listadas em settings\retiradas.json; o resto e mantido
  6. Mapa do codigo (codebase-memory): instala o programa se faltar (instalador oficial,
     so o binario) e registra no .claude.json do usuario. Obrigatorio em projeto medio
     ou grande: so fica de fora com -SemMapa
  7. Servidor do Dart: se achar o Dart 3.13 ou mais novo, confere o servidor e registra.
     Sem Dart, pula sem erro
  8. Apoio Local (modelo do Ollama neste computador): baixa ou atualiza o repositorio
     apoio-local-ollama, cria o ambiente Python dele, instala o Ollama e o modelo se
     faltarem e registra. So fica de fora com -SemApoio
  9. Com -ApoioCasa (no PC da placa de video): publica o Ollama so para os aparelhos da
     sua conta Tailscale. Com -ApoioEmpresa (no outro computador): cria o atalho
     127.0.0.1:11435 para o Ollama de casa e registra o Apoio Local usando ele, com o
     Ollama deste computador como reserva. Os dois usam os scripts remoto\ do Apoio

  O que faltar (Git, Node.js, Python 3.12, Ollama) e instalado pelo winget. Com
  -SemInstalar, nada e instalado nem baixado: so e registrado o que ja existe.

  Nada e apagado. Antes de alterar um arquivo que ja existe, o script grava
  uma copia ao lado dele com o sufixo .bak-<data>-<hora>.
  Pode ser executado mais de uma vez: o que ja esta igual e mantido.

.PARAMETER Destino
  Pasta de configuracao do Claude Code.
  Padrao: a variavel CLAUDE_CONFIG_DIR, se existir; senao, a pasta .claude do usuario.

.PARAMETER SemBloqueios
  Nao altera o settings.json. Instala so os subagentes, a guarda e a regra global.

.PARAMETER SemMapa
  Nao instala nem registra o mapa do codigo.

.PARAMETER ComMapa
  Mantido por compatibilidade: o mapa ja e instalado e registrado por padrao.

.PARAMETER SemDart
  Nao registra o servidor do Dart, mesmo que o Dart esteja instalado.

.PARAMETER ComDart
  Mantido por compatibilidade: o servidor do Dart ja e registrado quando o Dart 3.13
  ou mais novo esta no PATH. Com esta opcao, a falta do Dart vira aviso.

.PARAMETER SemApoio
  Nao baixa nem registra o Apoio Local.

.PARAMETER ApoioLocal
  Caminho do servidor.py de uma copia do Apoio Local que voce ja tem. Com isso, o
  instalador usa essa copia e nao baixa nem atualiza o repositorio.

.PARAMETER PastaApoio
  Onde guardar o repositorio do Apoio Local quando ele e baixado.
  Padrao: <pasta do usuario>\apoio-local-ollama.

.PARAMETER ModeloApoio
  Modelo do Ollama fixado no Apoio Local, se estiver instalado. Se o Ollama nao tiver
  nenhum modelo, este e baixado. Padrao: gemma4:12b (cerca de 8 GB).

.PARAMETER ApoioCasa
  Use no PC da placa de video. Depois de registrar o Apoio Local, roda remoto\casa_ligar.ps1
  do Apoio: instala o Tailscale, faz o login e publica o Ollama so para os aparelhos da
  sua conta (tailscale serve). Para desligar: tailscale serve --tcp=11434 off.

.PARAMETER ApoioEmpresa
  Use no outro computador (por exemplo, o do trabalho; confira antes com a TI se o texto
  dos documentos pode passar pelo seu PC). Roda remoto\empresa_ligar.ps1 -SoRede do Apoio:
  instala o Tailscale, acha o PC de casa e cria o atalho 127.0.0.1:11435 (pede
  administrador uma vez). Registra o Apoio Local com APOIO_LOCAL_URL nesse atalho e, se
  houver Ollama nesta maquina, com ele de reserva. Nao instala Ollama nem baixa modelo aqui.

.PARAMETER NomeCasa
  Nome do PC de casa no Tailscale, para -ApoioEmpresa. Padrao: o do script do Apoio.

.PARAMETER SemInstalar
  Nao instala programas (Git, Node.js, Python, Ollama, mapa do codigo), nao baixa nem
  atualiza o Apoio Local e nao baixa modelo. As dependencias Python do Apoio Local
  continuam sendo conferidas no ambiente proprio dele.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\instalar.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\instalar.ps1 -ApoioLocal "C:\meu\apoio\servidor.py"

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\instalar.ps1 -SemBloqueios -SemApoio
#>
[CmdletBinding()]
param(
    [string]$Destino = '',
    [switch]$SemBloqueios,
    [switch]$ComMapa,
    [switch]$SemMapa,
    [switch]$ComDart,
    [switch]$SemDart,
    [switch]$SemApoio,
    [string]$ApoioLocal = '',
    [string]$PastaApoio = '',
    [string]$ModeloApoio = 'gemma4:12b',
    [switch]$SemInstalar,
    [switch]$ApoioCasa,
    [switch]$ApoioEmpresa,
    [string]$NomeCasa = ''
)

$ErrorActionPreference = 'Stop'

if ($ApoioCasa -and $ApoioEmpresa) {
    throw 'Use -ApoioCasa no PC da placa de video ou -ApoioEmpresa no outro computador, nao os dois.'
}
if (($ApoioCasa -or $ApoioEmpresa) -and $SemApoio) {
    throw '-ApoioCasa e -ApoioEmpresa nao combinam com -SemApoio.'
}

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

    # Regras que versoes anteriores acrescentavam e que sairam da lista: remove so as
    # identicas, para nao mexer no que o usuario escreveu.
    $removidas = 0
    $arquivoRetiradas = Join-Path (Split-Path -Parent $arquivoNovo) 'retiradas.json'
    if (Test-Path -LiteralPath $arquivoRetiradas) {
        $retiradas = (Read-Texto $arquivoRetiradas) | ConvertFrom-Json
        foreach ($chave in @('deny', 'ask', 'allow')) {
            if (-not $retiradas.PSObject.Properties[$chave] -or -not $perm.PSObject.Properties[$chave]) { continue }
            $sair = @($retiradas.$chave | Where-Object { @($novo.permissions.$chave) -cnotcontains $_ })
            $antes = @($perm.$chave | Where-Object { $null -ne $_ })
            $depois = @($antes | Where-Object { $sair -cnotcontains $_ })
            if ($depois.Count -ne $antes.Count) {
                $perm.$chave = $depois
                $removidas += $antes.Count - $depois.Count
            }
        }
    }

    $adicionadas = 0
    foreach ($chave in @('deny', 'ask', 'allow')) {
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

    if ($adicionadas -eq 0 -and $removidas -eq 0) {
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
    Write-Host "  $adicionadas regras acrescentadas e $removidas regras antigas removidas: $arquivoDestino"
}

# O app do Claude reescreve o .claude.json enquanto esta aberto, e o registro dos
# servidores precisa dele fechado. Num terminal, oferece fechar; sem terminal (testes,
# automacao), segue e o registro avisa.
if ($env:OS -eq 'Windows_NT' -and (Get-Process -Name 'Claude' -ErrorAction SilentlyContinue)) {
    if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
        Write-Host "O app do Claude esta aberto e precisa ficar fechado durante a instalacao."
        Read-Host "Aperte Enter para eu fechar o app agora (ou Ctrl+C para cancelar)" | Out-Null
        Get-Process -Name 'Claude' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        for ($i = 0; $i -lt 20 -and (Get-Process -Name 'Claude' -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
    }
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


# ---------- Programas: PATH, winget e busca ----------

# Recarrega o PATH do registro: programa recem-instalado nao aparece na sessao atual.
function Atualizar-Path {
    if ($env:OS -ne 'Windows_NT') { return }
    $partes = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'), $env:Path)
    $env:Path = (@($partes | Where-Object { $_ }) -join ';')
}

# Instala um programa pelo winget. Devolve $true se tentou (o chamador procura de novo).
function Instalar-ComWinget([string]$nome, [string]$id) {
    if ($SemInstalar) { return $false }
    $winget = Get-Command 'winget' -ErrorAction SilentlyContinue
    if (-not $winget) {
        Write-Host "  o winget nao existe neste Windows: instale $nome manualmente e rode de novo."
        return $false
    }
    Write-Host "  instalando $nome pelo winget (pode levar alguns minutos)..."
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $winget.Source install --id $id -e --silent --accept-source-agreements --accept-package-agreements | Out-Host
    $codigo = $LASTEXITCODE
    $ErrorActionPreference = $eap
    if ($codigo -ne 0) { Write-Host "  o winget terminou com o codigo $codigo." }
    Atualizar-Path
    return $true
}

function Find-Programa([string]$comando, [string[]]$caminhos) {
    $c = Get-Command $comando -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($p in $caminhos) {
        if ($p -and (Test-Path -LiteralPath $p -PathType Leaf)) { return $p }
    }
    return $null
}

function Find-Node { return Find-Programa 'node' @($(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'nodejs\node.exe' })) }
function Find-Git { return Find-Programa 'git' @($(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Git\cmd\git.exe' })) }
function Find-Ollama { return Find-Programa 'ollama' @($(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe' })) }
function Find-Mapa { return Find-Programa 'codebase-memory-mcp' @($(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs\codebase-memory-mcp\codebase-memory-mcp.exe' })) }

# ---------- Registro no .claude.json ----------

function Registrar-Servidor([string]$titulo, [string]$nome, [string]$modelo, [string]$comando, [string]$modo = '') {
    Write-Host "$($titulo):"
    $node = Find-Node
    if (-not $node -and (Instalar-ComWinget 'Node.js' 'OpenJS.NodeJS.LTS')) { $node = Find-Node }
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
    $argumentos += $comando
    if ($modo) { $argumentos += $modo }
    & $node @argumentos
    if ($LASTEXITCODE -ne 0) {
        throw "O servidor $nome nao foi registrado. Veja a mensagem acima."
    }
}

# Entrada de mcpServers ja registrada no .claude.json do usuario, ou $null.
function Ler-Servidor([string]$nome) {
    $node = Find-Node
    if (-not $node -or -not (Test-Path -LiteralPath $arquivoUsuario)) { return $null }
    $script = Join-Path (Join-Path $origem 'ferramentas') 'ler-mcp.mjs'
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $texto = (& $node $script $arquivoUsuario $nome 2>$null | Out-String).Trim()
    $ErrorActionPreference = $eap
    if (-not $texto) { return $null }
    try { return ($texto | ConvertFrom-Json) } catch { return $null }
}

# ---------- Mapa do codigo ----------

function Instalar-Mapa {
    if ($SemInstalar -or $env:OS -ne 'Windows_NT') { return }
    Write-Host "  instalando o programa (instalador oficial do projeto, so o binario: --skip-config)..."
    $script = Join-Path ([System.IO.Path]::GetTempPath()) ("cbm-install-" + [guid]::NewGuid().ToString('N') + '.ps1')
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1' -OutFile $script -ErrorAction Stop
        & (Get-Process -Id $PID).Path -NoProfile -ExecutionPolicy Bypass -File $script --skip-config | Out-Host
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  o instalador do mapa terminou com erro. Se ele disse que algo ainda usa o programa, feche editores com IA (VS Code, Cursor) e rode de novo."
        }
    } catch {
        Write-Host "  nao consegui baixar o instalador do mapa: $($_.Exception.Message)"
    } finally {
        Remove-Item -LiteralPath $script -Force -ErrorAction SilentlyContinue
        $ErrorActionPreference = $eap
    }
    Atualizar-Path
}

if (-not $SemMapa) {
    $mapa = Find-Mapa
    if (-not $mapa -and -not $SemInstalar) {
        Write-Host "Mapa do codigo (codebase-memory): programa nao encontrado."
        Instalar-Mapa
        $mapa = Find-Mapa
    }
    if (-not $mapa) {
        Write-Host "Mapa do codigo (codebase-memory):"
        Write-Host "  ATENCAO: nao registrado, porque o programa codebase-memory-mcp nao foi encontrado no PATH."
        Write-Host "  Ele e obrigatorio em projeto medio ou grande. Rode este instalador de novo sem -SemInstalar, ou instale so o binario (--skip-config) como no README da equipe, secao 'Mapa do codigo'."
    } else {
        Registrar-Servidor 'Mapa do codigo (codebase-memory)' 'codebase-memory' (Join-Path (Join-Path $origem 'projeto') 'mcp.codebase-memory.json') $mapa
    }
}

# ---------- Servidor do Dart ----------

if (-not $SemDart) {
    # Versao minima do Dart cujo servidor MCP aceita --disable all e --enable por nome
    # e tem os nomes de ferramenta de projeto/mcp.dart.json (conferido no CI).
    $dartMinimo = [version]'3.13.0'
    . (Join-Path (Join-Path $origem 'ferramentas') 'servidor-dart.ps1')
    $dartExe = Find-DartExe
    if (-not $dartExe) {
        Write-Host "Servidor do Dart:"
        if ($ComDart) {
            Write-Host "  nao registrado: o dart nao foi encontrado no PATH. Instale o Flutter ou o Dart SDK e rode de novo."
        } else {
            Write-Host "  pulado: o Dart nao esta instalado (so serve para projetos Flutter e Dart)."
        }
    } else {
        $versao = (& $dartExe --version 2>&1 | Out-String).Trim()
        $m = [regex]::Match($versao, 'version: (\d+)\.(\d+)\.(\d+)')
        if (-not $m.Success -or [version]"$($m.Groups[1].Value).$($m.Groups[2].Value).$($m.Groups[3].Value)" -lt $dartMinimo) {
            Write-Host "Servidor do Dart:"
            Write-Host "  nao registrado: a equipe precisa do Dart $dartMinimo ou mais novo (Flutter atualizado com 'flutter upgrade'). Versoes anteriores usam outros nomes de opcao e de ferramenta. Versao encontrada: $versao"
        } else {
            # Confere com o servidor rodando: ele precisa subir com os argumentos do modelo
            # e publicar exatamente as ferramentas habilitadas.
            Write-Host "Servidor do Dart: conferindo o servidor (na primeira vez pode levar um minuto)..."
            $argsDart = Get-ArgsServidorDart $origem
            $habilitadasDart = Get-NomesHabilitados $argsDart
            $teste = Get-FerramentasDart $dartExe $argsDart
            $problema = ''
            if ($null -eq $teste.Ferramentas) {
                $problema = "o servidor nao subiu com os argumentos da equipe. Saida: $($teste.Erro)"
            } else {
                $sobrando = @($teste.Ferramentas | Where-Object { $habilitadasDart -notcontains $_ })
                $faltando = @($habilitadasDart | Where-Object { $teste.Ferramentas -notcontains $_ })
                if ($sobrando.Count -gt 0) { $problema = "o servidor publicou ferramentas que nao foram habilitadas: $($sobrando -join ', ')" }
                elseif ($faltando.Count -gt 0) { $problema = "faltam ferramentas no servidor: $($faltando -join ', ')" }
            }
            if ($problema) {
                Write-Host "  nao registrado: $problema"
                Write-Host "  Atualize o Flutter (flutter upgrade) e rode de novo. Se continuar, avise no repositorio da equipe: os nomes das ferramentas mudaram."
            } else {
                Registrar-Servidor 'Servidor do Dart (dart mcp-server)' 'dart' (Join-Path (Join-Path $origem 'projeto') 'mcp.dart.json') $dartExe 'substituir'
                Write-Host "  Para nao enviar estatisticas de uso ao Google, rode uma vez: dart --disable-analytics e flutter --disable-analytics"
            }
        }
    }
}

# ---------- Apoio Local ----------

# Python 3.12 ou mais novo de verdade: o "python" da Microsoft Store e so um atalho que abre a loja.
function Find-Python {
    $tentativas = @(@('python'), @('py', '-3'))
    # Instalado sem entrar no PATH: pastas padrao do instalador (por usuario e para todos).
    $padroes = @()
    if ($env:LOCALAPPDATA) { $padroes += Join-Path $env:LOCALAPPDATA 'Programs\Python\Python3*\python.exe' }
    if ($env:ProgramFiles) { $padroes += Join-Path $env:ProgramFiles 'Python3*\python.exe' }
    foreach ($padrao in $padroes) {
        $instalados = @(Get-ChildItem -Path $padrao -ErrorAction SilentlyContinue | Sort-Object FullName -Descending)
        foreach ($p in $instalados) { $tentativas += , @($p.FullName) }
    }
    foreach ($t in $tentativas) {
        if (-not (Get-Command $t[0] -ErrorAction SilentlyContinue)) { continue }
        $extra = @($t | Select-Object -Skip 1)
        $saida = (& $t[0] @extra -c 'import sys; assert sys.version_info >= (3, 12); print(sys.executable)' 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and $saida -and (Test-Path -LiteralPath $saida -PathType Leaf)) { return $saida }
    }
    return $null
}

function Find-PythonVenv([string]$venv) {
    foreach ($rel in @('Scripts\python.exe', 'Scripts\python.cmd', 'bin/python')) {
        $c = Join-Path $venv $rel
        if (Test-Path -LiteralPath $c -PathType Leaf) { return $c }
    }
    return $null
}

# Nomes dos modelos do Ollama em $url, ou $null se ele nao responder.
function Get-ModelosOllama([string]$url) {
    try {
        $r = Invoke-RestMethod -Uri ($url.TrimEnd('/') + '/api/tags') -TimeoutSec 5 -ErrorAction Stop
        return , @($r.models | ForEach-Object { $_.name })
    } catch {
        return $null
    }
}

# Roda um script de remoto\ do Apoio Local (Tailscale). Falha vira aviso: o resto segue.
function Rodar-ScriptApoio([string]$script, [string[]]$argumentos, [string]$titulo) {
    if ($SemInstalar) {
        Write-Host "  $($titulo): pulado (-SemInstalar)."
        return
    }
    if ($env:OS -ne 'Windows_NT') {
        Write-Host "  $($titulo): pulado (so no Windows)."
        return
    }
    if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
        Write-Host "  ATENCAO: $titulo nao rodou: falta $script. Atualize a copia do Apoio Local e rode de novo."
        return
    }
    Write-Host "  $titulo..."
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & (Get-Process -Id $PID).Path -NoProfile -ExecutionPolicy Bypass -File $script @argumentos | Out-Host
    $codigo = $LASTEXITCODE
    $ErrorActionPreference = $eap
    if ($codigo -ne 0) { Write-Host "  ATENCAO: $titulo falhou. Veja a mensagem acima, corrija e rode de novo." }
}

function Ligar-Ollama([string]$exe) {
    $app = Join-Path (Split-Path -Parent $exe) 'ollama app.exe'
    if (Test-Path -LiteralPath $app) {
        Start-Process -FilePath $app
    } else {
        Start-Process -FilePath $exe -ArgumentList 'serve' -WindowStyle Hidden
    }
}

if (-not $SemApoio) {
    Write-Host "Apoio Local (modelo do Ollama neste computador):"
    # Saida de erro de programa externo com Stop vira excecao no Windows PowerShell 5.1.
    $ErrorActionPreference = 'Continue'
    $urlApoio = 'https://github.com/renangr87/apoio-local-ollama.git'
    $problema = ''
    $servidorApoio = $null
    $envAtual = $null
    $atualizar = $false

    if ($ApoioLocal) {
        if (Test-Path -LiteralPath $ApoioLocal -PathType Leaf) {
            $servidorApoio = (Resolve-Path -LiteralPath $ApoioLocal).ProviderPath
        } else {
            $problema = "o arquivo $ApoioLocal nao existe. Passe o caminho do servidor.py do Apoio Local."
        }
    }

    # Registro que ja existe: aproveita a copia e os ajustes dele (por exemplo, o Ollama
    # de outro computador pela rede).
    $atual = Ler-Servidor 'apoio-local'
    if ($atual) {
        if ($atual.PSObject.Properties['env'] -and $atual.env) { $envAtual = $atual.env }
        if (-not $servidorApoio -and -not $problema -and $atual.PSObject.Properties['args']) {
            # So vale se for um clone do git, que se atualiza. Copia solta (de um ZIP) fica
            # para tras: o instalador passa a usar o clone em -PastaApoio.
            $registrado = @($atual.args | Where-Object { "$_" -match 'servidor\.py$' }) | Select-Object -First 1
            if ($registrado -and (Test-Path -LiteralPath $registrado -PathType Leaf)) {
                if (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $registrado) '.git')) {
                    $servidorApoio = $registrado
                    $atualizar = $true
                    Write-Host "  usando a copia ja registrada: $registrado"
                } else {
                    Write-Host "  a copia registrada ($registrado) nao e um clone do git e nao se atualiza: passo a usar a copia em $(if ($PastaApoio) { $PastaApoio } else { Join-Path $HOME 'apoio-local-ollama' }). Os ajustes do registro ficam."
                }
            }
        }
    }

    # Sem copia: baixa o repositorio.
    if (-not $servidorApoio -and -not $problema) {
        if (-not $PastaApoio) { $PastaApoio = Join-Path $HOME 'apoio-local-ollama' }
        $candidato = Join-Path $PastaApoio 'servidor.py'
        if (Test-Path -LiteralPath $candidato -PathType Leaf) {
            $servidorApoio = $candidato
            $atualizar = $true
        } elseif (Test-Path -LiteralPath $PastaApoio) {
            $problema = "a pasta $PastaApoio existe, mas nao tem o servidor.py. Renomeie a pasta e rode de novo."
        } elseif ($SemInstalar) {
            $problema = "o Apoio Local nao foi encontrado em $PastaApoio. Rode sem -SemInstalar para baixar, ou passe -ApoioLocal <servidor.py>."
        } else {
            $git = Find-Git
            if (-not $git -and (Instalar-ComWinget 'Git' 'Git.Git')) { $git = Find-Git }
            if (-not $git) {
                $problema = 'o Git nao esta instalado. Instale o Git (git-scm.com) e rode de novo.'
            } else {
                Write-Host "  baixando o Apoio Local em $PastaApoio (o repositorio e privado: se o GitHub pedir login, entre com a sua conta)..."
                & $git clone $urlApoio $PastaApoio | Out-Host
                if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $candidato -PathType Leaf)) {
                    $servidorApoio = $candidato
                } else {
                    $problema = "nao consegui baixar $urlApoio. Confira o login do GitHub no Git e rode de novo."
                }
            }
        }
    }

    # Copia que e um clone do git: traz a versao nova, sem forcar.
    if ($servidorApoio -and $atualizar -and -not $SemInstalar) {
        $pastaGit = Split-Path -Parent $servidorApoio
        $git = Find-Git
        if ($git -and (Test-Path -LiteralPath (Join-Path $pastaGit '.git'))) {
            Write-Host "  atualizando a copia em $pastaGit..."
            & $git -C $pastaGit pull --ff-only | Out-Host
            if ($LASTEXITCODE -ne 0) { Write-Host "  nao deu para atualizar (ha mudancas locais?): sigo com a copia atual." }
        }
    }

    # Python: ambiente proprio (.venv) ao lado do servidor, com as versoes do requirements.txt.
    $pythonApoio = $null
    if (-not $problema) {
        $pyBase = Find-Python
        if (-not $pyBase -and (Instalar-ComWinget 'Python 3.12' 'Python.Python.3.12')) { $pyBase = Find-Python }
        $pastaServidor = Split-Path -Parent $servidorApoio
        $requisitos = Join-Path $pastaServidor 'requirements.txt'
        if (Test-Path -LiteralPath $requisitos -PathType Leaf) {
            $venv = Join-Path $pastaServidor '.venv'
            $pyVenv = Find-PythonVenv $venv
            if (-not $pyVenv) {
                if (-not $pyBase) {
                    $problema = 'o Python 3.12 ou mais novo nao foi encontrado. Instale pelo python.org (marque "Add to PATH") e rode de novo.'
                } else {
                    Write-Host "  criando o ambiente Python do Apoio Local em $venv..."
                    & $pyBase -m venv $venv | Out-Host
                    $pyVenv = Find-PythonVenv $venv
                    if (-not $pyVenv) { $problema = "nao consegui criar o ambiente Python em $venv." }
                }
            }
            if (-not $problema) {
                Write-Host "  conferindo as dependencias (pip)..."
                & $pyVenv -m pip install --disable-pip-version-check -q -r $requisitos | Out-Host
                if ($LASTEXITCODE -ne 0) {
                    $problema = "o pip nao conseguiu instalar as dependencias de $requisitos. Veja a mensagem acima."
                } else {
                    $pythonApoio = $pyVenv
                }
            }
        } elseif (-not $pyBase) {
            $problema = 'o Python 3.12 ou mais novo nao foi encontrado. Instale pelo python.org (marque "Add to PATH") e rode de novo.'
        } else {
            $pythonApoio = $pyBase
        }
        if ($pythonApoio -and -not $problema) {
            & $pythonApoio -c 'import mcp' 2>$null | Out-Null
            if ($LASTEXITCODE -ne 0) {
                $problema = "o Python $pythonApoio nao tem o pacote mcp. Na pasta do Apoio Local, rode: `"$pythonApoio`" -m pip install -r requirements.txt"
            }
        }
    }

    # Ollama deste computador: liga, instala e baixa o modelo se faltar. Se o registro
    # aponta para outro Ollama (atalho para o PC de casa), nao mexe.
    $envApoio = [ordered]@{}
    if (-not $problema) {
        $urlOllama = 'http://127.0.0.1:11434'
        $urlRegistrada = ''
        if ($envAtual -and $envAtual.PSObject.Properties['APOIO_LOCAL_URL']) { $urlRegistrada = "$($envAtual.APOIO_LOCAL_URL)".Trim() }
        if ($ApoioEmpresa) {
            # Principal: o Ollama do PC de casa, pelo atalho 127.0.0.1:11435 que o script do
            # Apoio cria (Tailscale + portproxy). O Ollama desta maquina, se houver, vira reserva.
            $scriptRede = Join-Path (Split-Path -Parent $servidorApoio) 'remoto\empresa_ligar.ps1'
            $argsRede = @('-SoRede')
            if ($NomeCasa) { $argsRede += @('-Casa', $NomeCasa) }
            if ((Test-Path -LiteralPath $scriptRede -PathType Leaf) -and -not (Select-String -LiteralPath $scriptRede -Pattern 'SoRede' -Quiet)) {
                Write-Host "  ATENCAO: a copia do Apoio Local e antiga (o script do trabalho nao tem -SoRede). Atualize a copia (git pull) e rode de novo."
            } else {
                Rodar-ScriptApoio $scriptRede $argsRede 'Atalho para o Ollama de casa (Tailscale; pede administrador uma vez)'
            }
            $envApoio['APOIO_LOCAL_URL'] = 'http://127.0.0.1:11435'
            if ($ModeloApoio) { $envApoio['APOIO_LOCAL_MODELO'] = $ModeloApoio }
            if ($null -ne (Get-ModelosOllama $urlOllama)) {
                $envApoio['APOIO_LOCAL_URL_RESERVA'] = $urlOllama
                Write-Host "  Ollama deste computador achado: vira a reserva quando o de casa nao responder."
            }
            Write-Host "  Ollama principal: o de casa, por http://127.0.0.1:11435."
        } elseif ($urlRegistrada -and $urlRegistrada -notmatch '^https?://(127\.0\.0\.1|localhost|\[::1\]):11434/?$') {
            Write-Host "  Ollama: o registro atual usa $urlRegistrada; mantido, sem mexer no Ollama deste computador."
        } else {
            $modelos = Get-ModelosOllama $urlOllama
            $ollama = Find-Ollama
            if ($null -eq $modelos) {
                if (-not $ollama -and (Instalar-ComWinget 'Ollama' 'Ollama.Ollama')) { $ollama = Find-Ollama }
                if ($ollama -and $env:OS -eq 'Windows_NT') {
                    Write-Host "  ligando o Ollama..."
                    Ligar-Ollama $ollama
                    for ($i = 0; $i -lt 30 -and $null -eq $modelos; $i++) {
                        Start-Sleep -Seconds 1
                        $modelos = Get-ModelosOllama $urlOllama
                    }
                }
            }
            if ($null -eq $modelos) {
                Write-Host "  ATENCAO: o Ollama nao respondeu em $urlOllama. O Apoio Local fica registrado e funciona quando o Ollama estiver aberto com um modelo (sugestao: ollama pull $ModeloApoio)."
            } else {
                $locais = @($modelos | Where-Object { $_ -notmatch 'cloud' })
                $temModelo = [bool]($ModeloApoio -and (($locais -contains $ModeloApoio) -or ($locais -contains "$($ModeloApoio):latest")))
                if (-not $temModelo -and $locais.Count -eq 0 -and $ModeloApoio) {
                    if ($SemInstalar -or -not $ollama) {
                        Write-Host "  ATENCAO: o Ollama nao tem nenhum modelo. Rode: ollama pull $ModeloApoio"
                    } else {
                        Write-Host "  o Ollama nao tem nenhum modelo: baixando $ModeloApoio (o gemma4:12b tem uns 8 GB; pode demorar)..."
                        & $ollama pull $ModeloApoio
                        $temModelo = ($LASTEXITCODE -eq 0)
                        if (-not $temModelo) { Write-Host "  o download do modelo falhou. Rode depois: ollama pull $ModeloApoio" }
                    }
                }
                if ($temModelo) {
                    $envApoio['APOIO_LOCAL_MODELO'] = $ModeloApoio
                    Write-Host "  modelo fixado: $ModeloApoio"
                } elseif ($locais.Count -gt 0) {
                    Write-Host "  $ModeloApoio nao esta instalado: o Apoio Local usa o maior modelo que achar ($($locais -join ', ')). Para fixar, rode 'ollama pull $ModeloApoio' e este instalador de novo."
                }
            }
        }
    }
    $ErrorActionPreference = 'Stop'

    if ($problema) {
        Write-Host "  nao registrado: $problema"
    } else {
        $entrada = [ordered]@{ command = $pythonApoio; args = @($servidorApoio) }
        # Normalmente, ajustes que ja estavam no registro (env) prevalecem sobre os do
        # instalador. Com -ApoioEmpresa, o pedido e explicito: os do instalador prevalecem.
        $modoApoio = 'substituir-manter-env'
        if ($ApoioEmpresa) {
            $mesclado = [ordered]@{}
            if ($envAtual) { foreach ($p in $envAtual.PSObject.Properties) { $mesclado[$p.Name] = $p.Value } }
            foreach ($k in @($envApoio.Keys)) { $mesclado[$k] = $envApoio[$k] }
            $envApoio = $mesclado
            if ($atual -and $atual.PSObject.Properties['type']) { $entrada['type'] = $atual.type }
            $modoApoio = 'substituir'
        }
        if ($envApoio.Count -gt 0) { $entrada['env'] = $envApoio }
        $modeloApoioJson = Join-Path ([System.IO.Path]::GetTempPath()) ("apoio-local-" + [guid]::NewGuid().ToString('N') + '.json')
        $modeloTexto = (@{ mcpServers = @{ 'apoio-local' = $entrada } } | ConvertTo-Json -Depth 6)
        [System.IO.File]::WriteAllText($modeloApoioJson, $modeloTexto, $utf8)
        try {
            Registrar-Servidor 'Apoio Local, registro' 'apoio-local' $modeloApoioJson $pythonApoio $modoApoio
        } finally {
            Remove-Item -LiteralPath $modeloApoioJson -Force -ErrorAction SilentlyContinue
        }

        # PC da placa de video: publica o Ollama so para os aparelhos da conta Tailscale.
        if ($ApoioCasa) {
            Rodar-ScriptApoio (Join-Path (Split-Path -Parent $servidorApoio) 'remoto\casa_ligar.ps1') @() 'Acesso ao Ollama a partir dos seus outros computadores (Tailscale)'
        }
    }
}

Write-Host ""
Write-Host "Pronto. Abra o app do Claude e comece uma conversa nova para carregar tudo."
