import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { createApp } from "../src/app.js";
import { questionInput } from "../src/core.js";
import { latestMaterials } from "../src/materials.js";
import {
  pdfPageImage,
  pdfRegionImage,
  validateVisualEvidence,
} from "../src/pdf-visuals.js";
import { saveQuestionRegions } from "../src/question-regions.js";
import { publicQuestion } from "../src/exams.js";
import { backup, verifyBackup } from "../src/backup.js";
import type { AgentPort } from "../src/agent.js";
import { cleanSourceCheck } from "./helpers/source-quality.js";
import { alignedAudit } from "./helpers/grading.js";

const region = { x: 0.05, y: 0.05, width: 0.9, height: 0.4 };
async function fixture(t: any, agent?: AgentPort) {
  const f = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "study-region-test-")),
    token: "test",
    autoWorker: false,
    agent,
  });
  t.after(() => f.app.close());
  const goal = f.catalog.goal({ title: "Generic diagram reasoning" });
  const scope = f.catalog.scope(goal.id, {
    title: "Scope",
    concepts: [{ name: "Area", area: "Geometry" }],
  });
  const source = f.catalog.source(goal.id, {
    title: "Authored figure",
    rights: "user_provided",
    rightsBasis: "Authored test",
  });
  const pdf = await PDFDocument.create(),
    page = pdf.addPage([400, 400]);
  page.drawText("1. Find the area of this rectangle.", {
    x: 20,
    y: 360,
    size: 12,
  });
  page.drawRectangle({ x: 30, y: 240, width: 120, height: 60, borderWidth: 1 });
  page.drawText("4 by 2", { x: 40, y: 320, size: 12 });
  page.drawText("Other question and answer below", { x: 20, y: 100, size: 12 });
  f.sources.commit(
    source.id,
    await f.sources.prepare(source.id, {
      base64: Buffer.from(await pdf.save()).toString("base64"),
      mime: "application/pdf",
    }),
  );
  const m = latestMaterials(f.catalog, goal.id)[0]!;
  const image = await pdfPageImage(f.store, m.revisionId, 1);
  const q = f.catalog.createQuestion({
    goalId: goal.id,
    scopeId: scope.id,
    conceptIds: [scope.concepts[0]!.id],
    type: "short",
    origin: "external_practice",
    stem: "1. Find the area of this rectangle.",
    modelAnswer: "8",
    rubric: [{ id: "area", description: "Area equals 8", points: 1 }],
    evidence: [
      { segmentId: m.segmentId, quote: "1. Find the area of this rectangle." },
    ],
    visualEvidence: [
      { segmentId: m.segmentId, assetId: image.assetId, role: "question" },
    ],
    requiredAssetIds: [image.assetId],
    visualTranscription: true,
  });
  return { ...f, q, m, image };
}

test("crop creates a pinned pending revision, preserves original and caches deterministic pixels in backup", async (t) => {
  const f = await fixture(t);
  const original = f.catalog.readQuestion(f.q.id);
  const q = await saveQuestionRegions(f.catalog, f.q.id, {
    expectedRevisionId: f.q.revisionId,
    regions: [{ segmentId: f.m.segmentId, bounds: region }],
  });
  assert.equal(q.status, "needs_review");
  assert.equal(q.version, 2);
  assert.deepEqual(f.catalog.readQuestion(f.q.id, f.q.revisionId), original);
  assert.deepEqual(q.visualEvidence, original.visualEvidence);
  assert.notEqual(q.requiredAssetIds[0], f.image.assetId);
  const image = await pdfRegionImage(f.store, f.m.revisionId, 1, region);
  assert.equal(image.width, 900);
  assert.equal(image.height, 400);
  assert.equal(image.assetId, q.requiredAssetIds[0]);
  assert.deepEqual(await pdfPageImage(f.store, f.m.revisionId, 1), f.image);
  assert.equal(publicQuestion(q).learnerRegions, undefined);
  assert.equal(publicQuestion(q).visualEvidence, undefined);
  assert.deepEqual(publicQuestion(q).requiredAssetIds, [image.assetId]);
  const saved = backup(f.store);
  assert.ok(
    verifyBackup(join(f.store.dir, "backups", saved.id)).assets.includes(
      f.store.get("assets", image.assetId).hash,
    ),
  );
  const restored = await saveQuestionRegions(f.catalog, f.q.id, {
    expectedRevisionId: q.revisionId,
    regions: [],
  });
  assert.deepEqual(restored.requiredAssetIds, [f.image.assetId]);
  assert.equal(restored.status, "needs_review");
});

