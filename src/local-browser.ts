import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultDataDir() {
  return (
    process.env.STUDY_CAFE_DATA_DIR ??
    join(
      process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share"),
      "study-cafe",
    )
  );
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
