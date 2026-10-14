import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createApp } from "../src/app.js";
import { revisionInput } from "../apps/web/src/question-input.js";
import type { AgentPort } from "../src/agent.js";

test("corrected short answers stay in manual review even after another pending manual assessment", async (t) => {
  let calls = 0;
  const agent: AgentPort = {
    async ask() {
      calls++;
      throw new Error("Should not reapply the frozen old rubric");
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
    dataDir: mkdtempSync(join(tmpdir(), "study-rubric-")),
    token: "test",
    autoWorker: false,
    agent,
  });
  t.after(() => f.app.close());
  const goal = f.catalog.goal({ title: "Rubric correction" });
  const scope = f.catalog.scope(goal.id, {
    title: "Scope",
    concepts: [{ name: "Sum", area: "Math" }],
  });
  const source = f.catalog.source(goal.id, {
    title: "Source",
    kind: "user_material",
    rights: "user_provided",
    rightsBasis: "Authored",
  });
  f.sources.commit(
    source.id,
    await f.sources.prepare(source.id, { text: "One plus one is two." }),
  );
  const original = f.catalog.createQuestion({
    goalId: goal.id,
    scopeId: scope.id,
    type: "short",
    stem: "Explain 1+1",
    modelAnswer: "Two",
    rubric: [{ id: "r", description: "Two", points: 1 }],
    origin: "external_practice",
    conceptIds: [scope.concepts[0]!.id!],
    evidence: [
      {
        segmentId: f.catalog.segments(source.id)[0].id,
        quote: "One plus one is two.",
      },
    ],
  });
  f.catalog.review(original.revisionId, "usable", "Initial");
  const template = f.exams.template({
    name: "Short",
    total: 1,
    single: 0,
    short: 1,
  });
  const exam = f.exams.create(goal.id, template.id);
  f.exams.finalize(exam.id);
  const attempt = f.exams.start(exam.id);
  f.exams.saveAnswer(attempt.id, 1, {
    value: "Two",
    version: 0,
    flagged: false,
    uncertain: false,
    hintUsed: false,
    recall: null,
  });
  f.learning.submit(attempt.id, "submit");
  const { expectedRevisionId, ...input } = revisionInput(original);
  const changed = f.catalog.createQuestion(
    { ...input, modelAnswer: "One item and another item make two items." },
    { questionId: original.id, expectedRevisionId },
  );
  f.catalog.review(changed.revisionId, "usable", "Improved rubric");
  f.learning.regradeQuestion(
    original.id,
    changed.revisionId,
    "Review answer against new standard",
  );
  f.learning.manual(attempt.id, 1, {
    score: null,
    passed: false,
    status: "pending",
    reason: "Still unclear",
    explanation: "Keep pending",
    expectedVersion: f.learning.latest(attempt.id, 1)!.version,
  });
  const job = f.jobs.enqueue("grade_attempt", { attemptId: attempt.id });
  await f.jobs.tick();
  for (
    let i = 0;
    i < 100 && ["queued", "running"].includes(f.jobs.get(job.id).status);
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.jobs.get(job.id).status, "succeeded");
  assert.equal(calls, 0);
  assert.equal(f.learning.result(attempt.id).pending, 1);
  assert.equal(
    f.learning.latest(attempt.id, 1)!.correctionRevision,
    changed.revisionId,
  );
});

