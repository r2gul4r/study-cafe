$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop '공부방.lnk'
$shell = New-Object -ComObject WScript.Shell
if (Test-Path -LiteralPath $shortcutPath) {
  $existing = $shell.CreateShortcut($shortcutPath)
  if ($existing.Arguments -notlike ('*' + (Join-Path $PSScriptRoot 'launch.ps1') + '*')) {
    throw 'A different shortcut with this name already exists.'
  }
}
$icon = Join-Path $projectRoot 'assets\study-cafe.ico'
if (-not (Test-Path -LiteralPath $icon)) { throw 'Run node scripts/build-icon.mjs first.' }
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'launch.ps1') + '"'
$shortcut.WorkingDirectory = $projectRoot
$shortcut.IconLocation = $icon + ',0'
$shortcut.Description = '공부방 - 목표부터 오답 복습까지'
$shortcut.WindowStyle = 7
$shortcut.Save()
$saved = $shell.CreateShortcut($shortcutPath)
[PSCustomObject]@{Path=$shortcutPath;Target=$saved.TargetPath;Arguments=$saved.Arguments;WorkingDirectory=$saved.WorkingDirectory;Icon=$saved.IconLocation} | ConvertTo-Json
