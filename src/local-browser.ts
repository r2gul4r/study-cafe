import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

export function defaultDataDir(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
) {
  if (env.STUDY_CAFE_DATA_DIR?.trim()) return env.STUDY_CAFE_DATA_DIR;
  if (platform !== "win32")
    return join(
      env.LOCALAPPDATA ?? join(home, ".local", "share"),
      "study-cafe",
    );
  // Packaged Windows apps virtualize AppData. The profile directory is shared
  // with ordinary desktop launches, so both must use this location.
  const directory = join(home, ".study-cafe");
  const legacy = join(
    env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
    "study-cafe",
  );
  if (
    !existsSync(join(directory, "study-cafe.db")) &&
    existsSync(join(legacy, "study-cafe.db"))
  )
    throw new Error(
      `기존 공부방 데이터가 ${legacy}에 있습니다. 서버를 종료하고 백업한 뒤 ${directory}로 이전하세요. 빈 DB는 만들지 않았습니다.`,
    );
  return directory;
}
export function openBrowser(url: string): Promise<void> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    !parsed.port ||
    parsed.username ||
    parsed.password
  )
    throw new Error("로컬 공부방 주소만 열 수 있습니다.");
  const [command, args] =
    process.platform === "win32"
      ? (["rundll32.exe", ["url.dll,FileProtocolHandler", url]] as const)
      : process.platform === "darwin"
        ? (["open", [url]] as const)
        : (["xdg-open", [url]] as const);
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("브라우저를 열지 못했습니다.")),
    );
  });
}