test("crop endpoint rejects missing auth, stale version, foreign/answer source, duplicate page and invalid bounds", async (t) => {
  const f = await fixture(t);
  const post = (body: any, auth = true) =>
    f.app.inject({
      method: "POST",
      url: `/api/questions/${f.q.id}/regions`,
      headers: auth ? { authorization: "Bearer test" } : {},
      payload: body,
    });
  const valid = {
    expectedRevisionId: f.q.revisionId,
    regions: [{ segmentId: f.m.segmentId, bounds: region }],
  };
  assert.equal((await post(valid, false)).statusCode, 401);
  assert.equal(
    (await post({ ...valid, expectedRevisionId: "stale" })).statusCode,
    409,
  );
  for (const regions of [
    [{ segmentId: "foreign", bounds: region }],
    [...valid.regions, ...valid.regions],
    [{ segmentId: f.m.segmentId, bounds: { ...region, width: 1 } }],
    [{ segmentId: f.m.segmentId, bounds: { ...region, height: 0 } }],
  ])
    assert.notEqual((await post({ ...valid, regions })).statusCode, 200);
  assert.equal(f.catalog.readQuestion(f.q.id).revisionId, f.q.revisionId);
  assert.equal((await post(valid)).statusCode, 200);
});

test("forged crop provenance, bounds, omitted asset and tampered bytes are rejected", async (t) => {
  const f = await fixture(t);
  const q = await saveQuestionRegions(f.catalog, f.q.id, {
    expectedRevisionId: f.q.revisionId,
    regions: [{ segmentId: f.m.segmentId, bounds: region }],
  });
  const valid = questionInput.strip().parse(q),
    r = valid.learnerRegions[0]!;
  for (const bad of [
    { ...r, sourceAssetId: "wrong" },
    { ...r, assetId: f.image.assetId },
    { ...r, bounds: { ...region, x: 0.01 } },
  ])
    assert.throws(() =>
      validateVisualEvidence(f.store, { ...valid, learnerRegions: [bad] }),
    );
  assert.throws(() =>
    validateVisualEvidence(f.store, { ...valid, requiredAssetIds: [] }),
  );
  const a = f.store.get("assets", r.assetId);
  writeFileSync(join(f.store.dir, "assets", a.hash), "damaged");
  assert.throws(() => validateVisualEvidence(f.store, valid), /손상/);
  await assert.rejects(
    () => pdfRegionImage(f.store, f.m.revisionId, 1, region),
    /손상/,
  );
});

test("independent review receives original plus crop and rejects missing graph or answer leak", async (t) => {
  let complete = false,
    noAnswerLeak = true,
    calls = 0;
  const agent: AgentPort = {
    async ask(role, raw: any, schema, options) {
      calls++;
      assert.equal(role, "verify_question");
      assert.equal(options?.images?.length, 2);
      assert.match(options!.images![1]!.label, /learner_region/);
      assert.match(raw.visualPolicy, /Compare EACH crop/);
      return schema.parse({
        usable: true,
        evidenceValid: true,
        answerValid: true,
        reason: "test",
        rubricCheck: alignedAudit(raw.question),
        sourceCheck: cleanSourceCheck(),
        visualCheck: {
          faithful: true,
          complete,
          noAnswerLeak,
          reason: "crop test",
        },
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
  const f = await fixture(t, agent);
  const q = await saveQuestionRegions(f.catalog, f.q.id, {
    expectedRevisionId: f.q.revisionId,
    regions: [{ segmentId: f.m.segmentId, bounds: region }],
  });
  for (const [c, leak, expected] of [
    [false, true, "needs_review"],
    [true, false, "needs_review"],
    [true, true, "usable"],
  ] as const) {
    complete = c;
    noAnswerLeak = leak;
    const job = f.jobs.enqueue("verify_question", { questionId: q.id });
    await f.jobs.tick();
    assert.equal(f.jobs.get(job.id).status, "succeeded");
    assert.equal(f.catalog.readQuestion(q.id).status, expected);
    assert.equal(
      f.catalog.readQuestion(q.id).review.visualCheck.complete,
      complete,
    );
    assert.equal(
      f.catalog.readQuestion(q.id).review.visualCheck.noAnswerLeak,
      noAnswerLeak,
    );
  }
  assert.equal(calls, 3);
});
