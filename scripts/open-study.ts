import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultDataDir, openBrowser } from "../src/local-browser.js";

// Only the local launcher reads the root token; it never puts it in a URL/log.
try {
  const dir = defaultDataDir();
  const { url } = JSON.parse(
    readFileSync(join(dir, "server-address.json"), "utf8"),
  );
  const base = new URL(url);
  if (
    base.protocol !== "http:" ||
    base.hostname !== "127.0.0.1" ||
    !base.port ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error("Invalid local server address");
  const token = readFileSync(join(dir, "session-token"), "utf8").trim();
  const origin = process.argv[2] ?? base.origin;
  const response = await fetch(new URL("/api/browser/launch", base), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ origin }),
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Server unavailable");
  const grant = (await response.json()) as { url: string };
  if (new URL(grant.url).origin !== origin)
    throw new Error("Invalid launch origin");
  await openBrowser(grant.url);
  console.log(
    "공부방을 열었어요. 이 브라우저에서는 다음에도 자동으로 연결됩니다.",
  );
} catch {
  console.error(
    "공부방을 열지 못했어요. 로컬 서버와 데이터 폴더 설정을 확인한 뒤 다시 실행해 주세요.",
  );
  process.exitCode = 1;
}
