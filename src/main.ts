import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { createApp } from "./app.js";
import { defaultDataDir, openBrowser } from "./local-browser.js";
const dataDir = defaultDataDir();
const port = Number(process.env.PORT ?? 4317);
const origins = (
  process.env.STUDY_CAFE_ALLOWED_ORIGINS ??
  `http://127.0.0.1:${port},http://localhost:${port},http://127.0.0.1:5173,http://localhost:5173`
).split(",");
const { app, browserSessions } = await createApp({
  dataDir,
  allowedOrigins: origins,
  webDir: resolve("apps/web/dist"),
});
await app.listen({ host: "127.0.0.1", port });
const actualPort = (app.server.address() as import("node:net").AddressInfo)
  .port;
const host = `127.0.0.1:${actualPort}`;
const url = `http://${host}/`;
writeFileSync(join(dataDir, "server-address.json"), JSON.stringify({ url }), {
  mode: 0o600,
});
console.log(
  `study-cafe: ${url}\nData: ${dataDir}\n다시 열기: pnpm open (같은 데이터 폴더 설정 사용)`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
if (process.env.STUDY_CAFE_NO_OPEN !== "1")
  void openBrowser(`${url}#/connect?code=${browserSessions.issue(host)}`).catch(
    () => {
      console.error(
        "브라우저를 열지 못했어요. 서버를 실행한 상태에서 pnpm open 또는 .\\scripts\\start.ps1 -Open을 실행해 주세요.",
      );
    },
  );
