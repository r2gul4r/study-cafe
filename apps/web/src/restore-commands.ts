// Literal PowerShell single-quoted arguments; paths are never executed in the UI.
const quote = (s: string) => "'" + s.trim().replaceAll("'", "''") + "'";
export function restoreCommands(source: string, target: string) {
  return `pnpm restore ${quote(source)} ${quote(target)}\nif ($LASTEXITCODE -ne 0) { throw '복원에 실패했습니다. 서버를 시작하지 않습니다.' }\n$env:STUDY_CAFE_DATA_DIR = ${quote(target)}\npnpm start`;
}
