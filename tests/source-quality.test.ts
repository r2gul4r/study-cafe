import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { questionInput } from "../src/core.js";
import { publicQuestion } from "../src/exams.js";
import { sourceCheckFailure, type SourceCheck } from "../src/source-quality.js";
import type { Material } from "../src/materials.js";
import type { AgentPort } from "../src/agent.js";
import { alignedAudit } from "./helpers/grading.js";
import { cleanSourceCheck } from "./helpers/source-quality.js";

const e = { segmentId: "answer", quote: "Working notation. Final answer: 4." };
const audit: SourceCheck = {
  ...cleanSourceCheck(),
  issues: [
    {
      kind: "notation_only",
      location: "worked_solution",
      evidence: e,
      description: "Repeated label omitted; surrounding definition is unique.",
      contextResolves: true,
      affectsAnswer: false,
      affectsGrading: false,
    },
  ],
};
const q = questionInput.parse({
  goalId: "g",
  scopeId: "s",
  type: "short",
  stem: "1. Compute 2+2.",
  modelAnswer: "4",
  rubric: [{ id: "r", description: "4", points: 1 }],
  conceptIds: ["c"],
  origin: "external_practice",
  sourceMatch: {
    questionReference: "1.",
    answerReference: "1.",
    questionEvidence: { segmentId: "paper", quote: "1. Compute 2+2." },
    answerEvidence: e,
    edition: null,
    editionEvidence: [],
  },
});
const materials = [
  { segmentId: "paper", revisionId: "p", text: q.stem },
  { segmentId: "answer", revisionId: "a", text: e.quote },
  { segmentId: "foreign", revisionId: "foreign", text: e.quote },
] as Material[];

test("source notation audit accepts only contextual intermediate omissions and keeps generated questions compatible", () => {
  assert.equal(sourceCheckFailure(q, audit, materials), null);
  assert.equal(sourceCheckFailure(q, cleanSourceCheck(), materials), null);
  assert.equal(sourceCheckFailure({ ...q, sourceMatch: null }, null, []), null);
});

for (const [name, change] of Object.entries({
  missing: (_: SourceCheck): null => null,
  wrong_final_answer: (a: SourceCheck) => ({ ...a, finalAnswerMatches: false }),
  ambiguous_question: (a: SourceCheck) => ({
    ...a,
    questionUnambiguous: false,
  }),
  numeric_error: (a: SourceCheck) => ({
    ...a,
    issues: [{ ...a.issues[0]!, kind: "answer_error" }],
  }),
  ambiguous_symbol: (a: SourceCheck) => ({
    ...a,
    issues: [{ ...a.issues[0]!, kind: "ambiguous" }],
  }),
  omitted_question_condition: (a: SourceCheck) => ({
    ...a,
    issues: [
      {
        ...a.issues[0]!,
        location: "question",
        evidence: { segmentId: "paper", quote: q.stem },
      },
    ],
  }),
  final_answer_omission: (a: SourceCheck) => ({
    ...a,
    issues: [{ ...a.issues[0]!, location: "final_answer" }],
  }),
  context_unresolved: (a: SourceCheck) => ({
    ...a,
    issues: [{ ...a.issues[0]!, contextResolves: false }],
  }),
  answer_affected: (a: SourceCheck) => ({
    ...a,
    issues: [{ ...a.issues[0]!, affectsAnswer: true }],
  }),
  grading_affected: (a: SourceCheck) => ({
    ...a,
    issues: [{ ...a.issues[0]!, affectsGrading: true }],
  }),
  fabricated_quote: (a: SourceCheck) => ({
    ...a,
    issues: [{ ...a.issues[0]!, evidence: { ...e, quote: "invented" } }],
  }),
  foreign_revision: (a: SourceCheck) => ({
    ...a,
    issues: [{ ...a.issues[0]!, evidence: { ...e, segmentId: "foreign" } }],
  }),
})) {
  test(`source audit refuses unsafe or unsupported classification: ${name}`, () => {
    assert.ok(
      sourceCheckFailure(
        q,
        change(structuredClone(audit)) as SourceCheck | null,
        materials,
      ),
    );
  });
}

test("workflow persists notation evidence, rejects conflicting flags, retains model veto and manual review, and hides answers before submission", async (t) => {
  let mode = "notation";
  const agent: AgentPort = {
    async ask(role, raw: any, schema) {
      assert.equal(role, "verify_question");
      assert.equal(raw.question.review, undefined);
      assert.equal(raw.question.status, undefined);
      assert.match(raw.sourceQualityPolicy, /incorrect numeric equality/);
      const sourceCheck = {
        ...audit,
        issues: [
          {
            ...audit.issues[0]!,
            evidence: raw.question.sourceMatch.answerEvidence,
            affectsGrading: mode === "grading",
          },
        ],
      };
      return schema.parse({
        usable: mode !== "veto",
        evidenceValid: true,
        answerValid: true,
        reason: "Independent fixture review",
        rubricCheck: alignedAudit(raw.question),
        sourceCheck,
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
    dataDir: mkdtempSync(join(tmpdir(), "study-source-quality-")),
    token: "test",
    autoWorker: false,
    agent,
  });
  t.after(() => f.app.close());
  const goal = f.catalog.goal({ title: "Generic review" });
  const scope = f.catalog.scope(goal.id, {
    title: "Values",
    concepts: [{ name: "Values", area: "General" }],
  });
  const source = f.catalog.source(goal.id, {
    title: "Authored fixture",
    rights: "user_provided",
    rightsBasis: "authored",
  });
  f.sources.commit(
    source.id,
    await f.sources.prepare(source.id, { text: `${q.stem} 1. ${e.quote}` }),
  );
  const segment = f.catalog.segments(source.id)[0]!;
  const qe = { segmentId: segment.id, quote: q.stem };
  const ae = { segmentId: segment.id, quote: `1. ${e.quote}` };
  const item = f.catalog.createQuestion({
    ...q,
    goalId: goal.id,
    scopeId: scope.id,
    conceptIds: [scope.concepts[0]!.id],
    evidence: [qe, ae],
    sourceMatch: {
      ...q.sourceMatch!,
      questionEvidence: qe,
      answerEvidence: ae,
    },
  });
  for (const current of ["notation", "grading", "veto"]) {
    mode = current;
    const job = f.jobs.enqueue("verify_question", { questionId: item.id });
    await f.jobs.tick();
    assert.equal(f.jobs.get(job.id).status, "succeeded");
    const saved = f.catalog.readQuestion(item.id);
    assert.equal(saved.status, mode === "notation" ? "usable" : "needs_review");
    assert.equal(saved.modelAnswer, "4");
    assert.equal(saved.review.sourcePolicyVersion, 1);
    assert.equal(saved.review.sourceCheck.issues[0].evidence.quote, ae.quote);
    if (mode === "notation")
      assert.match(saved.review.reason, /정답·채점 영향 없음/);
    if (mode === "grading") assert.match(saved.review.reason, /의미 불확실/);
    assert.equal(publicQuestion(saved).review, undefined);
    assert.equal(publicQuestion(saved).modelAnswer, undefined);
  }
  f.catalog.review(item.revisionId, "usable", "User decision");
  assert.equal(f.catalog.readQuestion(item.id).review.sourceCheck, undefined);
  assert.equal(f.catalog.readQuestion(item.id).review.actor, "user");
});
