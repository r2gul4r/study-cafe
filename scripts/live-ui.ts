// Real Codex, isolated study records; no paid API fallback. Keep the printed
// data directory to inspect/restart the same verification session later.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../src/app.js";
const dataDir =
  process.env.STUDY_CAFE_LIVE_DATA_DIR ??
  mkdtempSync(join(tmpdir(), "study-cafe-live-ui-"));
const { app } = await createApp({
  dataDir,
  token: "live-ui-local",
  webDir: resolve("apps/web/dist"),
  allowedOrigins: ["http://127.0.0.1:4320"],
});
await app.listen({ host: "127.0.0.1", port: 4320 });
console.log(
  `Real Codex verification: http://127.0.0.1:4320 | token: live-ui-local\nData: ${dataDir}`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void app.close().then(() => process.exit(0)));
