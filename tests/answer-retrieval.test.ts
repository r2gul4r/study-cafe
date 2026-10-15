import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnswerIndex, printedReferences } from "../src/answer-retrieval.js";
import { latestMaterials, type Material } from "../src/materials.js";
import { createApp } from "../src/app.js";
import { Fault } from "../src/core.js";
import type { AgentPort } from "../src/agent.js";
import { cleanSourceCheck } from "./helpers/source-quality.js";

const page = (ordinal: number, text: string, sourceId = "key"): Material => ({
  segmentId: `${sourceId}-${ordinal}`,
  revisionId: `${sourceId}-revision`,
  sourceId,
  ordinal,
  title: "Answer document",
  kind: "user_material",
  url: null,
  text,
  locator: { pdfPage: ordinal + 1 },
});

test("deep numeric-only keys are found without question vocabulary or prefix-number confusion", () => {
  const pool = Array.from({ length: 180 }, (_, i) =>
    page(i, `Index section ${i}\n${i + 1000} | A`),
  );
  pool[160] = page(160, "117 | B\n118 | D\n119 | C");
  pool[2] = page(2, "1170 | C");
  const result = new AnswerIndex(pool).search(
    "117. Which colour has the shortest wavelength?",
  );
  assert.equal(result.materials[0]?.ordinal, 160);
  assert.ok(!result.materials.some((m) => m.ordinal === 2));
  assert.ok(result.materials.some((m) => m.ordinal === 161));
  assert.ok(result.materials.some((m) => m.ordinal === 162));
  assert.equal(result.materials[0]?.text, pool[160]!.text);
  assert.ok(result.diagnostics.selectedChars <= 56000);
  assert.ok(result.materials.length <= 10);
  assert.deepEqual(
    printedReferences("１番\nQuestion 9\nProblem 10.\n11 3\n12 C"),
    ["9", "10", "1", "11", "12"],
  );
});

test("unrelated document covers cannot starve a matching late answer and its identity", () => {
  const pool = Array.from({ length: 8 }, (_, d) =>
    Array.from({ length: 20 }, (_, i) =>
      page(i, `Archive ${d} notes`, `source${d}`),
    ),
  ).flat();
  const target = pool.find(
    (m) => m.sourceId === "source7" && m.ordinal === 17,
  )!;
  target.text = "Question 43. Focal length is 50 mm.";
  const result = new AnswerIndex(pool).search(
    "Question 43. What is the focal length?",
  );
  assert.equal(result.materials[0], target);
  assert.ok(
    result.materials.some((m) => m.sourceId === "source7" && m.ordinal === 0),
  );
  assert.ok(result.materials.every((m) => m.sourceId === "source7"));
});

test("repeated numbers use distinguishing content and never merge neighbouring revisions", () => {
  const pool = [
    page(0, "Set Amber"),
    page(1, "1. A shutter admits light."),
    page(2, "Continuation: exposure duration."),
    page(0, "Set Violet", "other"),
    page(1, "1. A semicolon ends the declaration.", "other"),
  ];
  const index = new AnswerIndex(pool);
  assert.equal(
    index.search("1. What ends a declaration?").materials[0]?.sourceId,
    "other",
  );
  const forced = index.search("", { segmentIds: ["key-2"], maxSegments: 4 });
  assert.equal(forced.materials[0]?.segmentId, "key-2");
  assert.deepEqual(index.search("", { segmentIds: ["unlinked"] }).invalidIds, [
    "unlinked",
  ]);
});

test("whole-segment budget holds for long pages and navigation never becomes evidence", () => {
  const pool = Array.from({ length: 100 }, (_, i) =>
    page(i, `Problem ${i + 1}.\n` + "x".repeat(7900)),
  );
  const result = new AnswerIndex(pool).search("Problem 78.", {
    maxChars: 16000,
  });
  assert.equal(result.materials[0]?.ordinal, 77);
  assert.equal(result.materials.length, 2);
  assert.ok(result.materials.every((m) => pool.includes(m)));
  assert.ok(result.candidates.every((m) => m.preview.length <= 200));
  assert.equal(result.diagnostics.indexTruncated, true);
  const fallback = new AnswerIndex(pool).search("unknown script");
  assert.ok(fallback.materials.some((m) => m.ordinal === 50));
});

