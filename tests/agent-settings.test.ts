import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { Store } from "../src/store.js";
import { Catalog } from "../src/catalog.js";
import { CodexAgent } from "../src/agent.js";
import { AgentSettings } from "../src/agent-settings.js";
import { GoalSessions } from "../src/goal-sessions.js";
import { GoalLifecycle } from "../src/goal-lifecycle.js";
import { Jobs } from "../src/jobs.js";
import { id, now } from "../src/core.js";
import { backup, restoreBackup } from "../src/backup.js";
import { createApp } from "../src/app.js";

const temp = () => mkdtempSync(join(tmpdir(), "study-agent-settings-"));
const makeAgent = (cwd: string) =>
  new CodexAgent({
    binary: process.execPath,
    args: [resolve("tests/fake-session-codex.mjs")],
    cwd,
    timeoutMs: 5000,
  });
const output = z.object({ threadId: z.string(), history: z.number() });

test("Daybreak is absent from the API, cannot be selected, and a legacy selection cannot start a turn", async (t) => {
  const dir = temp(),
    cwd = join(dir, "worker"),
    agent = makeAgent(cwd);
  const list = agent.models.bind(agent);
  agent.models = async () => {
    const catalog = await list();
    return {
      ...catalog,
      data: [
        ...catalog.data,
        {
          id: "gpt-daybreak-blue-latest",
          model: "gpt-daybreak-blue-latest",
          displayName: "Daybreak Blue",
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "test" },
          ],
        },
      ],
    };
  };
  const f = await createApp({
    dataDir: dir,
    agent,
    token: "settings-test-token",
    autoWorker: false,
  });
  t.after(() => f.app.close());
  const goal = f.catalog.goal({ title: "Daybreak exclusion" });
  const headers = { authorization: "Bearer settings-test-token" };
  const models = await f.app.inject({
    method: "GET",
    url: "/api/agent/models",
    headers,
  });
  assert.equal(models.statusCode, 200);
  assert.deepEqual(
    models.json().data.map((model: { model: string }) => model.model),
    ["model-a", "model-b"],
  );
  const save = await f.app.inject({
    method: "PUT",
    url: `/api/goals/${goal.id}/agent-settings`,
    headers,
    payload: { model: "gpt-daybreak-blue-latest", effort: "low" },
  });
  assert.equal(save.statusCode, 400);
  assert.equal(save.json().error.code, "AGENT_MODEL");
  f.store.run(
    "INSERT INTO goal_agent_settings VALUES(?,?,?,?)",
    goal.id,
    "gpt-daybreak-blue-latest",
    "low",
    now(),
  );
  const sessions = new GoalSessions(f.catalog, agent),
    jobId = job(f.store, goal.id);
  for (const role of ["plan_goal", "verify_question"])
    await assert.rejects(sessions.ask(jobId, role, {}, output, {}), {
      code: "AGENT_MODEL_DISABLED",
    });
  assert.equal(turns(cwd).length, 0);
  await new AgentSettings(f.store, agent).save(goal.id, {
    model: "model-a",
    effort: "low",
  });
  await sessions.ask(jobId, "plan_goal", {}, output, {});
  assert.equal(turns(cwd).at(-1)?.model, "model-a");
});
function job(s: Store, goalId: string) {
  const jobId = id();
  s.run(
    "INSERT INTO jobs(id,kind,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    jobId,
    "fixture",
    JSON.stringify({ goalId }),
    "succeeded",
    now(),
    now(),
  );
  return jobId;
}
function turns(cwd: string) {
  return readFileSync(join(cwd, "fake-protocol.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) =>
      z
        .object({
          method: z.string(),
          params: z
            .object({
              model: z.string().optional(),
              effort: z.string().optional(),
              threadId: z.string().optional(),
            })
            .passthrough()
            .optional(),
        })
        .parse(JSON.parse(l)),
    )
    .filter((r) => r.method === "turn/start")
    .map((r) => r.params!);
}

test("settings validate the paginated model catalog, persist through restart/backup and cascade on goal deletion", async (t) => {
  const dir = temp(),
    cwd = join(dir, "worker"),
    agent = makeAgent(cwd);
  let s = new Store(dir);
  t.after(async () => {
    await agent.close();
    s.close();
  });
  const catalog = new Catalog(s),
    a = catalog.goal({ title: "A" }),
    b = catalog.goal({ title: "B" });
  let settings = new AgentSettings(s, agent);
  assert.equal(settings.read(a.id).configuration, null);
  assert.equal((await settings.models()).data.length, 2);
  await settings.save(a.id, { model: "model-b", effort: "max" });
  await assert.rejects(
    settings.save(a.id, { model: "unknown", effort: "high" }),
    { code: "AGENT_MODEL" },
  );
  await assert.rejects(
    settings.save(a.id, { model: "model-b", effort: "low" }),
    { code: "AGENT_EFFORT" },
  );
  await assert.rejects(
    settings.save(a.id, { model: "model-b", effort: "max", unexpected: true }),
  );
  assert.deepEqual(settings.read(a.id).configuration, {
    model: "model-b",
    effort: "max",
  });
  assert.equal(settings.read(b.id).configuration, null);
  s.close();
  s = new Store(dir);
  settings = new AgentSettings(s, agent);
  assert.deepEqual(settings.read(a.id).configuration, {
    model: "model-b",
    effort: "max",
  });
  const saved = backup(s),
    target = temp();
  restoreBackup(join(dir, "backups", saved.id), target);
  const restored = new Store(target);
  assert.deepEqual(
    new AgentSettings(restored, agent).read(a.id).configuration,
    settings.read(a.id).configuration,
  );
  restored.close();
  s.run("UPDATE goals SET archived=1 WHERE id=?", a.id);
  await assert.rejects(
    settings.save(a.id, { model: "model-a", effort: "low" }),
    { code: "ARCHIVED" },
  );
  const lifecycle = new GoalLifecycle(s, new Jobs(s)),
    preview = lifecycle.preview(a.id);
  lifecycle.delete(a.id, {
    title: preview.title,
    confirmation: preview.confirmation,
  });
  assert.equal(s.one("SELECT count(*) AS n FROM goal_agent_settings").n, 0);
});

test("model changes preserve the goal thread and in-flight settings; evaluation stays isolated and uses the selected configuration", async (t) => {
  const dir = temp(),
    cwd = join(dir, "worker");
  let s = new Store(dir),
    agent = makeAgent(cwd);
  t.after(async () => {
    await agent.close();
    s.close();
  });
  let catalog = new Catalog(s),
    sessions = new GoalSessions(catalog, agent),
    settings = new AgentSettings(s, agent);
  const a = catalog.goal({ title: "A" }),
    b = catalog.goal({ title: "B" }),
    aj = job(s, a.id),
    bj = job(s, b.id);
  await settings.save(a.id, { model: "model-a", effort: "low" });
  let signalStarted!: () => void;
  const started = new Promise<void>((r) => {
    signalStarted = r;
  });
  const first = sessions.ask(aj, "plan_goal", { delayMs: 100 }, output, {
    onProgress: (e) => {
      if (e.type === "agent_configuration") signalStarted();
    },
  });
  await started;
  await settings.save(a.id, { model: "model-b", effort: "max" });
  const next = sessions.ask(aj, "research_sources", {}, output, {});
  const [one, two] = await Promise.all([first, next]);
  assert.equal(one.threadId, two.threadId);
  assert.equal(two.history, 2);
  assert.deepEqual(
    turns(cwd).map(({ model, effort }) => ({ model, effort })),
    [
      { model: "model-a", effort: "low" },
      { model: "model-b", effort: "max" },
    ],
  );
  const isolated = await sessions.ask(aj, "verify_question", {}, output, {});
  assert.notEqual(isolated.threadId, one.threadId);
  assert.equal(isolated.history, 1);
  assert.equal(turns(cwd).at(-1)?.model, "model-b");
  assert.equal(turns(cwd).at(-1)?.effort, "max");
  await sessions.ask(bj, "plan_goal", {}, output, {});
  assert.equal(turns(cwd).at(-1)?.model, undefined);
  assert.equal(turns(cwd).at(-1)?.effort, "medium");
  await agent.close();
  s.close();
  s = new Store(dir);
  agent = makeAgent(cwd);
  catalog = new Catalog(s);
  sessions = new GoalSessions(catalog, agent);
  settings = new AgentSettings(s, agent);
  const resumed = await sessions.ask(aj, "plan_goal", {}, output, {});
  assert.equal(resumed.threadId, one.threadId);
  assert.equal(resumed.history, 3);
  assert.deepEqual(settings.read(a.id).configuration, {
    model: "model-b",
    effort: "max",
  });
  assert.equal(turns(cwd).at(-1)?.model, "model-b");
});

test("settings API requires auth, rejects unsupported combinations, and keeps the previous selection on catalog failure", async (t) => {
  const dir = temp(),
    agent = makeAgent(join(dir, "worker"));
  const f = await createApp({
    dataDir: dir,
    agent,
    token: "settings-test-token",
    autoWorker: false,
  });
  t.after(() => f.app.close());
  const goal = f.catalog.goal({ title: "API" }),
    url = `/api/goals/${goal.id}/agent-settings`;
  const headers = { authorization: "Bearer settings-test-token" };
  assert.equal((await f.app.inject({ method: "GET", url })).statusCode, 401);
  assert.equal(
    (
      await f.app.inject({
        method: "PUT",
        url,
        headers,
        payload: { model: "model-a", effort: "high" },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "PUT",
        url,
        headers,
        payload: { model: "model-b", effort: "low" },
      })
    ).statusCode,
    400,
  );
  agent.models = async () => {
    throw new Error("offline fixture");
  };
  assert.equal(
    (
      await f.app.inject({
        method: "PUT",
        url,
        headers,
        payload: { model: "model-a", effort: "low" },
      })
    ).statusCode,
    500,
  );
  const current = await f.app.inject({ method: "GET", url, headers });
  assert.deepEqual(current.json().configuration, {
    model: "model-a",
    effort: "high",
  });
  assert.equal(
    (
      await f.app.inject({
        method: "GET",
        url: "/api/goals/missing/agent-settings",
        headers,
      })
    ).statusCode,
    404,
  );
});

test("a version 3 backup migrates with no change to the previous goal/session data", async (t) => {
  const dir = temp();
  let s = new Store(dir);
  t.after(() => s.close());
  const goal = new Catalog(s).goal({ title: "Legacy v3" });
  s.run(
    "INSERT INTO goal_sessions VALUES(?,?,?,?)",
    goal.id,
    "retained-thread",
    now(),
    now(),
  );
  const before = s.one("SELECT * FROM goal_sessions WHERE goal_id=?", goal.id);
  s.db.exec("DROP TABLE goal_agent_settings; PRAGMA user_version=3");
  const saved = backup(s),
    target = temp();
  s.close();
  restoreBackup(join(dir, "backups", saved.id), target);
  s = new Store(target);
  assert.deepEqual(
    s.one("SELECT * FROM goal_sessions WHERE goal_id=?", goal.id),
    before,
  );
  assert.equal(s.one("PRAGMA user_version").user_version, 4);
  assert.equal(s.one("SELECT count(*) AS n FROM goal_agent_settings").n, 0);
});
