<#
.SYNOPSIS
  Baixa (ou atualiza) a equipe de agentes em <pasta do usuario>\claude-equipe-agentes e
  roda o instalador completo: equipe, mapa do codigo, Apoio Local e, se houver Dart,
  o servidor do Dart.

.DESCRIPTION
  Uso, num PowerShell (nao precisa ser administrador):

    irm https://raw.githubusercontent.com/renangr87/claude-equipe-agentes/main/baixar-e-instalar.ps1 | iex

  Para passar opcoes ao instalar.ps1 (por exemplo -ApoioCasa ou -ApoioEmpresa):

    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/renangr87/claude-equipe-agentes/main/baixar-e-instalar.ps1))) -ApoioCasa

  Se faltar o Git, instala pelo winget (sem winget, baixa o ZIP do repositorio).
  Pode ser rodado de novo para atualizar: faz git pull e reinstala o que mudou.
#>
& {
    $ErrorActionPreference = 'Stop'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $repo  = 'https://github.com/renangr87/claude-equipe-agentes'
    $pasta = Join-Path $HOME 'claude-equipe-agentes'

    function Atualizar-Path {
        $partes = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'), $env:Path)
        $env:Path = (@($partes | Where-Object { $_ }) -join ';')
    }

    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git -and (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Host 'Instalando o Git pelo winget...'
        & winget install --id Git.Git -e --silent --accept-source-agreements --accept-package-agreements | Out-Host
        Atualizar-Path
        $git = Get-Command git -ErrorAction SilentlyContinue
    }

    if (Test-Path -LiteralPath (Join-Path $pasta '.git')) {
        if ($git) {
            Write-Host "Atualizando $pasta..."
            & $git.Source -C $pasta pull --ff-only
            if ($LASTEXITCODE -ne 0) { Write-Host 'Nao deu para atualizar (ha mudancas locais?): sigo com a versao que esta na pasta.' }
        }
    } elseif (Test-Path -LiteralPath $pasta) {
        Write-Host "A pasta $pasta ja existe e nao e um clone do git: uso como esta."
    } elseif ($git) {
        Write-Host "Baixando a equipe em $pasta..."
        & $git.Source clone $repo $pasta
        if ($LASTEXITCODE -ne 0) { throw "Nao consegui baixar $repo." }
    } else {
        Write-Host "Baixando a equipe (ZIP) em $pasta..."
        $zip = Join-Path ([System.IO.Path]::GetTempPath()) ('equipe-' + [guid]::NewGuid().ToString('N') + '.zip')
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('equipe-' + [guid]::NewGuid().ToString('N'))
        Invoke-WebRequest -UseBasicParsing -Uri "$repo/archive/refs/heads/main.zip" -OutFile $zip
        Expand-Archive -LiteralPath $zip -DestinationPath $tmp
        Move-Item -LiteralPath (Join-Path $tmp 'claude-equipe-agentes-main') -Destination $pasta
        Remove-Item -LiteralPath $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }

    $ps = (Get-Process -Id $PID).Path
    & $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $pasta 'instalar.ps1') @args
} @args
