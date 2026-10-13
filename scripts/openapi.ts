import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
const service = await createApp({
  dataDir: mkdtempSync(join(tmpdir(), "study-cafe-spec-")),
  token: "spec-only",
  autoWorker: false,
});
try {
  const result = await service.app.inject({
    url: "/api/openapi.json",
    headers: { authorization: "Bearer spec-only" },
  });
  writeFileSync(
    process.argv[2] ?? "openapi.json",
    JSON.stringify(result.json(), null, 2),
  );
} finally {
  await service.app.close();
}
