param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodeExecutable = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
$mutex = [System.Threading.Mutex]::new($false, 'Local\StudyCafeDesktopLauncher')
$owned = $false
function Open-RunningStudy {
  $address = Join-Path $dataDir 'server-address.json'
  if (-not (Test-Path -LiteralPath $address)) { return $false }
  $base = [Uri]((Get-Content -LiteralPath $address -Raw | ConvertFrom-Json).url)
  if ($base.Scheme -ne 'http' -or $base.Host -ne '127.0.0.1' -or $base.AbsolutePath -ne '/' -or $base.UserInfo -or $base.Query -or $base.Fragment) { throw 'Invalid local server address.' }
  try {
    $health = Invoke-RestMethod -Uri ($base.AbsoluteUri + 'health') -TimeoutSec 2
  } catch [System.Net.WebException] { return $false }
  if ($health.status -ne 'ok') { return $false }
  if (-not $NoBrowser) {
    & $nodeExecutable --import tsx (Join-Path $PSScriptRoot 'open-study.ts')
    if ($LASTEXITCODE -ne 0) { throw 'The study server is running, but browser connection failed.' }
  }
  return $true
}
try {
  try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) { exit 0 }
  if (-not (Test-Path -LiteralPath $nodeExecutable)) { throw 'Node.js 24 or newer is required.' }
  $dataDir = & $nodeExecutable --import tsx (Join-Path $PSScriptRoot 'data-directory.ts')
  if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve the study data directory. See the migration message above.' }
  $dataDir = "$dataDir".Trim()
  if (Open-RunningStudy) { exit 0 }
  $logDir = Join-Path $projectRoot 'output\launcher'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $outLog = Join-Path $logDir "$stamp.stdout.log"
  $errLog = Join-Path $logDir "$stamp.stderr.log"
  $shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $startScript = Join-Path $PSScriptRoot 'start.ps1'
  $worker = Start-Process -FilePath $shell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $startScript + '"'), '-NoBrowser') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
  $deadline = (Get-Date).AddMinutes(3)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 750
    if (Open-RunningStudy) { exit 0 }
    if ($worker.HasExited) { throw "Study server startup failed. See $errLog" }
  }
  throw "Study server startup is taking longer than expected. See $outLog and $errLog"
} catch {
  $failure = $_.Exception.Message
  Write-Error -Message $failure -ErrorAction Continue
  if (-not $NoBrowser) {
    $popup = New-Object -ComObject WScript.Shell
    $null = $popup.Popup($failure, 0, 'Study Cafe - Launch failed', 16)
  }
  exit 1
} finally {
  if ($owned) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
