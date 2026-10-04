$ErrorActionPreference = "Stop"
$env:GROWTH_SITE_ORIGIN = "https://personal-growth-hub-wang.zhaolian689.chatgpt.site"
$assistantRoot = Join-Path $PSScriptRoot "..\assistant"
$localUrl = "http://127.0.0.1:41739/"

try {
  Invoke-WebRequest -Uri $localUrl -Method Get -TimeoutSec 1 -UseBasicParsing | Out-Null
} catch {
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  Start-Process -FilePath $node -ArgumentList 'server.mjs' -WorkingDirectory $assistantRoot -WindowStyle Hidden | Out-Null
  $ready = $false
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 300
    try {
      Invoke-WebRequest -Uri $localUrl -Method Get -TimeoutSec 1 -UseBasicParsing | Out-Null
      $ready = $true
      break
    } catch { }
  }
  if (-not $ready) { throw "本机 AI 助手未能启动。请检查 Node.js 22.13 或更高版本是否已安装。" }
}

Start-Process -FilePath $env:GROWTH_SITE_ORIGIN
