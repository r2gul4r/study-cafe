import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { questionInput } from "../src/core.js";
import { publicQuestion } from "../src/exams.js";
import { saveCorrection, confirmCorrection } from "../src/corrections.js";
import { sourceCheckFailure, type SourceCheck } from "../src/source-quality.js";
import { alignedAudit } from "./helpers/grading.js";
import type { AgentPort } from "../src/agent.js";

async function fixture(t: any) {
  let audit: SourceCheck;
  let mode = "valid";
  const agent: AgentPort = {
    async ask(role, raw: any, schema) {
      assert.equal(role, "verify_question");
      assert.equal(raw.question.review, undefined);
      const correction = !!raw.correction;
      if (correction) {
        assert.equal(raw.originalQuestion.modelAnswer, "5");
        assert.match(raw.correctionPolicy, /USER-SAVED CORRECTION/);
      }
      return schema.parse({
        usable: true,
        evidenceValid: true,
        answerValid: true,
        reason: "Independent check",
        rubricCheck: alignedAudit(raw.question),
        sourceCheck: mode === "omitted" ? { ...audit, issues: [] } : audit,
        correctionCheck:
          correction && mode !== "missing"
            ? {
                correctedAnswerValid: mode !== "wrong",
                allIssuesAddressed: mode !== "incomplete",
                reason: "Checked against original",
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
  const f = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "study-correction-")),
    token: "test",
    autoWorker: false,
    agent,
  });
  t.after(() => f.app.close());
  const goal = f.catalog.goal({ title: "Quantities" });
  const scope = f.catalog.scope(goal.id, {
    title: "Arithmetic",
    concepts: [{ name: "Addition", area: "Numbers" }],
  });
  const source = f.catalog.source(goal.id, {
    title: "Authored source",
    rights: "user_provided",
    rightsBasis: "authored",
  });
  const stem = "1. Compute 2 + 2. Give only the result.",
    key = "1. Solution: 2 + 2 = 5. Final answer: 5.";
  f.sources.commit(
    source.id,
    await f.sources.prepare(source.id, { text: stem + "\n" + key }),
  );
  const segment = f.catalog.segments(source.id)[0]!;
  const qe = { segmentId: segment.id, quote: stem },
    ae = { segmentId: segment.id, quote: key };
  const q = f.catalog.createQuestion({
    goalId: goal.id,
    scopeId: scope.id,
    type: "short",
    stem,
    modelAnswer: "5",
    rubric: [{ id: "r", description: "5", points: 1 }],
    explanation: key,
    origin: "external_practice",
    conceptIds: [scope.concepts[0]!.id],
    evidence: [qe, ae],
    sourceMatch: {
      questionReference: "1.",
      answerReference: "1.",
      questionEvidence: qe,
      answerEvidence: ae,
      edition: null,
      editionEvidence: [],
    },
  });
  audit = {
    questionUnambiguous: true,
    finalAnswerMatches: false,
    independentAnswer: "4",
    issues: [
      {
        kind: "answer_error",
        location: "final_answer",
        evidence: ae,
        description: "2 + 2 is 4, not 5",
        contextResolves: false,
        affectsAnswer: true,
        affectsGrading: true,
      },
    ],
  };
  const verify = async () => {
    const job = f.jobs.enqueue("verify_question", { questionId: q.id });
    await f.jobs.tick();
    assert.equal(
      f.jobs.get(job.id).status,
      "succeeded",
      JSON.stringify(f.jobs.get(job.id).error),
    );
    return f.catalog.readQuestion(q.id);
  };
  await verify();
  const input = () => ({
    expectedRevisionId: f.catalog.readQuestion(q.id).revisionId,
    reason: "Independent addition confirms four",
    evidence: [ae],
    answer: [],
    modelAnswer: "4",
    rubric: [{ id: "r", description: "4", points: 1 }],
    explanation:
      "The original key says 5; 2 + 2 = 4. Only the result is required.",
  });
  return {
    ...f,
    q,
    audit,
    ae,
    input,
    verify,
    mode: (value: string) => {
      mode = value;
    },
  };
}

test("correction requires exact original evidence, immutable question, independent review and a current confirmation token", async (t) => {
  const f = await fixture(t),
    id = f.q.id;
  assert.throws(
    () => f.catalog.review(f.q.revisionId, "usable", "bypass"),
    /정정안/,
  );
  f.catalog.review(f.q.revisionId, "needs_review", "Keep pending");
  assert.throws(
    () => f.catalog.review(f.q.revisionId, "usable", "bypass"),
    /정정안/,
  );
  assert.throws(
    () =>
      f.catalog.createQuestion(
        { ...questionInput.strip().parse(f.q), modelAnswer: "4" },
        { questionId: id },
      ),
    /정정 기능/,
  );
  assert.throws(
    () =>
      saveCorrection(f.catalog, id, {
        ...f.input(),
        evidence: [{ ...f.ae, quote: "fabricated" }],
      }),
    /인용/,
  );
  assert.throws(
    () =>
      saveCorrection(f.catalog, id, {
        ...f.input(),
        evidence: [{ ...f.ae, quote: "1." }],
      }),
    /모두 포함/,
  );
  assert.throws(() =>
    saveCorrection(f.catalog, id, { ...f.input(), stem: "changed" }),
  );
  const draft = saveCorrection(f.catalog, id, f.input());
  assert.equal(draft.status, "needs_review");
  assert.equal(
    draft.review.answerCorrection.originalRevisionId,
    f.q.revisionId,
  );
  assert.throws(
    () =>
      confirmCorrection(f.catalog, id, {
        revisionId: draft.revisionId,
        reviewToken: draft.correctionReviewToken,
        reason: "premature",
      }),
    /통과/,
  );
  assert.throws(
    () =>
      saveCorrection(f.catalog, id, {
        ...f.input(),
        expectedRevisionId: f.q.revisionId,
      }),
    /버전/,
  );
  const checked = await f.verify();
  assert.equal(checked.status, "needs_review");
  assert.equal(checked.review.answerCorrection.verification.passed, true);
  assert.throws(
    () =>
      confirmCorrection(f.catalog, id, {
        revisionId: draft.revisionId,
        reviewToken: draft.correctionReviewToken,
        reason: "stale review",
      }),
    /변경/,
  );
  const res = await f.app.inject({
    method: "POST",
    url: `/api/questions/${id}/corrections/confirm`,
    headers: { authorization: "Bearer test" },
    payload: {
      revisionId: checked.revisionId,
      reviewToken: checked.correctionReviewToken,
      reason: "Original compared and calculation checked",
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const confirmed = res.json();
  assert.equal(confirmed.status, "usable");
  assert.ok(confirmed.review.answerCorrection.confirmedAt);
  assert.equal(f.catalog.readQuestion(id, f.q.revisionId).modelAnswer, "5");
  assert.equal(
    f.catalog
      .segments(f.catalog.questionEvidence(id)[0]!.sourceId)[0]!
      .text.includes("2 + 2 = 5"),
    true,
  );
  assert.equal(publicQuestion(confirmed).correctionReviewToken, undefined);
  assert.equal(publicQuestion(confirmed).review, undefined);
  assert.deepEqual(
    (await f.verify()).review,
    confirmed.review,
    "late AI result cannot overwrite manual confirmation",
  );
  const edited = f.catalog.createQuestion(
    {
      ...questionInput.strip().parse(confirmed),
      explanation: "Four. Original five is wrong.",
    },
    { questionId: id, expectedRevisionId: confirmed.revisionId },
  );
  assert.equal(edited.review.answerCorrection.verification, undefined);
  assert.equal(edited.review.answerCorrection.confirmedAt, undefined);
  assert.throws(
    () =>
      confirmCorrection(f.catalog, id, {
        revisionId: confirmed.revisionId,
        reviewToken: confirmed.correctionReviewToken,
        reason: "stale",
      }),
    /변경/,
  );
  assert.throws(
    () =>
      f.catalog.createQuestion(
        { ...questionInput.strip().parse(edited), stem: "Changed condition" },
        { questionId: id },
      ),
    /변경할 수 없습니다/,
  );
});

test("permissive model verdict cannot bypass missing, failed or incomplete correction audit; retired drafts invalidate verification", async (t) => {
  const f = await fixture(t);
  saveCorrection(f.catalog, f.q.id, f.input());
  for (const mode of ["missing", "wrong", "incomplete", "omitted"]) {
    f.mode(mode);
    const q = await f.verify();
    assert.equal(q.status, "needs_review");
    assert.equal(q.review.answerCorrection.verification.passed, false, mode);
  }
  f.mode("valid");
  const q = await f.verify();
  f.catalog.review(q.revisionId, "retired", "No longer needed");
  assert.equal(
    (await f.verify()).status,
    "retired",
    "late AI result cannot revive a retired draft",
  );
  assert.equal(
    f.catalog.readQuestion(q.id).review.answerCorrection.verification,
    undefined,
  );
  assert.throws(
    () =>
      confirmCorrection(f.catalog, q.id, {
        revisionId: q.revisionId,
        reviewToken: q.correctionReviewToken,
        reason: "retired",
      }),
    /활성 정정안/,
  );
});

test("correction audit cannot bypass fabricated or foreign source evidence or ambiguous questions", async (t) => {
  const f = await fixture(t);
  const q = saveCorrection(f.catalog, f.q.id, f.input());
  const correction = q.review.answerCorrection;
  const materials: any = [
    { segmentId: f.ae.segmentId, revisionId: "a", text: f.ae.quote },
  ];
  const check = {
    correctedAnswerValid: true,
    allIssuesAddressed: true,
    reason: "ok",
  };
  assert.equal(
    sourceCheckFailure(q, f.audit, materials, correction, check),
    null,
  );
  assert.ok(
    sourceCheckFailure(
      q,
      f.audit,
      [{ ...materials[0], text: "Unrelated" }],
      correction,
      check,
    ),
  );
  assert.ok(
    sourceCheckFailure(
      q,
      { ...f.audit, questionUnambiguous: false },
      materials,
      correction,
      check,
    ),
  );
  const changed = structuredClone(f.audit);
  changed.issues[0]!.evidence.segmentId = "foreign";
  assert.ok(
    sourceCheckFailure(
      q,
      changed,
      [
        ...materials,
        { segmentId: "foreign", revisionId: "b", text: f.ae.quote },
      ],
      correction,
      check,
    ),
  );
});
