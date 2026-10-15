import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";
import { createApp } from "../src/app.js";
import { canonicalQuestion, questionInput } from "../src/core.js";
import { CodexAgent, type AgentPort } from "../src/agent.js";
import {
  latestMaterials,
  validateExtraction,
  withExtractionEvidence,
  type Material,
} from "../src/materials.js";
import {
  imageInputs,
  pdfPageImage,
  validateVisualEvidence,
} from "../src/pdf-visuals.js";
import { publicQuestion } from "../src/exams.js";
import { Store } from "../src/store.js";
import { backup, verifyBackup } from "../src/backup.js";
import { alignedAudit } from "./helpers/grading.js";

const material = (
  id: string,
  revisionId: string,
  ordinal: number,
  text: string,
): Material => ({
  segmentId: id,
  sourceId: revisionId,
  revisionId,
  ordinal,
  text,
  title: id,
  kind: "external_practice",
  url: null,
  locator: { pdfPage: ordinal + 1, charStart: 0, charEnd: text.length },
});
function fixture() {
  const paper = material("q", "paper", 0, "Session 2030. 1. Find the area.");
  const first = material(
    "a",
    "answers",
    0,
    "Session 2030. 1. Answer continued:",
  );
  const next = material("b", "answers", 1, "The area equals 4.");
  const q = withExtractionEvidence(
    questionInput.parse({
      goalId: "g",
      scopeId: "s",
      type: "short",
      stem: "1. Find the area.",
      modelAnswer: "4",
      rubric: [{ id: "area", description: "Area is 4", points: 1 }],
      origin: "external_practice",
      conceptIds: ["c"],
      sourceMatch: {
        questionReference: "1.",
        answerReference: "1.",
        questionEvidence: { segmentId: "q", quote: "1. Find the area." },
        answerEvidence: { segmentId: "a", quote: "1. Answer continued:" },
        answerContinuationEvidence: [{ segmentId: "b", quote: next.text }],
        edition: "Session 2030",
        editionEvidence: [paper, first].map((m) => ({
          segmentId: m.segmentId,
          quote: "Session 2030",
        })),
      },
    }),
  );
  return { q, paper, first, next };
}

test("numbered answer continuation preserves exact citations and rejects skipped, reversed, duplicate or foreign pages", () => {
  const { q, paper, first, next } = fixture();
  const validate = (answers: Material[], question = q) =>
    validateExtraction(
      question,
      { kind: "external_practice" },
      [paper],
      answers,
    );
  assert.doesNotThrow(() => validate([first, next]));
  assert.ok(
    q.evidence.some((e) => e.segmentId === "b" && e.quote === next.text),
  );
  for (const bad of [
    { ...next, ordinal: 2 },
    { ...next, ordinal: -1 },
    { ...next, revisionId: "other" },
  ])
    assert.throws(() => validate([first, bad]), /연속 구간/);
  const duplicate = structuredClone(q);
  duplicate.sourceMatch!.answerContinuationEvidence.push({
    segmentId: "b",
    quote: next.text,
  });
  assert.throws(() => validate([first, next], duplicate), /연속 구간/);
  const fabricated = structuredClone(q);
  fabricated.sourceMatch!.answerContinuationEvidence[0]!.quote = "Area is 999.";
  assert.throws(
    () => validate([first, next], withExtractionEvidence(fabricated)),
    /원문과 다른 인용/,
  );
});

test("visual transcription requires the supplied original anchor and forbids answer assets in learner output", () => {
  const { q, paper, first, next } = fixture();
  paper.pageImage = { assetId: "question-png", width: 10, height: 10 };
  next.pageImage = { assetId: "answer-png", width: 10, height: 10 };
  const visual = {
    ...q,
    stem: "1. Find the area of x².",
    visualTranscription: true,
    requiredAssetIds: ["question-png"],
    visualEvidence: [
      { segmentId: "q", assetId: "question-png", role: "question" as const },
      { segmentId: "b", assetId: "answer-png", role: "answer" as const },
    ],
  };
  const validate = (v = visual) =>
    validateExtraction(
      v,
      { kind: "external_practice" },
      [paper],
      [first, next],
    );
  assert.doesNotThrow(() => validate());
  assert.throws(
    () => validate({ ...visual, visualTranscription: false }),
    /원문과 다릅니다/,
  );
  assert.throws(
    () => validate({ ...visual, visualEvidence: [] }),
    /원본 페이지/,
  );
  assert.throws(
    () => validate({ ...visual, requiredAssetIds: [] }),
    /첨부해야/,
  );
  assert.throws(
    () =>
      validate({ ...visual, requiredAssetIds: ["question-png", "answer-png"] }),
    /정답 이미지/,
  );
  assert.throws(
    () =>
      validate({
        ...visual,
        visualEvidence: [{ ...visual.visualEvidence[0]!, assetId: "invented" }],
      }),
    /제공된 원본/,
  );
  const learner = publicQuestion(visual);
  assert.equal(learner.visualEvidence, undefined);
  assert.equal(learner.sourceMatch, undefined);
  assert.deepEqual(learner.requiredAssetIds, ["question-png"]);
});

