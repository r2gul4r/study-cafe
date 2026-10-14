import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/app.js";
import type { AgentPort } from "../src/agent.js";

test("research retains a restricted preference as a link and acquires an independent permitted alternative", async (t) => {
  const downloaded: string[] = [];
  const f = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "study-research-alternative-")),
    token: "test",
    autoWorker: false,
    agent: {
      async ask(role, raw, schema) {
        assert.equal(role, "research_sources");
        assert.match(
          (raw as any).instruction,
          /independently authored, accessible alternatives/,
        );
        return schema.parse({
          candidates: [
            {
              title: "Preferred but restricted",
              url: "https://restricted.example/book",
              publisher: "Restricted",
              kind: "reference",
              examEvidence: null,
              reuseEvidence: null,
              answerUrls: [],
            },
            {
              title: "Independent open guide",
              url: "https://open.example/guide",
              publisher: "Open",
              kind: "reference",
              examEvidence: null,
              reuseEvidence: {
                quote: "The original text is available for unrestricted reuse.",
                url: "https://open.example/terms",
              },
              answerUrls: [],
            },
          ],
          uncovered: [],
          summary: "Two candidates; acquisition not yet checked.",
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
    },
    fetcher: async (url) => {
      downloaded.push(url);
      return {
        url,
        mime: "text/plain",
        bytes: Buffer.from(
          url.endsWith("terms")
            ? "The original text is available for unrestricted reuse."
            : "Independent explanation of a concept.",
        ),
      };
    },
  });
  t.after(() => f.app.close());
  const goal = f.catalog.goal({ title: "자유 주제" });
  f.catalog.scope(goal.id, {
    title: "범위",
    concepts: [{ name: "개념", area: "분야" }],
  });
  const job = f.jobs.enqueue("research", { goalId: goal.id });
  await f.jobs.tick();
  const result = f.jobs.get(job.id);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(
    result.result.outcomes.map((o: any) => o.status),
    ["link_only", "extracted"],
  );
  assert.deepEqual(downloaded, [
    "https://open.example/terms",
    "https://open.example/guide",
  ]);
  assert.match(result.result.summary, /본문 수집 1개/);
  assert.match(result.result.summary, /링크만 보관 1개/);
  assert.equal(f.catalog.listQuestions(goal.id, {}).total, 0);
});

for (const allowed of [true, false])
  test(`research reports actual acquisition and does not extract reference prose as questions: ${allowed}`, async (t) => {
    const calls: string[] = [];
    const agent: AgentPort = {
      async ask(role, _input, schema) {
        calls.push(role);
        assert.equal(role, "research_sources");
        return schema.parse({
          candidates: [
            {
              title: "Reference",
              url: "https://example.com/reference",
              publisher: "Fixture",
              kind: "reference",
              examEvidence: null,
              reuseEvidence: {
                quote: "This documentation may be reused for any purpose.",
                url: "https://example.com/license",
              },
              answerUrls: [],
            },
          ],
          uncovered: [],
          summary: "I already acquired everything.",
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
    const downloads: string[] = [];
    const f = await createApp({
      dataDir: mkdtempSync(join(tmpdir(), "study-research-")),
      agent,
      token: "test",
      autoWorker: false,
      fetcher: async (url) => {
        downloads.push(url);
        const text = url.endsWith("license")
          ? allowed
            ? "This documentation may\nbe reused for any purpose."
            : "This documentation may not be reused for any purpose."
          : "A for loop iterates over items.";
        return {
          url,
          mime: "text/html",
          bytes: Buffer.from(`<main>${text}</main>`),
        };
      },
    });
    t.after(() => f.app.close());
    const goal = f.catalog.goal({ title: "For loops" });
    f.catalog.scope(goal.id, {
      title: "For",
      concepts: [{ name: "For", area: "Python" }],
    });
    const job = f.jobs.enqueue("research", { goalId: goal.id });
    await f.jobs.tick();
    const result = f.jobs.get(job.id);
    assert.equal(result.status, "succeeded", JSON.stringify(result.error));
    assert.match(
      result.result.summary,
      allowed ? /본문 수집 1개/ : /본문 수집 0개/,
    );
    assert.doesNotMatch(result.result.summary, /already acquired/);
    assert.equal(
      result.result.discoverySummary,
      "I already acquired everything.",
    );
    assert.equal(
      result.result.outcomes[0].status,
      allowed ? "extracted" : "link_only",
    );
    assert.deepEqual(result.result.extracted, []);
    assert.deepEqual(calls, ["research_sources"]);
    assert.equal(downloads.length, allowed ? 2 : 1);
  });
