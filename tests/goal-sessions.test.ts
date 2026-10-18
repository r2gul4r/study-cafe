import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { Store } from "../src/store.js";
import { Catalog } from "../src/catalog.js";
import { CodexAgent } from "../src/agent.js";
import { GoalSessions } from "../src/goal-sessions.js";
import { GoalLifecycle } from "../src/goal-lifecycle.js";
import { Jobs } from "../src/jobs.js";
import { id, now, Fault } from "../src/core.js";
import { backup, restoreBackup, verifyBackup } from "../src/backup.js";
import { createApp } from "../src/app.js";

const temp = () => mkdtempSync(join(tmpdir(), "study-goal-sessions-"));
const output = z.object({
  threadId: z.string(),
  history: z.number(),
  input: z.record(z.string(), z.unknown()),
});
const agentAt = (cwd: string, mode = "normal") =>
  new CodexAgent({
    binary: process.execPath,
    args: [resolve("tests/fake-session-codex.mjs"), mode],
    cwd,
    timeoutMs: 5000,
  });
function job(s: Store, input: unknown) {
  const jobId = id();
  s.run(
    "INSERT INTO jobs(id,kind,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    jobId,
    "fixture",
    JSON.stringify(input),
    "succeeded",
    now(),
    now(),
  );
  return jobId;
}
function protocol(cwd: string) {
  return readFileSync(join(cwd, "fake-protocol.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) =>
      z
        .object({
          method: z.string(),
          params: z.record(z.string(), z.unknown()).optional(),
        })
        .parse(JSON.parse(line)),
    );
}

test("goal history survives DB/agent restart, refreshes DB context, and isolates other goals and evaluation", async (t) => {
  const dir = temp(),
    cwd = join(dir, "worker");
  let s = new Store(dir),
    agent = agentAt(cwd);
  t.after(async () => {
    await agent.close();
    s.close();
  });
  let catalog = new Catalog(s),
    sessions = new GoalSessions(catalog, agent);
  const a = catalog.goal({ title: "Python" }),
    b = catalog.goal({ title: "Japanese" });
  const aj = job(s, { goalId: a.id }),
    bj = job(s, { goalId: b.id });
  const first = await sessions.ask(
    aj,
    "plan_goal",
    { answers: "loops" },
    output,
    {},
  );
  assert.equal(first.history, 1);
  assert.equal(
    s.one("SELECT thread_id FROM goal_sessions WHERE goal_id=?", a.id)
      .thread_id,
    first.threadId,
  );
  await agent.close();
  s.close();
  s = new Store(dir);
  agent = agentAt(cwd);
  catalog = new Catalog(s);
  sessions = new GoalSessions(catalog, agent);
  catalog.updateGoal(a.id, { title: "Updated Python" });
  catalog.scope(a.id, {
    title: "New scope",
    concepts: [{ name: "Loop", area: "Python" }],
  });
  const next = await sessions.ask(aj, "research_sources", {}, output, {
    search: true,
  });
  assert.equal(next.threadId, first.threadId);
  assert.equal(next.history, 2);
  const context = z
    .object({
      goal: z.object({
        title: z.string(),
        scope: z.object({ title: z.string() }),
      }),
    })
    .parse(next.input.databaseContext);
  assert.equal(context.goal.title, "Updated Python");
  assert.equal(context.goal.scope.title, "New scope");
  const other = await sessions.ask(bj, "plan_goal", {}, output, {});
  assert.notEqual(other.threadId, first.threadId);
  assert.equal(other.history, 1);
  const isolatedIds = new Set<string>();
  for (const role of [
    "verify_question",
    "audit_rubric",
    "grade_answer",
    "review_short_answer",
    "unknown_role",
  ]) {
    const result = await sessions.ask(
      aj,
      role,
      { question: "only current evidence" },
      output,
      {},
    );
    assert.equal(result.history, 1);
    assert.deepEqual(result.input, { question: "only current evidence" });
    assert.notEqual(result.threadId, first.threadId);
    isolatedIds.add(result.threadId);
  }
  assert.equal(isolatedIds.size, 5);
  assert.equal(s.one("SELECT count(*) AS n FROM goal_sessions").n, 2);
  const again = await sessions.ask(
    aj,
    "summarize_misconceptions",
    {},
    output,
    {},
  );
  assert.equal(
    again.history,
    3,
    "independent evaluations never append to manager history",
  );
  const resumes = protocol(cwd).filter((r) => r.method === "thread/resume");
  assert.equal(resumes[0]?.params?.threadId, first.threadId);
  assert.deepEqual(resumes[0]?.params?.config, {
    "features.shell_tool": false,
    "features.unified_exec": false,
    "features.multi_agent": false,
    "features.apps": false,
    "features.hooks": false,
    "features.remote_plugin": false,
    web_search: "live",
  });
});

test("missing history recovers from DB; a provider error preserves the saved link", async (t) => {
  const dir = temp(),
    cwd = join(dir, "worker"),
    s = new Store(dir),
    catalog = new Catalog(s);
  let agent = agentAt(cwd);
  t.after(async () => {
    await agent.close();
    s.close();
  });
  const goal = catalog.goal({ title: "Recover this goal" });
  const j = job(s, { goalId: goal.id });
  const first = await new GoalSessions(catalog, agent).ask(
    j,
    "plan_goal",
    {},
    output,
    {},
  );
  await agent.close();
  writeFileSync(join(cwd, "fake-history.json"), "{}");
  agent = agentAt(cwd);
  const events: unknown[] = [];
  const recovered = await new GoalSessions(catalog, agent).ask(
    j,
    "plan_goal",
    {},
    output,
    { onProgress: (event) => events.push(event) },
  );
  assert.notEqual(recovered.threadId, first.threadId);
  assert.match(
    JSON.stringify(recovered.input.databaseContext),
    /Recover this goal/,
  );
  assert.deepEqual(events, [
    {
      type: "agent_configuration",
      goalId: goal.id,
      role: "plan_goal",
      configuration: null,
    },
    { type: "goal_session", goalId: goal.id, action: "recovered" },
  ]);
  await agent.close();
  agent = agentAt(cwd, "resume-error");
  await assert.rejects(
    new GoalSessions(catalog, agent).ask(j, "plan_goal", {}, output, {}),
    (error: unknown) => error instanceof Fault && error.code === "CODEX_RPC",
  );
  assert.equal(
    s.one("SELECT thread_id FROM goal_sessions WHERE goal_id=?", goal.id)
      .thread_id,
    recovered.threadId,
  );
  assert.equal(
    protocol(cwd).filter((r) => r.method === "thread/start").length,
    2,
  );
});

test("same-goal requests serialize and cancellation stops the active turn before reuse", async (t) => {
  const dir = temp(),
    cwd = join(dir, "worker"),
    s = new Store(dir),
    agent = agentAt(cwd);
  t.after(async () => {
    await agent.close();
    s.close();
  });
  const catalog = new Catalog(s),
    sessions = new GoalSessions(catalog, agent);
  const goal = catalog.goal({ title: "Concurrent" }),
    j = job(s, { goalId: goal.id });
  const [a, b] = await Promise.all([
    sessions.ask(j, "plan_goal", { delayMs: 30 }, output, {}),
    sessions.ask(j, "research_sources", {}, output, {}),
  ]);
  assert.equal(a.threadId, b.threadId);
  assert.equal(a.history, 1);
  assert.equal(b.history, 2);
  const controller = new AbortController();
  const onTurn = (event: { method: string }) => {
    if (event.method === "turn/started") controller.abort();
  };
  agent.on("notification", onTurn);
  await assert.rejects(
    sessions.ask(j, "plan_goal", { hang: true }, output, {
      signal: controller.signal,
    }),
    (error: unknown) => error instanceof Fault && error.code === "CANCELLED",
  );
  agent.off("notification", onTurn);
  const next = await sessions.ask(j, "plan_goal", {}, output, {});
  assert.equal(next.threadId, a.threadId);
  assert.equal(next.history, 4);
  const log = protocol(cwd);
  assert.ok(
    log.findIndex((r) => r.method === "turn/interrupt") <
      log.findLastIndex((r) => r.method === "turn/start"),
  );
});

test("source jobs resolve their goal and conflicting goal references are rejected", async (t) => {
  const dir = temp(),
    s = new Store(dir),
    agent = agentAt(join(dir, "worker"));
  t.after(async () => {
    await agent.close();
    s.close();
  });
  const catalog = new Catalog(s),
    sessions = new GoalSessions(catalog, agent);
  const goal = catalog.goal({ title: "Source goal" }),
    other = catalog.goal({ title: "Other" });
  const source = catalog.source(goal.id, {
    title: "Source",
    kind: "user_material",
    rights: "user_provided",
    rightsBasis: "Authored fixture",
  });
  const result = await sessions.ask(
    job(s, { sourceId: source.id }),
    "extract_existing_questions",
    {},
    output,
    {},
  );
  assert.equal(result.input.goalId, goal.id);
  await assert.rejects(
    sessions.ask(
      job(s, { goalId: other.id, sourceId: source.id }),
      "extract_existing_questions",
      {},
      output,
      {},
    ),
    (error: unknown) => error instanceof Fault && error.code === "AGENT_GOAL",
  );
});

test("legacy DB/backup migration preserves goals and goal deletion removes the session mapping", async (t) => {
  const dir = temp();
  let s = new Store(dir);
  const catalog = new Catalog(s),
    goal = catalog.goal({ title: "Legacy" });
  s.db.exec("DROP TABLE goal_sessions; PRAGMA user_version=1");
  const saved = backup(s),
    backupDir = join(dir, "backups", saved.id);
  verifyBackup(backupDir);
  s.close();
  s = new Store(dir);
  t.after(() => s.close());
  assert.equal(s.one("PRAGMA user_version").user_version, 4);
  assert.equal(new Catalog(s).readGoal(goal.id).title, "Legacy");
  s.run(
    "INSERT INTO goal_sessions VALUES(?,?,?,?)",
    goal.id,
    "saved-thread",
    now(),
    now(),
  );
  const newBackup = backup(s);
  verifyBackup(join(dir, "backups", newBackup.id));
  const restoredDir = temp();
  restoreBackup(backupDir, restoredDir);
  const restored = new Store(restoredDir);
  assert.equal(restored.one("PRAGMA user_version").user_version, 4);
  assert.equal(new Catalog(restored).readGoal(goal.id).title, "Legacy");
  restored.close();
  const jobs = new Jobs(s),
    lifecycle = new GoalLifecycle(s, jobs);
  const preview = lifecycle.preview(goal.id);
  lifecycle.delete(goal.id, {
    title: preview.title,
    confirmation: preview.confirmation,
  });
  assert.equal(s.one("SELECT count(*) AS n FROM goal_sessions").n, 0);
});

test("real workflow resumes the goal session after app restart without repeating a completed job step", async (t) => {
  const dir = temp(),
    cwd = join(dir, "worker");
  let f = await createApp({
    dataDir: dir,
    agent: agentAt(cwd, "workflow"),
    autoWorker: false,
  });
  t.after(() => f.app.close());
  const goal = f.catalog.goal({ title: "For" });
  const first = f.jobs.enqueue("plan_goal", { goalId: goal.id });
  await f.jobs.tick();
  assert.equal(f.jobs.get(first.id).status, "succeeded");
  const threadId = f.store.one(
    "SELECT thread_id FROM goal_sessions WHERE goal_id=?",
    goal.id,
  ).thread_id;
  f.store.run("UPDATE jobs SET status='running' WHERE id=?", first.id);
  await f.app.close();
  f = await createApp({
    dataDir: dir,
    agent: agentAt(cwd, "workflow"),
    autoWorker: false,
  });
  await f.jobs.tick();
  assert.equal(f.jobs.get(first.id).status, "succeeded");
  assert.equal(
    protocol(cwd).filter((r) => r.method === "turn/start").length,
    1,
  );
  const second = f.jobs.enqueue("plan_goal", {
    goalId: goal.id,
    answers: { level: "beginner" },
  });
  await f.jobs.tick();
  assert.equal(f.jobs.get(second.id).status, "succeeded");
  assert.equal(f.jobs.get(second.id).result.summary, "Turn 2");
  assert.equal(
    f.store.one("SELECT thread_id FROM goal_sessions WHERE goal_id=?", goal.id)
      .thread_id,
    threadId,
  );
  assert.equal(
    f.catalog.readGoal(goal.id).scope,
    null,
    "planning still requires scope confirmation",
  );
});
