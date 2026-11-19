$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Test-Path ".venv")) { py -3 -m venv .venv }
& ".venv\Scripts\python.exe" -m pip install --upgrade pip
& ".venv\Scripts\python.exe" -m pip install -r requirements.txt
if (-not $env:ETI_MT5_BRIDGE_TOKEN) {
  $env:ETI_MT5_BRIDGE_TOKEN = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
}
if (-not $env:ETI_MT5_LIVE_TRADING) { $env:ETI_MT5_LIVE_TRADING = "false" }
Write-Host "ETI MT5 Bridge: http://127.0.0.1:8765"
Write-Host "Bridge bearer token (store securely; shown once): $env:ETI_MT5_BRIDGE_TOKEN"
Write-Host "Live trading enabled: $env:ETI_MT5_LIVE_TRADING"
& ".venv\Scripts\python.exe" -m uvicorn bridge:APP --host 127.0.0.1 --port 8765
