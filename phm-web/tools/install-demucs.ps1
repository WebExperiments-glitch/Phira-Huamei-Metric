# 安装 Demucs（MIT）到项目 venv
# 用法: powershell -ExecutionPolicy Bypass -File tools/install-demucs.ps1
$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root '.venv-audio'
if (-not (Test-Path $venv)) {
  python -m venv $venv --system-site-packages
}
& (Join-Path $venv 'Scripts\pip.exe') install --upgrade pip
& (Join-Path $venv 'Scripts\pip.exe') install demucs
Write-Host 'Demucs installed. model: htdemucs; first run downloads ~80MB.'
