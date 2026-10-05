$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$url = 'http://127.0.0.1:4178'
$ready = $false
try { Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 1 | Out-Null; $ready = $true } catch { }
if (-not $ready) {
  Start-Process -FilePath 'node.exe' -ArgumentList 'dist/server/index.js' -WorkingDirectory $projectRoot -WindowStyle Hidden
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 400
    try { Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 1 | Out-Null; $ready = $true; break } catch { }
  }
}
if ($ready) { Start-Process $url }
else { Start-Process 'https://nodejs.org/en/download' }
