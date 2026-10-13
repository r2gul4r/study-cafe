import { CodexAgent } from "../src/agent.js";
import { z } from "zod";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const agent = new CodexAgent({
  cwd: mkdtempSync(join(tmpdir(), "study-cafe-codex-probe-")),
  timeoutMs: 90000,
});
try {
  const status = await agent.status();
  console.log(JSON.stringify({ status }));
  if (process.argv.includes("--live")) {
    if (!status.authenticated) throw new Error("Codex login is required.");
    const result = await agent.ask(
      "connection_probe",
      { instruction: "Return ok=true and value=4 for 2+2. Do not use tools." },
      z.object({ ok: z.boolean(), value: z.number() }).strict(),
    );
    if (!result.ok || result.value !== 4)
      throw new Error("Unexpected probe result");
    console.log(JSON.stringify({ inference: "passed", result }));
  }
} finally {
  await agent.close();
}
