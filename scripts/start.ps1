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
if ($Test) { & $nodeExecutable --import tsx --test 'tests/*.test.ts' }
else { & $nodeExecutable 'dist\src\main.js' }
exit $LASTEXITCODE
