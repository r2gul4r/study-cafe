import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { CodexAgent, wireSchema } from "../src/agent.js";

for (const role of ["plan_goal", "research_sources"]) {
  for (const ending of ["complete", "cancel", "disconnect"]) {
    test(
      `${role} has no turn deadline and still handles ${ending}`,
      { timeout: 5000 },
      async (t) => {
        const agent = new CodexAgent({
          binary: process.execPath,
          args: [resolve("tests/fake-session-codex.mjs")],
          cwd: mkdtempSync(join(tmpdir(), "study-cafe-long-turn-")),
          timeoutMs: 40,
        });
        const controller = new AbortController();
        let action: NodeJS.Timeout | undefined;
        t.after(async () => {
          clearTimeout(action);
          await agent.close();
        });
        agent.on("notification", (event: { method: string }) => {
          if (event.method !== "turn/started" || ending === "complete") return;
          action = setTimeout(() => {
            if (ending === "cancel") controller.abort();
            else void agent.close();
          }, 160);
        });
        const result = agent.ask(
          role,
          ending === "complete" ? { delayMs: 160 } : { hang: true },
          z.object({ threadId: z.string(), history: z.number() }),
          { signal: controller.signal },
        );
        if (ending === "complete") assert.equal((await result).history, 1);
        else
          await assert.rejects(result, {
            code: ending === "cancel" ? "CANCELLED" : "CODEX_EXIT",
          });
      },
    );
  }
}

test("question generation keeps its turn deadline", async (t) => {
  const agent = new CodexAgent({
    binary: process.execPath,
    args: [resolve("tests/fake-session-codex.mjs")],
    cwd: mkdtempSync(join(tmpdir(), "study-cafe-timed-turn-")),
    timeoutMs: 40,
  });
  t.after(() => agent.close());
  await assert.rejects(
    agent.ask(
      "generate_question",
      { delayMs: 160 },
      z.object({ threadId: z.string(), history: z.number() }),
    ),
    { code: "CODEX_TURN_TIMEOUT" },
  );
});

test("provider schema removes unsupported URI format but local validation stays strict", () => {
  const local = z
    .object({ url: z.url(), optional: z.string().optional() })
    .strict();
  const remote = wireSchema(z.toJSONSchema(local));
  assert.equal(remote.properties.url.format, undefined);
  assert.deepEqual(remote.required, ["url", "optional"]);
  assert.ok(
    remote.properties.optional.anyOf.some((v: any) => v.type === "null"),
  );
  assert.equal(local.safeParse({ url: "not a URL" }).success, false);
});

for (const mode of ["ok", "invalid", "failure", "hang"])
  test(`Codex JSON-RPC adapter: ${mode}`, async (t) => {
    const agent = new CodexAgent({
      binary: process.execPath,
      args: [resolve("tests/fake-codex.mjs"), mode],
      cwd: mkdtempSync(join(tmpdir(), "study-cafe-protocol-")),
      timeoutMs: mode === "hang" ? 50 : 5000,
    });
    t.after(() => agent.close());
    const status = await agent.status();
    assert.equal(status.authenticated, true);
    assert.equal(JSON.stringify(status).includes("@"), false);
    if (mode === "ok")
      assert.deepEqual(
        await agent.ask("test", {}, z.object({ ok: z.boolean() }).strict()),
        { ok: true },
      );
    else
      await assert.rejects(
        () => agent.ask("test", {}, z.object({ ok: z.boolean() }).strict()),
        (e: any) =>
          e.code ===
          (
            {
              invalid: "AGENT_OUTPUT_INVALID",
              failure: "CODEX_TURN_FAILED",
              hang: "CODEX_TURN_TIMEOUT",
            } as any
          )[mode],
      );
  });
test("Codex adapter cancels an active turn and settles the promise", async (t) => {
  const agent = new CodexAgent({
    binary: process.execPath,
    args: [resolve("tests/fake-codex.mjs"), "hang"],
    cwd: mkdtempSync(join(tmpdir(), "study-cafe-protocol-")),
    timeoutMs: 5000,
  });
  t.after(() => agent.close());
  await agent.connect();
  const controller = new AbortController();
  const result = agent.ask("test", {}, z.object({ ok: z.boolean() }), {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(
    () => result,
    (e: any) => e.code === "CANCELLED",
  );
});

for (const [mode, code, providerCode, httpStatusCode] of [
  ["rate-limit", "CODEX_RATE_LIMITED", "responseTooManyFailedAttempts", 429],
  ["usage-limit", "CODEX_USAGE_LIMIT", "usageLimitExceeded", null],
  ["unknown-error", "CODEX_TURN_FAILED", null, null],
] as const)
  test(`Codex final failure preserves safe diagnostics: ${mode}`, async (t) => {
    const agent = new CodexAgent({
      binary: process.execPath,
      args: [resolve("tests/fake-codex.mjs"), mode],
      cwd: mkdtempSync(join(tmpdir(), "study-cafe-protocol-")),
      timeoutMs: 5000,
    });
    t.after(() => agent.close());
    await assert.rejects(
      () => agent.ask("grade_answer", {}, z.object({ ok: z.boolean() })),
      (e: any) => {
        assert.equal(e.code, code);
        assert.deepEqual(e.details, {
          status: "failed",
          providerCode,
          httpStatusCode,
        });
        assert.doesNotMatch(JSON.stringify(e), /must-not-leak|private/);
        return true;
      },
    );
  });

test("Codex recoverable error does not override a successful final turn", async (t) => {
  const agent = new CodexAgent({
    binary: process.execPath,
    args: [resolve("tests/fake-codex.mjs"), "recoverable"],
    cwd: mkdtempSync(join(tmpdir(), "study-cafe-protocol-")),
    timeoutMs: 5000,
  });
  t.after(() => agent.close());
  assert.deepEqual(
    await agent.ask("grade_answer", {}, z.object({ ok: z.boolean() })),
    { ok: true },
  );
});