test("Codex protocol sends labelled original images alongside text", async (t) => {
  const agent = new CodexAgent({
    binary: process.execPath,
    args: [join(process.cwd(), "tests/fake-codex.mjs"), "images"],
    cwd: mkdtempSync(join(tmpdir(), "study-visual-rpc-")),
    timeoutMs: 5000,
  });
  t.after(() => agent.close());
  assert.deepEqual(
    await agent.ask("visual", {}, z.object({ ok: z.boolean() }), {
      images: [{ path: "/fixture/page.png", label: "segment: one" }],
    }),
    { ok: true },
  );
});

test("different graph assets do not collapse questions with the same printed wording", () => {
  const { q } = fixture();
  assert.notEqual(
    canonicalQuestion({ ...q, requiredAssetIds: ["graph-a"] }),
    canonicalQuestion({ ...q, requiredAssetIds: ["graph-b"] }),
  );
  assert.equal(
    canonicalQuestion({ ...q, requiredAssetIds: ["graph-a", "graph-b"] }),
    canonicalQuestion({ ...q, requiredAssetIds: ["graph-b", "graph-a"] }),
  );
});

async function pdf(texts: string[]) {
  const document = await PDFDocument.create();
  for (const text of texts) {
    const page = document.addPage([400, 400]);
    page.drawText(text, { x: 20, y: 360, size: 12 });
    page.drawRectangle({ x: 40, y: 40, width: 100, height: 50 });
  }
  return Buffer.from(await document.save()).toString("base64");
}

