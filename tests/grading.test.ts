import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createApp } from "../src/app.js";
import type { AgentPort } from "../src/agent.js";
import { resolveShortGrade, validateRubricAudit } from "../src/grading.js";
import { alignedAudit } from "./helpers/grading.js";
import { Fault } from "../src/core.js";

const question = {
  stem: "위성의 의미를 설명하시오.",
  passage: null,
  rubric: [
    {
      id: "meaning",
      description: "다른 천체 주위를 도는 천체",
      points: 2,
      required: true,
    },
  ],
};
function grade(answer: string, score = 2, verdict = "equivalent") {
  return {
    status: "confirmed",
    passed: score === 2,
    reason: "unknown",
    explanation:
      score === 2
        ? "다른 표현으로 같은 의미를 전달했습니다."
        : "요구한 내용이 부족합니다.",
    criteria: [
      {
        id: "meaning",
        score,
        verdict,
        evidence: answer,
        reason: "문제에서 요구한 의미와 답안 전체를 대조했습니다.",
      },
    ],
  };
}
type Case = {
  stem: string;
  answer: string;
  modelAnswer?: string;
  description?: string;
};
async function fixture(
  t: any,
  cases: Case[],
  respond: (role: string, input: any) => any,
) {
  const calls: { role: string; input: any }[] = [];
  const agent: AgentPort = {
    async ask<T>(role: string, input: any, schema: z.ZodType<T>): Promise<T> {
      calls.push({ role, input });
      return schema.parse(await respond(role, input));
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
    dataDir: mkdtempSync(join(tmpdir(), "study-fair-grade-")),
    token: "test",
    autoWorker: false,
    agent,
  });
  t.after(() => f.app.close());
  const goal = f.catalog.goal({ title: "범용 주관식 검증" });
  const scope = f.catalog.scope(goal.id, {
    title: "사용자 범위",
    concepts: [{ name: "개념 이해", area: "범용" }],
  });
  const source = f.catalog.source(goal.id, {
    title: "직접 작성한 자료",
    kind: "user_material",
    rights: "user_provided",
    rightsBasis: "authored fixture",
  });
  f.sources.commit(
    source.id,
    await f.sources.prepare(source.id, {
      text: "검증용 자료: 각각의 개념과 조건을 확인한다.",
    }),
  );
  for (const c of cases) {
    const q = f.catalog.createQuestion({
      goalId: goal.id,
      scopeId: scope.id,
      type: "short",
      stem: c.stem,
      modelAnswer: c.modelAnswer ?? "다른 천체 주위를 도는 천체",
      rubric: [
        {
          ...question.rubric[0],
          description: c.description ?? question.rubric[0]!.description,
        },
      ],
      points: 2,
      origin: "external_practice",
      conceptIds: [scope.concepts[0]!.id!],
      evidence: [
        {
          segmentId: f.catalog.segments(source.id)[0].id,
          quote: "각각의 개념과 조건을 확인한다.",
        },
      ],
    });
    f.catalog.review(q.revisionId, "usable", "fixture");
  }
  const template = f.exams.template({
    name: "채점 검증",
    total: cases.length,
    single: 0,
    short: cases.length,
  });
  const exam = f.exams.create(goal.id, template.id);
  f.exams.finalize(exam.id);
  const attempt = f.exams.start(exam.id);
  for (const item of attempt.exam.items)
    f.exams.saveAnswer(attempt.id, item.slot, {
      value: cases.find((c) => c.stem === item.stem)!.answer,
      version: 0,
      flagged: false,
      uncertain: false,
      hintUsed: false,
      recall: null,
    });
  f.learning.submit(attempt.id, "submit");
  async function run(
    kind = "grade_attempt",
    input: any = { attemptId: attempt.id },
  ) {
    const job = f.jobs.enqueue(kind, input);
    await f.jobs.tick();
    for (let i = 0; i < 200; i++) {
      const current = f.jobs.get(job.id);
      if (!["queued", "running"].includes(current.status)) return current;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("Job timed out");
  }
  return { ...f, goal, exam, attempt, calls, run };
}

test("unrequested explanation in a bundled rubric stays pending without affecting other answers or frozen exams", async (t) => {
  const cases = [
    {
      stem: "두 수의 합을 쓰시오.",
      answer: "4",
      modelAnswer: "4. 두 수를 더하면 4이다.",
      description: "4를 쓰고 덧셈 원리를 설명한다.",
    },
    { stem: question.stem, answer: "다른 천체 둘레를 공전하는 천체" },
  ];
  const f = await fixture(t, cases, (role, input) => {
    if (role === "audit_rubric") {
      assert.equal("answer" in input, false);
      assert.equal("modelAnswer" in input.question, false);
      const audit = alignedAudit(input.question);
      if (input.question.stem === cases[0]!.stem) {
        audit.criteria[0].aligned = false;
        audit.criteria[0].reason =
          "합만 요구했으므로 덧셈 원리 설명을 감점 기준으로 삼을 수 없습니다.";
      }
      return audit;
    }
    assert.equal(role, "grade_answer");
    assert.equal(input.answer, cases[1]!.answer);
    return grade(input.answer);
  });
  const before = f.exams.get(f.exam.id, true);
  assert.equal((await f.run()).status, "succeeded");
  const result = f.learning.result(f.attempt.id);
  assert.equal(result.pending, 1);
  assert.equal(result.earned, 2);
  assert.equal(result.confirmedPossible, 2);
  assert.equal(result.finalScore, null);
  const pending = result.items.find(
    (q: any) => q.stem === cases[0]!.stem,
  ).assessment;
  assert.equal(pending.score, null);
  assert.match(pending.explanation, /덧셈 원리/);
  assert.equal(pending.gradingReview.rubricAudit.criteria[0].aligned, false);
  assert.equal(f.learning.wrong(f.goal.id).length, 0);
  assert.equal(f.store.one("SELECT COUNT(*) n FROM review_events").n, 1);
  assert.deepEqual(f.exams.get(f.exam.id, true), before);
});

test("equivalent answers across subjects retain full points without literal model-answer matching", async (t) => {
  const cases = [
    {
      stem: "위성의 의미는?",
      answer: "다른 천체 둘레를 공전하는 천체",
      modelAnswer: "다른 천체 주위를 도는 천체",
    },
    { stem: "0.5를 분수로 나타내시오.", answer: "1/2", modelAnswer: "2/4" },
    {
      stem: "조리개가 넓어질 때 밝기 변화를 설명하시오.",
      answer: "들어오는 빛이 늘어 더 밝아집니다.",
      modelAnswer: "개방 시 광량이 증가한다.",
    },
    {
      stem: "실행 횟수를 쓰시오.",
      answer: "0회",
      modelAnswer: "0번 실행됩니다.",
    },
    {
      stem: "반복 안팎의 출력과 차이의 이유를 설명하시오.",
      answer: "A\nA\n끝\n끝은 반복 밖이라 한 번, A는 안이라 두 번입니다.",
      modelAnswer: "안의 출력은 두 번이고, 밖의 출력은 한 번이다.",
    },
  ];
  const f = await fixture(t, cases, (role, input) => {
    if (role === "audit_rubric") return alignedAudit(input.question);
    assert.equal(role, "grade_answer");
    assert.notEqual(input.answer, input.question.modelAnswer);
    assert.match(input.instruction, /WHOLE answer/);
    return grade(input.answer);
  });
  assert.equal((await f.run()).status, "succeeded");
  const result = f.learning.result(f.attempt.id);
  assert.equal(result.finalScore, 10);
  assert.equal(result.pending, 0);
  assert.ok(
    result.items.every(
      (q: any) => q.assessment.criteria[0].verdict === "equivalent",
    ),
  );
  assert.equal(
    f.calls.filter((c) => c.role === "review_short_answer").length,
    0,
  );
});

test("negation, wrong units and an explicitly requested missing explanation require an independent deduction review", async (t) => {
  const cases = [
    { stem: "위성은 공전하는가?", answer: "공전하지 않는다." },
    { stem: "거리 1km를 m 단위로 쓰시오.", answer: "1m" },
    { stem: "결과와 이유를 설명하시오.", answer: "결과는 4입니다." },
  ];
  const f = await fixture(t, cases, (role, input) => {
    if (role === "audit_rubric") return alignedAudit(input.question);
    assert.ok(["grade_answer", "review_short_answer"].includes(role));
    assert.equal(
      "first" in input,
      false,
      "Recheck is blind to the first score",
    );
    const missingReason = input.question.stem === cases[2]!.stem;
    return grade(
      input.answer,
      missingReason ? 1 : 0,
      missingReason ? "partial" : "contradiction",
    );
  });
  assert.equal((await f.run()).status, "succeeded");
  assert.equal(
    f.calls.filter((c) => c.role === "review_short_answer").length,
    3,
  );
  assert.equal(f.learning.result(f.attempt.id).finalScore, 1);
  assert.equal(f.learning.wrong(f.goal.id).length, 3);
  assert.ok(
    f.learning
      .result(f.attempt.id)
      .items.every((q: any) => q.assessment.gradingReview.secondPass),
  );
});

test("disagreement over equivalent wording is pending, not an averaged score or wrong-answer event", async (t) => {
  const f = await fixture(
    t,
    [{ stem: question.stem, answer: "다른 천체를 중심으로 도는 물체" }],
    (role, input) => {
      if (role === "audit_rubric") return alignedAudit(input.question);
      return role === "grade_answer"
        ? grade(input.answer, 0, "missing")
        : grade(input.answer);
    },
  );
  assert.equal((await f.run()).status, "succeeded");
  const result = f.learning.result(f.attempt.id);
  assert.equal(result.pending, 1);
  assert.equal(result.items[0].assessment.score, null);
  assert.match(result.items[0].assessment.explanation, /일치하지/);
  assert.equal(f.learning.wrong(f.goal.id).length, 0);
  assert.equal(f.store.one("SELECT COUNT(*) n FROM review_events").n, 0);
});

test("rubric auditing rejects invented prompt quotes, missing/foreign IDs and empty aligned evidence", () => {
  const base = alignedAudit(question);
  for (const patch of [
    { promptQuote: "모범답안을 그대로 쓰시오." },
    { promptQuote: "" },
    { id: "foreign" },
    { promptField: "passage" },
  ])
    assert.throws(() =>
      validateRubricAudit(question, {
        ...base,
        criteria: [{ ...base.criteria[0], ...patch }],
      }),
    );
  assert.throws(() => validateRubricAudit(question, { ...base, criteria: [] }));
  assert.throws(() =>
    validateRubricAudit(question, {
      ...base,
      criteria: [base.criteria[0], base.criteria[0]],
    }),
  );
});

test("semantic verdict and score must agree; uncertainty is never fallback partial credit", () => {
  const audit = alignedAudit(question);
  for (const first of [
    grade("공전하는 천체", 1, "equivalent"),
    grade("공전하는 천체", 2, "contradiction"),
    grade("공전하는 천체", 1, "uncertain"),
    { ...grade("공전하는 천체"), status: "pending" },
  ]) {
    const r = resolveShortGrade(question, "공전하는 천체", { audit, first });
    assert.equal(r.status, "pending");
    assert.equal(r.passed, false);
    assert.deepEqual(r.criteria, []);
  }
  assert.throws(
    () =>
      resolveShortGrade(question, "공전하지 않는 천체", {
        audit,
        first: grade("공전하는 천체"),
      }),
    /인용/,
  );
  assert.equal(
    resolveShortGrade(question, "틀린 답", {
      audit,
      first: grade("틀린 답", 0, "contradiction"),
    }).status,
    "pending",
    "An unreviewed deduction cannot be confirmed",
  );
});

test("question verification blocks an otherwise correct short question with unrequested scoring requirements", async (t) => {
  const f = await fixture(
    t,
    [{ stem: "합만 쓰시오.", answer: "4", description: "합과 풀이 설명" }],
    (role, input) => {
      assert.equal(role, "verify_question");
      const rubricCheck = alignedAudit(input.question);
      rubricCheck.criteria[0].aligned = false;
      rubricCheck.criteria[0].reason = "풀이 설명을 요구하지 않았습니다.";
      return {
        usable: true,
        evidenceValid: true,
        answerValid: true,
        rubricCheck,
        reason: "정답 자체는 올바름",
      };
    },
  );
  const item = f.exams.get(f.exam.id, true).items[0];
  const job = await f.run("verify_question", { questionId: item.id });
  assert.equal(job.status, "succeeded");
  assert.equal(f.catalog.readQuestion(item.id).status, "needs_review");
});

test("pending user decisions and in-flight manual changes cannot be overwritten by automatic grading", async (t) => {
  let mutate: (() => void) | undefined;
  const f = await fixture(
    t,
    [{ stem: question.stem, answer: "다른 천체를 도는 천체" }],
    (role, input) => {
      if (role === "audit_rubric") return alignedAudit(input.question);
      mutate?.();
      return grade(input.answer);
    },
  );
  mutate = () =>
    f.learning.manual(f.attempt.id, 1, {
      score: null,
      status: "pending",
      passed: false,
      reason: "unknown",
      explanation: "직접 검토 중",
      expectedVersion: 1,
    });
  const job = await f.run();
  assert.equal(job.status, "failed");
  assert.equal(job.error.code, "GRADE_PROTECTED");
  assert.equal(f.learning.latest(f.attempt.id, 1).actor, "user");
  const count = f.calls.length;
  assert.equal((await f.run()).status, "succeeded");
  assert.equal(f.calls.length, count);
  assert.equal(f.learning.latest(f.attempt.id, 1).explanation, "직접 검토 중");
});

test("provider limit during deduction review leaves no score or wrong note and resumes from the saved step", async (t) => {
  let limited = true;
  const f = await fixture(
    t,
    [{ stem: question.stem, answer: "다른 천체를 돌지 않는 천체" }],
    (role, input) => {
      if (role === "audit_rubric") return alignedAudit(input.question);
      if (role === "review_short_answer" && limited)
        throw new Fault(
          429,
          "CODEX_RATE_LIMITED",
          "Codex 요청이 제한되었습니다.",
          {
            providerCode: "responseTooManyFailedAttempts",
            httpStatusCode: 429,
          },
        );
      return grade(input.answer, 0, "contradiction");
    },
  );
  const frozen = JSON.stringify(f.exams.get(f.exam.id, true));
  const job = await f.run();
  assert.equal(job.status, "failed");
  assert.equal(job.error.code, "CODEX_RATE_LIMITED");
  assert.equal(job.error.details.httpStatusCode, 429);
  assert.equal(f.learning.result(f.attempt.id).items[0].assessment.score, null);
  assert.equal(
    f.learning.result(f.attempt.id).items[0].assessment.status,
    "pending",
  );
  assert.equal(f.learning.wrong(f.goal.id).length, 0);
  assert.equal(
    f.store.one(
      "SELECT COUNT(*) n FROM review_events WHERE goal_id=?",
      f.goal.id,
    ).n,
    0,
  );
  limited = false;
  f.jobs.resume(job.id);
  await f.jobs.tick();
  for (
    let i = 0;
    i < 200 && ["queued", "running"].includes(f.jobs.get(job.id).status);
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.jobs.get(job.id).status, "succeeded");
  const assessment = f.learning.result(f.attempt.id).items[0].assessment;
  assert.equal(assessment.status, "confirmed");
  assert.equal(assessment.score, 0);
  assert.equal(f.learning.wrong(f.goal.id).length, 1);
  assert.equal(
    f.store.one(
      "SELECT COUNT(*) n FROM review_events WHERE goal_id=?",
      f.goal.id,
    ).n,
    1,
  );
  assert.equal(JSON.stringify(f.exams.get(f.exam.id, true)), frozen);
  assert.deepEqual(
    f.calls.map((call) => call.role),
    [
      "audit_rubric",
      "grade_answer",
      "review_short_answer",
      "review_short_answer",
    ],
  );
});

test("invalid answer evidence is not checkpointed and can be replaced on resume", async (t) => {
  let invalid = true;
  const f = await fixture(
    t,
    [{ stem: question.stem, answer: "다른 천체 둘레를 도는 천체" }],
    (role, input) => {
      if (role === "audit_rubric") return alignedAudit(input.question);
      return grade(invalid ? "invented quote" : input.answer);
    },
  );
  const job = await f.run();
  assert.equal(job.error.code, "GRADE_EVIDENCE");
  assert.equal(f.learning.latest(f.attempt.id, 1).score, null);
  invalid = false;
  f.jobs.resume(job.id);
  await f.jobs.tick();
  for (
    let i = 0;
    i < 200 && ["queued", "running"].includes(f.jobs.get(job.id).status);
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.jobs.get(job.id).status, "succeeded");
  assert.equal(f.learning.result(f.attempt.id).items[0].assessment.score, 2);
  assert.deepEqual(
    f.calls.map((call) => call.role),
    ["audit_rubric", "grade_answer", "grade_answer"],
  );
});
