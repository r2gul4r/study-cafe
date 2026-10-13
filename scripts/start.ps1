param([switch]$Test)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$bundledRuntime = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node'
$nodeExecutable = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $bundledRuntime 'bin\node.exe' }
if (-not (Test-Path -LiteralPath $nodeExecutable)) { throw 'Node.js 24 or newer is required.' }
$nodeMajor = [int]((& $nodeExecutable --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 24) { throw 'Node.js 24 or newer is required.' }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\typescript'))) {
  $pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
  $bundledPnpm = Join-Path $bundledRuntime 'node_modules\pnpm\bin\pnpm.cjs'
  if ($pnpmCommand) { & $pnpmCommand.Source install --frozen-lockfile }
  elseif (Test-Path -LiteralPath $bundledPnpm) { & $nodeExecutable $bundledPnpm install --frozen-lockfile }
  else { throw 'Install pnpm 10.18.3, then run pnpm install --frozen-lockfile.' }
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
if (-not $env:CODEX_BIN -and -not (Get-Command codex -ErrorAction SilentlyContinue)) {
  $codexDirectory = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
  if (Test-Path -LiteralPath $codexDirectory) {
    $codexExecutable = Get-ChildItem -LiteralPath $codexDirectory -Filter codex.exe -File -Recurse | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($codexExecutable) { $env:CODEX_BIN = $codexExecutable.FullName }
  }
}
& $nodeExecutable 'node_modules\typescript\bin\tsc'
if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed.' }
if (-not $Test) {
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'apps\web\node_modules\vite'))) {
    $webPnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    $bundledWebPnpm = Join-Path $bundledRuntime 'node_modules\pnpm\bin\pnpm.mjs'
    $bundledWebPnpmCjs = Join-Path $bundledRuntime 'node_modules\pnpm\bin\pnpm.cjs'
    if ($webPnpm) { & $webPnpm.Source --dir apps/web install --frozen-lockfile }
    elseif (Test-Path -LiteralPath $bundledWebPnpm) { & $nodeExecutable $bundledWebPnpm --dir apps/web install --frozen-lockfile }
    elseif (Test-Path -LiteralPath $bundledWebPnpmCjs) { & $nodeExecutable $bundledWebPnpmCjs --dir apps/web install --frozen-lockfile }
    else { throw 'Run pnpm --dir apps/web install --frozen-lockfile first.' }
    if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
  }
  & $nodeExecutable 'apps\web\node_modules\typescript\bin\tsc' --noEmit -p apps/web
  if ($LASTEXITCODE -ne 0) { throw 'Frontend type check failed.' }
  & $nodeExecutable 'apps\web\node_modules\vite\bin\vite.js' build apps/web --logLevel warn
  if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
}
if ($Test) { & $nodeExecutable --import tsx --test 'tests/*.test.ts' }
else { & $nodeExecutable 'dist\src\main.js' }
exit $LASTEXITCODE
