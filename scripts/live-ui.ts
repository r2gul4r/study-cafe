// Real Codex, isolated study records; no paid API fallback. Keep the printed
// data directory to inspect/restart the same verification session later.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../src/app.js";
import { openBrowser } from "../src/local-browser.js";
const dataDir =
  process.env.STUDY_CAFE_LIVE_DATA_DIR ??
  mkdtempSync(join(tmpdir(), "study-cafe-live-ui-"));
const { app, browserSessions } = await createApp({
  dataDir,
  token: "live-ui-local",
  webDir: resolve("apps/web/dist"),
  allowedOrigins: ["http://127.0.0.1:4320"],
});
await app.listen({ host: "127.0.0.1", port: 4320 });
console.log(`Real Codex verification: http://127.0.0.1:4320\nData: ${dataDir}`);
if (process.env.STUDY_CAFE_NO_OPEN !== "1")
  void openBrowser(
    `http://127.0.0.1:4320/#/connect?code=${browserSessions.issue("127.0.0.1:4320")}`,
  ).catch(() => console.error("브라우저 자동 열기에 실패했습니다."));
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void app.close().then(() => process.exit(0)));
