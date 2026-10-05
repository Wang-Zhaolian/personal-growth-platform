$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:LOCALAPPDATA = [Environment]::GetFolderPath('LocalApplicationData')
# This project's private-client approval was confirmed by the user for this installation.
$env:GROWTH_SIWC_ELIGIBILITY = 'approved_private'
$url = 'http://127.0.0.1:4178'
$expected = (Get-Content -LiteralPath (Join-Path $projectRoot 'dist\build-info.json') -Raw | ConvertFrom-Json).id
$entry = Join-Path $projectRoot 'dist\server\index.js'
$ready = $false
try { $health = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 1; $ready = $health.ok -eq $true } catch { }
if ($ready -and $health.buildId -ne $expected) {
  try {
    $authState = Invoke-RestMethod -Uri "$url/api/ai/status" -TimeoutSec 2
    if (@('starting','waiting','exchanging','saving') -contains $authState.login.phase) {
      Start-Process $url
      exit
    }
  } catch { }
  $listener = Get-NetTCPConnection -LocalPort 4178 -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -First 1
  if (-not $listener) { throw '4178 端口上的旧服务无法识别，请手动关闭后重试。' }
  $running = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
  $ownExecutable = $running.ExecutablePath -and ([IO.Path]::GetFileName($running.ExecutablePath) -ieq 'node.exe')
  $ownCommand = $running.CommandLine -and ($running.CommandLine.Contains($entry) -or $running.CommandLine.Trim() -eq 'node  dist/server/index.js' -or $running.CommandLine.Trim() -eq 'node dist/server/index.js')
  $ownPage = $false
  try { $ownPage = (Invoke-WebRequest -Uri $url -TimeoutSec 2 -UseBasicParsing).Content.Contains('昭濂个人成长平台') } catch { }
  if (-not ($ownExecutable -and $ownCommand -and $ownPage)) { throw '4178 端口上的服务与本项目不匹配，未结束其他进程。' }
  Stop-Process -Id $running.ProcessId
  Start-Sleep -Milliseconds 600
  $ready = $false
}
if (-not $ready) {
  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw '请先安装 Node.js 22.19 或更新版本。' }
  Start-Process -FilePath 'node.exe' -ArgumentList ('"' + $entry + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 400
    try {
      $health = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 1
      if ($health.ok -and $health.buildId -eq $expected) { $ready = $true; break }
    } catch { }
  }
}
if (-not $ready) { throw '新版服务未能启动。请在项目目录运行 npm start 查看原因。' }
Start-Process $url
