#!/usr/bin/env bash
# Instala ou atualiza a equipe de agentes no Linux (Ubuntu 24.04 ou Debian 12, ou mais novos).
#
# Uso, num terminal (pede a senha do sudo só se faltar algum programa):
#
#   curl -fsSL https://raw.githubusercontent.com/renangr87/claude-equipe-agentes/main/instalar-linux.sh | bash
#
# Com opções do instalar.ps1 (por exemplo a memória entre computadores):
#
#   curl -fsSL https://raw.githubusercontent.com/renangr87/claude-equipe-agentes/main/instalar-linux.sh | bash -s -- -Memoria https://github.com/<você>/claude-memoria
#
# O que faz:
#   1. instala o que faltar: git, curl, Node.js 22 (o do apt é velho demais), PowerShell 7
#      (a guarda de terminal dos agentes roda nele) e Python 3 com venv (para o Apoio Local);
#   2. baixa a equipe em ~/claude-equipe-agentes (ou faz git pull, se já estiver lá);
#   3. roda o instalar.ps1 no PowerShell 7, com as opções que você passou.
# Rodado de novo, atualiza: é o mesmo que o atualizar-equipe.bat faz no Windows.
set -euo pipefail

repo="https://github.com/renangr87/claude-equipe-agentes"
pasta="$HOME/claude-equipe-agentes"

tem() { command -v "$1" >/dev/null 2>&1; }

# Node 20.19 ou mais novo (os hooks usam recursos dessa versão).
node_bom() {
  tem node || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=19)?0:1)'
}

faltam_apt=()
tem git || faltam_apt+=(git)
tem curl || faltam_apt+=(curl)
if tem python3; then
  python3 -c 'import venv, ensurepip' 2>/dev/null || faltam_apt+=(python3-venv)
else
  faltam_apt+=(python3 python3-venv)
fi
if [ ${#faltam_apt[@]} -gt 0 ]; then
  echo "Instalando pelo apt: ${faltam_apt[*]}"
  sudo apt-get update -qq
  sudo apt-get install -y "${faltam_apt[@]}"
fi

if ! node_bom; then
  echo "Instalando o Node.js 22 (snap)..."
  sudo snap install node --classic --channel=22/stable
  hash -r
fi
if ! tem pwsh; then
  echo "Instalando o PowerShell 7 (snap)..."
  sudo snap install powershell --classic
  hash -r
fi
# O snap põe os programas em /snap/bin, que pode não estar no PATH desta sessão.
case ":$PATH:" in *:/snap/bin:*) ;; *) export PATH="$PATH:/snap/bin" ;; esac

if [ -d "$pasta/.git" ]; then
  echo "Atualizando $pasta..."
  git -C "$pasta" pull --ff-only || echo "Não deu para atualizar (há mudanças locais?): sigo com a versão que está na pasta."
elif [ -e "$pasta" ]; then
  echo "A pasta $pasta já existe e não é um clone do git: uso como está."
else
  echo "Baixando a equipe em $pasta..."
  git clone "$repo" "$pasta"
fi

exec pwsh -NoProfile -File "$pasta/instalar.ps1" "$@"