async function setup(ask: AgentPort["ask"], t: any, decoys = false) {
  const agent: AgentPort = {
    ask,
    async status() {
      return {};
    },
    async models() {
      return [];
    },
    async login() {
      return {};
    },
    async close() {},
  };
  const f = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "study-answer-search-")),
    token: "test",
    autoWorker: false,
    agent,
  });
  t.after(() => f.app.close());
  const goal = f.catalog.goal({ title: "Arbitrary study goal" });
  f.catalog.scope(goal.id, {
    title: "Colour",
    concepts: [{ name: "Colour", area: "Optics" }],
  });
  const answers = f.catalog.source(goal.id, {
    title: "Answer archive",
    rights: "user_provided",
    rightsBasis: "Authored fixture",
  });
  const paper = f.catalog.source(goal.id, {
    title: "Question",
    rights: "user_provided",
    rightsBasis: "Authored fixture",
    answerSourceIds: [answers.id],
  });
  const chunks = Array.from({ length: 90 }, (_, i) =>
    (i === 75
      ? "Set Cedar. Hidden sapphire row: 117 | B.\n"
      : decoys && i > 0 && i < 10
        ? "Set Cedar. Old exercise. 117 | A.\n"
        : i === 40
          ? "Set Cedar. Hidden edition authority.\n"
          : "Set Cedar. Unrelated archive text.\n"
    ).padEnd(8000, " "),
  );
  await ingest(f, answers.id, chunks.join(""));
  await ingest(
    f,
    paper.id,
    "Set Cedar.\n117. Select the shortest wavelength.\nA Red\nB Blue",
  );
  return {
    ...f,
    goal,
    answers,
    paper,
    target: latestMaterials(f.catalog, goal.id).find(
      (m) => m.sourceId === answers.id && m.ordinal === 75,
    )!,
  };
}
async function ingest(
  f: Awaited<ReturnType<typeof createApp>>,
  sourceId: string,
  text: string,
) {
  f.sources.commit(sourceId, await f.sources.prepare(sourceId, { text }));
}

for (const missing of ["answer", "edition"] as const)
  test(`additional ${missing} search preserves anchors and checkpoints; independent review gates use`, async (t) => {
    let calls = 0,
      failed = false;
    const f = await setup(
      async (role, input: any, schema) => {
        if (role === "verify_question") {
          if (!failed) {
            failed = true;
            throw new Fault(429, "CODEX_USAGE_LIMIT", "fixture limit");
          }
          return schema.parse({
            usable: true,
            evidenceValid: true,
            answerValid: true,
            rubricCheck: null,
            sourceCheck: cleanSourceCheck(),
            reason: "mock independent review",
          });
        }
        calls++;
        if (calls === 1) {
          const target =
            missing === "answer"
              ? f.target
              : latestMaterials(f.catalog, f.goal.id).find(
                  (m) => m.sourceId === f.answers.id && m.ordinal === 40,
                )!;
          if (missing === "edition")
            assert.ok(
              input.answerSegments.some(
                (m: Material) => m.segmentId === f.target.segmentId,
              ),
            );
          return schema.parse({
            questions: [],
            unresolved: [],
            hasMore: false,
            answerSearch: {
              query:
                missing === "answer"
                  ? "Hidden sapphire"
                  : "Hidden edition authority",
              segmentIds: [target.segmentId],
            },
          });
        }
        const a = input.answerSegments.find(
          (m: Material) => m.segmentId === f.target.segmentId,
        );
        assert.ok(a);
        if (missing === "edition")
          assert.ok(
            input.answerSegments.some((m: Material) =>
              m.text.includes("Hidden edition authority"),
            ),
          );
        const p = input.segments[0];
        return schema.parse({
          questions: [
            {
              goalId: input.goal.id,
              scopeId: input.scope.id,
              type: "single",
              stem: "117. Select the shortest wavelength.",
              choices: [
                { id: "a", text: "Red" },
                { id: "b", text: "Blue" },
              ],
              answer: ["b"],
              conceptIds: [input.scope.concepts[0].id],
              origin: "external_practice",
              sourceMatch: {
                questionReference: "117",
                answerReference: "117",
                questionEvidence: {
                  segmentId: p.segmentId,
                  quote: "117. Select the shortest wavelength.",
                },
                answerEvidence: { segmentId: a.segmentId, quote: "117 | B." },
                edition: "Set Cedar",
                editionEvidence: [p, a].map((m: Material) => ({
                  segmentId: m.segmentId,
                  quote: "Set Cedar",
                })),
              },
            },
          ],
          hasMore: false,
          unresolved: [],
          answerSearch: null,
        });
      },
      t,
      missing === "answer",
    );
    const job = f.jobs.enqueue("extract_questions", { sourceId: f.paper.id });
    await f.jobs.tick();
    assert.equal(
      f.jobs.get(job.id).status,
      "failed",
      JSON.stringify(f.jobs.get(job.id)),
    );
    assert.equal(f.jobs.get(job.id).error.code, "CODEX_USAGE_LIMIT");
    assert.equal(calls, 2);
    assert.equal(
      f.catalog.listQuestions(f.goal.id, {}).items[0]?.status,
      "needs_review",
    );
    f.jobs.resume(job.id);
    await f.jobs.tick();
    assert.equal(f.jobs.get(job.id).result.usable, 1);
    assert.equal(calls, 2);
  });

