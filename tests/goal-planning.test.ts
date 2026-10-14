import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/app.js";
import { Fault } from "../src/core.js";
import type { AgentPort } from "../src/agent.js";

for (const mode of ["recovers", "invalid_twice", "offline"] as const) {
  test(`goal planning bounded validation retry: ${mode}`, async (t) => {
    const inputs: any[] = [];
    const agent: AgentPort = {
      async ask(_role, input, schema) {
        inputs.push(input);
        if (mode === "offline")
          throw new Fault(503, "CODEX_OFFLINE", "Offline");
        if (inputs.length === 1 || mode === "invalid_twice")
          throw new Fault(
            502,
            "AGENT_OUTPUT_INVALID",
            "scope.references.0: Invalid URL",
          );
        return schema.parse({
          scope: {
            title: "For",
            concepts: [{ area: "Python", name: "For" }],
            references: ["https://docs.python.org/3/tutorial/controlflow.html"],
          },
          questions: [],
          summary: "Ready",
        });
      },
      async status() {
        return {};
      },
      async login() {
        return {};
      },
      async models() {
        return [];
      },
      async close() {},
    };
    const f = await createApp({
      dataDir: mkdtempSync(join(tmpdir(), "study-plan-")),
      agent,
      token: "test",
      autoWorker: false,
    });
    t.after(() => f.app.close());
    const goal = f.catalog.goal({ title: "For" });
    const job = f.jobs.enqueue("plan_goal", { goalId: goal.id });
    await f.jobs.tick();
    assert.equal(inputs.length, mode === "offline" ? 1 : 2);
    if (inputs.length === 2)
      assert.match(inputs[1].previousFailure, /Invalid URL/);
    const result = f.jobs.get(job.id);
    assert.equal(result.status, mode === "recovers" ? "succeeded" : "failed");
    assert.equal(
      f.catalog.readGoal(goal.id).scope,
      null,
      "Draft never silently overwrites user scope",
    );
    if (mode === "recovers")
      assert.equal(
        result.result.scope.references[0],
        "https://docs.python.org/3/tutorial/controlflow.html",
      );
  });
}
