// Opt-in live probe. Uses the existing Codex login and a separate temporary DB.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CodexAgent } from "../src/agent.js";
import { Store } from "../src/store.js";
import { Catalog } from "../src/catalog.js";
import { GoalSessions } from "../src/goal-sessions.js";
import { id, now } from "../src/core.js";

if (!process.argv.includes("--live")) {
  console.log(
    "Run with --live to use the signed-in Codex account for three small calls.",
  );
  process.exit(0);
}
const dir = mkdtempSync(join(tmpdir(), "study-goal-session-live-"));
const makeAgent = () =>
  new CodexAgent({
    cwd: join(dir, "worker"),
    model: process.env.STUDY_CAFE_MODEL,
    effort: "low",
    timeoutMs: 120_000,
  });
let store = new Store(dir),
  agent = makeAgent();
try {
  assert.equal(
    (await agent.status()).authenticated,
    true,
    "Codex login required",
  );
  const goal = new Catalog(store).goal({ title: "Session continuity probe" });
  const jobId = id(),
    marker = id();
  store.run(
    "INSERT INTO jobs(id,kind,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    jobId,
    "probe",
    JSON.stringify({ goalId: goal.id }),
    "succeeded",
    now(),
    now(),
  );
  const schema = z.object({ value: z.string() }).strict();
  const first = await new GoalSessions(new Catalog(store), agent).ask(
    jobId,
    "plan_goal",
    {
      instruction: `This is only a session continuity check, not a real planning task. Remember this probe marker in conversation: ${marker}. Return it in value. Do not use tools.`,
    },
    schema,
    {},
  );
  assert.equal(first.value, marker);
  const threadId = store.one(
    "SELECT thread_id FROM goal_sessions WHERE goal_id=?",
    goal.id,
  ).thread_id;
  console.log(JSON.stringify({ firstCall: "passed" }));
  await agent.close();
  store.close();
  store = new Store(dir);
  agent = makeAgent();
  const events: unknown[] = [];
  const sessions = new GoalSessions(new Catalog(store), agent);
  const resumed = await sessions.ask(
    jobId,
    "summarize_misconceptions",
    {
      instruction:
        "This is only a conversation continuity check. Return the exact probe marker from the previous user task in value. It is intentionally absent from the DB snapshot. Do not use tools.",
    },
    schema,
    { onProgress: (event) => events.push(event) },
  );
  assert.equal(resumed.value, marker);
  assert.equal(
    store.one("SELECT thread_id FROM goal_sessions WHERE goal_id=?", goal.id)
      .thread_id,
    threadId,
  );
  console.log(
    JSON.stringify({
      processRestart: "passed",
      dbReopen: "passed",
      rememberedMarker: true,
      events,
    }),
  );
  const isolated = await sessions.ask(
    jobId,
    "review_short_answer",
    {
      instruction:
        "Return a probe marker only if one is present in this conversation. If no marker was provided in this conversation, return value=NO_MARKER. Do not invent a marker or use tools.",
    },
    schema,
    {},
  );
  assert.equal(isolated.value, "NO_MARKER");
  console.log(
    JSON.stringify({ isolatedReview: "passed", calls: 3, dataDir: dir }),
  );
} finally {
  await agent.close();
  store.close();
}
