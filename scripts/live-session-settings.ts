// Real Codex inference, isolated from the learner's data. Requires explicit --live.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Store } from "../src/store.js";
import { Catalog } from "../src/catalog.js";
import { CodexAgent } from "../src/agent.js";
import { AgentSettings } from "../src/agent-settings.js";
import { GoalSessions } from "../src/goal-sessions.js";
import { id, now } from "../src/core.js";

assert.ok(
  process.argv.includes("--live"),
  "Pass --live to use the Codex account.",
);
const dir = mkdtempSync(join(tmpdir(), "study-live-models-"));
let store = new Store(dir);
let agent = new CodexAgent({ cwd: join(dir, "worker"), timeoutMs: 120000 });
const report: Record<string, unknown> = {
  startedAt: now(),
  dir,
  passed: false,
};
try {
  const catalog = new Catalog(store);
  const goal = catalog.goal({ title: "[검증] 공부 세션 모델 변경" });
  const jobId = id();
  store.run(
    "INSERT INTO jobs(id,kind,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    jobId,
    "probe",
    JSON.stringify({ goalId: goal.id }),
    "succeeded",
    now(),
    now(),
  );
  const token = `cafe-${id()}`;
  const first = { model: "gpt-6.1-sol", effort: "low" };
  const second = { model: "gpt-6-luna", effort: "high" };
  await new AgentSettings(store, agent).save(goal.id, first);
  const schema = z.object({ remembered: z.string() }).strict();
  const a = await new GoalSessions(catalog, agent).ask(
    jobId,
    "plan_goal",
    {
      instruction: `Remember this exact private phrase for the next turn: ${token}. Return it as remembered. Do not use tools.`,
    },
    schema,
    {},
  );
  assert.equal(a.remembered, token);
  const threadBefore = store.one(
    "SELECT thread_id FROM goal_sessions WHERE goal_id=?",
    goal.id,
  ).thread_id;
  await agent.close();
  store.close();
  store = new Store(dir);
  agent = new CodexAgent({ cwd: join(dir, "worker"), timeoutMs: 120000 });
  assert.deepEqual(
    new AgentSettings(store, agent).read(goal.id).configuration,
    first,
  );
  await new AgentSettings(store, agent).save(goal.id, second);
  const b = await new GoalSessions(new Catalog(store), agent).ask(
    jobId,
    "plan_goal",
    {
      instruction:
        "Return the exact private phrase you were told to remember in the previous turn as remembered. It is not in the database context. Do not use tools.",
    },
    schema,
    {},
  );
  const threadAfter = store.one(
    "SELECT thread_id FROM goal_sessions WHERE goal_id=?",
    goal.id,
  ).thread_id;
  assert.equal(threadAfter, threadBefore);
  assert.equal(b.remembered, token);
  Object.assign(report, {
    passed: true,
    goalId: goal.id,
    first,
    second,
    threadId: threadAfter,
    sameThread: true,
    rememberedAcrossModelChange: true,
    restarted: true,
  });
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await agent.close();
  store.close();
  report.finishedAt = now();
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
