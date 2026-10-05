$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop '拾阶 · 个人成长平台.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'launch.ps1')`""
$shortcut.WorkingDirectory = $projectRoot
$shortcut.Description = '启动你的个人成长平台'
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,167"
$shortcut.Save()
Write-Output "已创建桌面快捷方式：$shortcutPath"
