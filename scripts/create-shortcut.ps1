$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$launchScript = (Resolve-Path (Join-Path $PSScriptRoot 'launch.ps1')).Path
$desktop = [Environment]::GetFolderPath('Desktop')
$newShortcutPath = Join-Path $desktop '昭濂个人成长平台.lnk'
$shell = New-Object -ComObject WScript.Shell
$expectedTarget = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Test-ThisProjectShortcut([string]$path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
  $existing = $shell.CreateShortcut($path)
  $targetMatches = [string]::Equals([IO.Path]::GetFullPath($existing.TargetPath), [IO.Path]::GetFullPath($expectedTarget), [StringComparison]::OrdinalIgnoreCase)
  $argumentsMatch = $existing.Arguments.IndexOf($launchScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
  return $targetMatches -and $argumentsMatch
}

if (Test-Path -LiteralPath $newShortcutPath -PathType Leaf) {
  if (-not (Test-ThisProjectShortcut $newShortcutPath)) {
    throw "桌面已存在同名但指向其他程序的快捷方式，未覆盖：$newShortcutPath"
  }
}

foreach ($candidate in Get-ChildItem -LiteralPath $desktop -Filter '*.lnk' -File) {
  if ([string]::Equals($candidate.FullName, $newShortcutPath, [StringComparison]::OrdinalIgnoreCase)) { continue }
  if (Test-ThisProjectShortcut $candidate.FullName) { Remove-Item -LiteralPath $candidate.FullName -Force }
}

$shortcut = $shell.CreateShortcut($newShortcutPath)
$shortcut.TargetPath = $expectedTarget
$shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launchScript`""
$shortcut.WorkingDirectory = $projectRoot
$shortcut.Description = '启动昭濂个人成长平台'
$shortcut.IconLocation = "$(Join-Path $projectRoot 'public\favicon.ico'),0"
$shortcut.Save()
Write-Output "已创建桌面快捷方式：$newShortcutPath"