test("editing HTTP workflow preserves provenance/history, rejects stale writes and regrades only older attempts", async (t) => {
  const f = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "study-edit-")),
    token: "test",
    autoWorker: false,
  });
  t.after(() => f.app.close());
  const request = async (method: "GET" | "POST", url: string, payload?: any) =>
    f.app.inject({
      method,
      url: "/api" + url,
      headers: { authorization: "Bearer test" },
      ...(payload ? { payload } : {}),
    });
  const goal = f.catalog.goal({ title: "Correction" });
  const scope = f.catalog.scope(goal.id, {
    title: "Scope",
    concepts: [{ name: "Sum", area: "Math" }],
  });
  const source = f.catalog.source(goal.id, {
    title: "Own material",
    kind: "user_material",
    rights: "user_provided",
    rightsBasis: "Authored test",
  });
  f.sources.commit(
    source.id,
    await f.sources.prepare(source.id, { text: "One plus one is two." }),
  );
  const original = f.catalog.createQuestion({
    goalId: goal.id,
    scopeId: scope.id,
    type: "single",
    stem: "1+1?",
    choices: [
      { id: "a", text: "1" },
      { id: "b", text: "2" },
    ],
    answer: ["a"],
    origin: "external_practice",
    conceptIds: [scope.concepts[0]!.id!],
    evidence: [
      {
        segmentId: f.catalog.segments(source.id)[0].id,
        quote: "One plus one is two.",
      },
    ],
    groupId: "shared-passage",
  });
  f.catalog.review(original.revisionId, "usable", "Initial test key");
  const template = f.exams.template({
    name: "One",
    total: 1,
    single: 1,
    short: 0,
  });
  const makeAttempt = () => {
    const exam = f.exams.create(goal.id, template.id);
    f.exams.finalize(exam.id);
    const attempt = f.exams.start(exam.id);
    f.exams.saveAnswer(attempt.id, 1, {
      value: ["b"],
      version: 0,
      flagged: false,
      uncertain: false,
      hintUsed: false,
      recall: null,
    });
    f.learning.submit(attempt.id, attempt.id);
    return attempt;
  };
  const oldAttempt = makeAttempt();
  const payload = {
    ...revisionInput(original),
    answer: ["b"],
    explanation: "The corrected sum is two.",
  };
  const saved = await request(
    "POST",
    `/questions/${original.id}/revisions`,
    payload,
  );
  assert.equal(saved.statusCode, 200, saved.body);
  const updated = saved.json();
  assert.equal(updated.version, 2);
  assert.equal(updated.status, "needs_review");
  assert.equal(updated.groupId, original.groupId);
  assert.equal(updated.familyId, original.familyId);
  assert.deepEqual(
    updated.evidence,
    original.evidence.map((e: any) => ({ ...e })),
  );
  assert.equal(
    (await request("POST", `/questions/${original.id}/revisions`, payload))
      .statusCode,
    409,
  );
  const history = await request("GET", `/questions/${original.id}/revisions`);
  assert.deepEqual(
    history.json().map((q: any) => q.version),
    [2, 1],
  );
  assert.deepEqual(history.json()[1].answer, ["a"]);
  assert.equal(typeof history.json()[0].createdAt, "string");
  assert.equal(
    (await f.app.inject({ url: `/api/questions/${original.id}/revisions` }))
      .statusCode,
    401,
  );
  assert.equal(
    (await request("GET", "/questions/missing/revisions")).statusCode,
    404,
  );
  assert.equal(
    (
      await request("POST", `/questions/${original.id}/regrade`, {
        revisionId: updated.revisionId,
        reason: "Corrected",
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await request("POST", `/questions/${original.id}/review`, {
        revisionId: updated.revisionId,
        status: "usable",
        reason: "Checked against source",
      })
    ).statusCode,
    200,
  );
  const freshAttempt = makeAttempt();
  const corrected = await request("POST", `/questions/${original.id}/regrade`, {
    revisionId: updated.revisionId,
    reason: "Answer key error",
  });
  assert.deepEqual(corrected.json().affected, [
    { attemptId: oldAttempt.id, slot: 1, status: "confirmed" },
  ]);
  assert.equal(f.learning.result(oldAttempt.id).finalScore, 1);
  assert.equal(
    f.learning.result(freshAttempt.id).items[0].assessment.version,
    1,
  );
  assert.deepEqual(f.exams.get(oldAttempt.examId, true).items[0].answer, ["a"]);
  assert.deepEqual(
    f.learning.result(oldAttempt.id).items[0].assessment.correctedAnswer,
    ["b"],
  );
  assert.equal(
    f.learning.result(oldAttempt.id).items[0].assessment.correctedExplanation,
    payload.explanation,
  );
  assert.equal(
    (
      await request("POST", `/questions/${original.id}/regrade`, {
        revisionId: updated.revisionId,
        reason: "Retry",
      })
    ).json().affected.length,
    0,
  );
  const assessment = f.learning.result(oldAttempt.id).items[0].assessment;
  f.learning.manual(oldAttempt.id, 1, {
    score: 0,
    passed: false,
    status: "confirmed",
    reason: "Manual review",
    explanation: "Keep user decision",
    expectedVersion: assessment.version,
  });
  assert.equal(
    (
      await request("POST", `/questions/${original.id}/regrade`, {
        revisionId: updated.revisionId,
        reason: "Retry after manual review",
      })
    ).json().affected.length,
    0,
  );
  assert.equal(f.learning.result(oldAttempt.id).finalScore, 0);
  assert.deepEqual(
    f.learning.result(oldAttempt.id).items[0].assessment.correctedAnswer,
    ["b"],
  );
  const next = await request("POST", `/questions/${original.id}/revisions`, {
    ...revisionInput(updated),
    stem: "Changed context: 2+2?",
  });
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(
    (
      await request("POST", `/questions/${original.id}/regrade`, {
        revisionId: updated.revisionId,
        reason: "Stale correction",
      })
    ).statusCode,
    409,
  );
  await request("POST", `/questions/${original.id}/review`, {
    revisionId: next.json().revisionId,
    status: "usable",
    reason: "Reviewed",
  });
  const pending = await request("POST", `/questions/${original.id}/regrade`, {
    revisionId: next.json().revisionId,
    reason: "Changed context",
  });
  assert.equal(pending.json().affected.length, 2);
  assert.ok(
    pending.json().affected.every((item: any) => item.status === "pending"),
  );
  assert.equal(f.learning.result(oldAttempt.id).finalScore, null);
});

test("PDF upload through ingest jobs exposes extracted text and a failed malformed file without calling AI", async (t) => {
  const f = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "study-pdf-")),
    token: "test",
    autoWorker: false,
  });
  t.after(() => f.app.close());
  const goal = f.catalog.goal({ title: "PDF" });
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Study Cafe PDF: One plus one equals two.", {
    x: 40,
    y: 700,
    font,
  });
  for (const [title, bytes, expected] of [
    ["Valid", await pdf.save(), "succeeded"],
    ["Broken", Buffer.from("%PDF-1.7\nnot a PDF document"), "failed"],
  ] as const) {
    const source = f.catalog.source(goal.id, {
      title,
      kind: "user_material",
      rights: "user_provided",
      rightsBasis: "Authored",
    });
    const response = await f.app.inject({
      method: "POST",
      url: `/api/sources/${source.id}/ingest`,
      headers: { authorization: "Bearer test" },
      payload: {
        mime: "application/pdf",
        base64: Buffer.from(bytes).toString("base64"),
      },
    });
    assert.equal(response.statusCode, 202, response.body);
    const jobId = response.json().id;
    await f.jobs.tick();
    // enqueue also schedules a worker; wait only if it won the race.
    for (
      let i = 0;
      i < 100 && ["queued", "running"].includes(f.jobs.get(jobId).status);
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    const job = f.jobs.get(jobId);
    assert.equal(job.status, expected, JSON.stringify(job.error));
    if (expected === "succeeded")
      assert.match(
        f.catalog.segments(source.id)[0].text,
        /One plus one equals two/,
      );
    else {
      assert.ok(job.error);
      assert.equal(f.catalog.segments(source.id).length, 0);
    }
  }
});
