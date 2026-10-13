import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createApp } from "./app.js";
const dataDir =
  process.env.STUDY_CAFE_DATA_DIR ??
  join(
    process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share"),
    "study-cafe",
  );
const port = Number(process.env.PORT ?? 4317);
const origins = (
  process.env.STUDY_CAFE_ALLOWED_ORIGINS ??
  `http://127.0.0.1:${port},http://localhost:${port},http://127.0.0.1:5173,http://localhost:5173`
).split(",");
const { app } = await createApp({
  dataDir,
  allowedOrigins: origins,
  webDir: resolve("apps/web/dist"),
});
await app.listen({ host: "127.0.0.1", port });
console.log(
  `study-cafe backend: http://127.0.0.1:${port}\nData: ${dataDir}\nAuthorization token file: ${join(dataDir, "session-token")}`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