for (const kind of ["unlinked", "repeated", "revision_change"] as const)
  test(`answer search safely stops: ${kind}`, async (t) => {
    let calls = 0;
    const f = await setup(async (_role, _input, schema) => {
      calls++;
      if (kind === "revision_change")
        throw new Fault(429, "CODEX_USAGE_LIMIT", "fixture limit");
      return schema.parse({
        questions: [],
        unresolved: [],
        hasMore: false,
        answerSearch: {
          query:
            kind === "repeated" ? "117. Select the shortest wavelength." : "",
          segmentIds: kind === "unlinked" ? ["foreign"] : [],
        },
      });
    }, t);
    const job = f.jobs.enqueue("extract_questions", { sourceId: f.paper.id });
    await f.jobs.tick();
    if (kind === "revision_change") {
      await ingest(f, f.answers.id, "Set Cedar. New revision. 117 | A");
      f.jobs.resume(job.id);
      await f.jobs.tick();
      assert.equal(f.jobs.get(job.id).error.code, "EXTRACTION_SOURCE_CHANGED");
    } else {
      assert.equal(f.jobs.get(job.id).status, "succeeded");
      assert.equal(f.jobs.get(job.id).result.unresolved.length, 1);
      assert.equal(f.jobs.get(job.id).result.count, 0);
    }
    assert.equal(calls, 1);
  });

test("a model cannot turn missing answers into an unbounded search loop", async (t) => {
  let calls = 0;
  const f = await setup(async (_role, input: any, schema) => {
    calls++;
    assert.equal(input.answerRetrieval.searchesRemaining, 3 - calls);
    const target = latestMaterials(f.catalog, f.goal.id).find(
      (m) => m.sourceId === f.answers.id && m.ordinal === calls * 20,
    )!;
    return schema.parse({
      questions: [],
      unresolved: [],
      hasMore: false,
      answerSearch: {
        query: "unfamiliar layout",
        segmentIds: [target.segmentId],
      },
    });
  }, t);
  const job = f.jobs.enqueue("extract_questions", { sourceId: f.paper.id });
  await f.jobs.tick();
  assert.equal(calls, 3);
  const done = f.jobs.get(job.id);
  assert.equal(done.status, "succeeded");
  assert.equal(done.result.count, 0);
  assert.equal(done.result.unresolved.length, 1);
  assert.equal(
    f.jobs.events(job.id).filter((e) => e.data.type === "answer_retrieval")
      .length,
    3,
  );
});

test("a search requested on the final response leaves an explicit unresolved item", async (t) => {
  let calls = 0;
  const f = await setup(async (_role, _input, schema) => {
    calls++;
    if (calls < 20)
      return schema.parse({
        questions: [],
        hasMore: true,
        unresolved: [
          { reference: `item-${calls}`, reason: "Fixture missing evidence" },
        ],
        answerSearch: null,
      });
    const target = latestMaterials(f.catalog, f.goal.id).find(
      (m) => m.sourceId === f.answers.id && m.ordinal === 40,
    )!;
    return schema.parse({
      questions: [],
      hasMore: false,
      unresolved: [],
      answerSearch: {
        query: "Hidden edition authority",
        segmentIds: [target.segmentId],
      },
    });
  }, t);
  const job = f.jobs.enqueue("extract_questions", { sourceId: f.paper.id });
  await f.jobs.tick();
  assert.equal(calls, 20);
  assert.equal(f.jobs.get(job.id).status, "succeeded");
  assert.equal(f.jobs.get(job.id).result.unresolved.length, 20);
  assert.match(f.jobs.get(job.id).result.unresolved.at(-1).reason, /검색 한도/);
});