test("original images survive cache/reopen; independent visual review is required before usability", async (t) => {
  let visualPass = false;
  let extractCalls = 0;
  const agent: AgentPort = {
    async ask(role, raw: any, schema, options) {
      assert.ok(options?.images?.length);
      assert.ok(
        options.images.every(
          (i) => readFileSync(i.path).subarray(1, 4).toString() === "PNG",
        ),
      );
      if (role === "extract_existing_questions") {
        extractCalls++;
        assert.equal(raw.segments[0].locator.pdfPage, 1);
        const p = raw.segments[0],
          a = raw.answerSegments.find((m: any) => m.ordinal === 0),
          b = raw.answerSegments.find((m: any) => m.ordinal === 1);
        return schema.parse({
          questions: [
            {
              goalId: raw.goal.id,
              scopeId: raw.scope.id,
              conceptIds: [raw.scope.concepts[0].id],
              type: "short",
              origin: "external_practice",
              stem: "1. Find the area of x².",
              modelAnswer: "4",
              rubric: [{ id: "area", description: "Area is 4", points: 1 }],
              visualTranscription: true,
              requiredAssetIds: [p.pageImage.assetId],
              visualEvidence: [
                {
                  segmentId: p.segmentId,
                  assetId: p.pageImage.assetId,
                  role: "question",
                },
                {
                  segmentId: b.segmentId,
                  assetId: b.pageImage.assetId,
                  role: "answer",
                },
              ],
              sourceMatch: {
                questionReference: "1.",
                answerReference: "1.",
                questionEvidence: {
                  segmentId: p.segmentId,
                  quote: "1. Find the area.",
                },
                answerEvidence: {
                  segmentId: a.segmentId,
                  quote: "1. Answer continued:",
                },
                answerContinuationEvidence: [
                  { segmentId: b.segmentId, quote: "The area equals 4." },
                ],
                edition: "Session 2030",
                editionEvidence: [p, a].map((m) => ({
                  segmentId: m.segmentId,
                  quote: "Session 2030",
                })),
              },
            },
          ],
          unresolved: [],
          hasMore: false,
        });
      }
      assert.equal(role, "verify_question");
      assert.equal(options.images.length, 2);
      assert.ok(
        raw.materials.some((m: any) => m.text.includes("Answer continued")),
      );
      return schema.parse({
        usable: true,
        evidenceValid: true,
        answerValid: true,
        rubricCheck: alignedAudit(raw.question),
        reason: "mock semantic review",
        visualCheck: visualPass
          ? {
              faithful: true,
              complete: true,
              noAnswerLeak: true,
              reason: "mock visual review",
            }
          : null,
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
  const dir = mkdtempSync(join(tmpdir(), "study-visual-fixture-"));
  const f = await createApp({
    dataDir: dir,
    token: "test",
    autoWorker: false,
    agent,
  });
  t.after(() => f.app.close());
  const goal = f.catalog.goal({ title: "Image scope" });
  f.catalog.scope(goal.id, {
    title: "Area",
    concepts: [{ name: "Area", area: "Math" }],
  });
  const answer = f.catalog.source(goal.id, {
    title: "Answer",
    rights: "user_provided",
    rightsBasis: "Authored fixture",
  });
  const paper = f.catalog.source(goal.id, {
    title: "Paper",
    kind: "external_practice",
    rights: "user_provided",
    rightsBasis: "Authored fixture",
    answerSourceIds: [answer.id],
  });
  for (const [source, texts] of [
    [paper, ["Session 2030. 1. Find the area.", "Do not extract this page."]],
    [answer, ["Session 2030. 1. Answer continued:", "The area equals 4."]],
  ] as const)
    f.sources.commit(
      source.id,
      await f.sources.prepare(source.id, {
        base64: await pdf([...texts]),
        mime: "application/pdf",
      }),
    );
  const job = f.jobs.enqueue("extract_questions", {
    sourceId: paper.id,
    pdfPages: [1],
  });
  await f.jobs.tick();
  const done = f.jobs.get(job.id);
  assert.equal(done.status, "succeeded", JSON.stringify(done.error));
  assert.equal(extractCalls, 1);
  assert.equal(done.result.usable, 0);
  const q = f.catalog.readQuestion(done.result.questionIds[0]);
  assert.match(q.review.reason, /이미지 검토/);
  const original = latestMaterials(f.catalog, goal.id).find(
    (m) => m.sourceId === paper.id,
  )!;
  const image = await pdfPageImage(f.store, original.revisionId, 1);
  assert.deepEqual(image, original.pageImage);
  assert.equal(image.width, 1000);
  const reopened = new Store(dir);
  try {
    assert.deepEqual(
      await pdfPageImage(reopened, original.revisionId, 1),
      image,
    );
  } finally {
    reopened.db.close();
  }
  const snapshot = backup(f.store);
  assert.ok(
    verifyBackup(join(dir, "backups", snapshot.id)).assets.includes(
      f.store.get("assets", image.assetId).hash,
    ),
  );
  assert.equal(imageInputs(f.store, [original, original]).length, 1);
  assert.throws(
    () => validateVisualEvidence(f.store, { ...q, goalId: "foreign" }),
    /목표/,
  );
  assert.throws(
    () =>
      validateVisualEvidence(f.store, {
        ...q,
        visualEvidence: [{ ...q.visualEvidence[0], assetId: "bad" }],
      }),
    /일치하지/,
  );
  assert.throws(
    () => validateVisualEvidence(f.store, { ...q, evidence: [] }),
    /원문 인용/,
  );
  await assert.rejects(
    () => pdfPageImage(f.store, original.revisionId, 50),
    /페이지 번호/,
  );
  visualPass = true;
  const review = f.jobs.enqueue("verify_question", { questionId: q.id });
  await f.jobs.tick();
  assert.equal(f.jobs.get(review.id).status, "succeeded");
  assert.equal(f.catalog.readQuestion(q.id).status, "usable");
  const badPage = f.jobs.enqueue("extract_questions", {
    sourceId: paper.id,
    pdfPages: [50],
  });
  await f.jobs.tick();
  assert.equal(f.jobs.get(badPage.id).error.code, "PDF_PAGES");
  const response = await f.app.inject({
    method: "GET",
    url: "/api/assets/" + image.assetId,
    headers: { authorization: "Bearer test" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "image/png");
  assert.equal(
    (await f.app.inject({ method: "GET", url: "/api/assets/" + image.assetId }))
      .statusCode,
    401,
  );
});
