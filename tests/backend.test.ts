import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { z } from "zod";
import { createApp } from "../src/app.js";
import { Store } from "../src/store.js";
import { Catalog } from "../src/catalog.js";
import {
  Sources,
  extract,
  publicAddress,
  fetchPublic,
} from "../src/sources.js";
import { Exams } from "../src/exams.js";
import { Learning } from "../src/learning.js";
import { Jobs, Waiting } from "../src/jobs.js";
import { registerWorkflows } from "../src/workflows.js";
import {
  backup,
  restoreBackup,
  verifyBackup,
  lockData,
} from "../src/backup.js";
import { decode, now, questionInput } from "../src/core.js";
import type { AgentPort } from "../src/agent.js";

const temp = () => mkdtempSync(join(tmpdir(), "study-cafe-test-"));
class FakeAgent implements AgentPort {
  fail = false;
  counter = 0;
  calls: string[] = [];
  async ask<T>(role: string, input: any, schema: z.ZodType<T>): Promise<T> {
    this.calls.push(role);
    if (this.fail) throw new Error("simulated offline");
    let output: any;
    if (role === "verify_question")
      output = {
        usable: true,
        evidenceValid: true,
        answerValid: true,
        reason: "독립 검토 fixture",
      };
    else if (role === "generate_question")
      output = {
        goalId: input.goal.id,
        scopeId: input.scopeId,
        type: input.slot.type,
        stem: "Generated " + ++this.counter,
        choices:
          input.slot.type === "short"
            ? []
            : [
                { id: "a", text: "yes" },
                { id: "b", text: "no" },
              ],
        answer: input.slot.type === "short" ? [] : ["a"],
        modelAnswer: input.slot.type === "short" ? "repeat" : null,
        rubric:
          input.slot.type === "short"
            ? [{ id: "r", description: "repeat", points: 1, required: true }]
            : [],
        points: 1,
        origin: "ai_generated",
        conceptIds: [input.slot.conceptId],
        evidence: [
          {
            segmentId: input.materials[0].segmentId,
            quote: "반복문은 반복한다.",
          },
        ],
      };
    else if (role === "grade_answer")
      output = {
        status: "confirmed",
        criteria: input.question.rubric.map((r: any) => ({
          id: r.id,
          score: input.answer.includes("repeat") ? r.points : 0,
          evidence: input.answer.includes("repeat") ? "repeat" : "",
          reason: "fixture comparison",
        })),
        explanation: "fixture grade",
        reason: "unknown",
        passed: input.answer.includes("repeat"),
      };
    else if (role === "generate_variant")
      output = {
        ...input.parent,
        stem: "Variant " + ++this.counter,
        origin: "ai_variant",
        parentId: input.parent.id,
      };
    else if (role === "research_sources")
      output = {
        candidates: [
          {
            title: "Unknown rights",
            url: "https://example.com/paper.pdf",
            publisher: "example",
            kind: "official_practice",
            examEvidence: null,
            reuseEvidence: null,
            answerUrls: [],
          },
        ],
        uncovered: ["audio"],
        summary: "bounded",
      };
    else throw new Error("unsupported fixture role " + role);
    if (role === "generate_variant") {
      for (const k of [
        "id",
        "revisionId",
        "version",
        "status",
        "review",
        "archived",
      ])
        delete output[k];
    }
    return schema.parse(output);
  }
  async status() {
    return { connected: true, authenticated: true };
  }
  async login() {
    return { authUrl: "https://example.com/login" };
  }
  async models() {
    return { data: [] };
  }
  async close() {}
}
async function fixture(t: any, count = 25) {
  const store = new Store(temp());
  t.after(() => store.close());
  const catalog = new Catalog(store),
    sources = new Sources(catalog),
    exams = new Exams(catalog),
    learning = new Learning(exams);
  const goal = catalog.goal({ title: "파이썬 日本語" });
  const scope = catalog.scope(goal.id, {
    title: "기초",
    concepts: [{ name: "반복문", area: "파이썬" }],
  });
  const source = catalog.source(goal.id, {
    title: "자체 작성 자료",
    kind: "user_material",
    rights: "user_provided",
    rightsBasis: "test authored",
  });
  const prepared = await sources.prepare(source.id, {
    text: "반복문은 반복한다. Python loops repeat. 日本語の資料です。",
  });
  sources.commit(source.id, prepared);
  const segment = catalog.segments(source.id)[0];
  const make = (n: number, type = "single", extra: any = {}) => ({
    goalId: goal.id,
    scopeId: scope.id,
    type,
    stem: `문제 ${n} 반복문`,
    choices:
      type === "short"
        ? []
        : [
            { id: "a", text: "반복한다" },
            { id: "b", text: "반복하지 않는다" },
          ],
    answer: type === "short" ? [] : ["a"],
    modelAnswer: type === "short" ? "repeat" : null,
    rubric:
      type === "short"
        ? [{ id: "r", description: "반복 설명", points: 1, required: true }]
        : [],
    points: 1,
    origin: "external_practice",
    conceptIds: [scope.concepts[0]!.id!],
    evidence: [{ segmentId: segment.id, quote: "반복문은 반복한다." }],
    ...extra,
  });
  const questions = [];
  for (let n = 0; n < count; n++) {
    const q = catalog.createQuestion(make(n, n >= 20 ? "short" : "single"));
    questions.push(catalog.review(q.revisionId, "usable", "자체 자료 확인"));
  }
  return {
    store,
    catalog,
    sources,
    exams,
    learning,
    goal,
    scope,
    source,
    segment,
    make,
    questions,
  };
}
async function waitJob(jobs: Jobs, jobId: string) {
  for (let i = 0; i < 200; i++) {
    const job = jobs.get(jobId);
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("job timed out");
}

test("25-question lifecycle preserves snapshots, autosave versions, pending grades and manual correction", async (t) => {
  const f = await fixture(t);
  const template = f.exams.template({ name: "25문항" });
  const exam = f.exams.create(f.goal.id, template.id, "fixed");
  assert.equal(exam.items.length, 25);
  f.exams.finalize(exam.id);
  const attempt = f.exams.start(exam.id);
  assert.equal("answer" in attempt.exam.items[0], false);
  assert.equal("rubric" in attempt.exam.items[24], false);
  for (const item of attempt.exam.items) {
    f.exams.saveAnswer(attempt.id, item.slot, {
      value: item.type === "short" ? "repeat" : ["a"],
      version: 0,
      flagged: false,
      uncertain: false,
      hintUsed: false,
      recall: null,
    });
  }
  assert.throws(
    () =>
      f.exams.saveAnswer(attempt.id, 1, {
        value: ["b"],
        version: 0,
        flagged: false,
        uncertain: false,
        hintUsed: false,
        recall: null,
      }),
    /다른 탭/,
  );
  const old = f.catalog.readQuestion(f.questions[0].id);
  f.catalog.createQuestion(
    { ...f.make(0), answer: ["b"] },
    { questionId: old.id },
  );
  const result = f.learning.submit(attempt.id, "submit");
  assert.equal(result.earned, 20);
  assert.equal(result.pending, 5);
  assert.equal(result.finalScore, null);
  assert.equal(f.learning.submit(attempt.id, "submit").earned, 20);
  assert.throws(() => f.learning.submit(attempt.id, "other"), /다른 요청/);
  for (const item of result.items.filter((i: any) => i.type === "short"))
    f.learning.aiGrade(
      attempt.id,
      item.slot,
      {
        status: "confirmed",
        criteria: [{ id: "r", score: 1, evidence: "repeat", reason: "충족" }],
        explanation: "충족",
        reason: "unknown",
        passed: true,
      },
      1,
    );
  assert.equal(f.learning.result(attempt.id).finalScore, 25);
  const events = f.store.one("SELECT COUNT(*) n FROM review_events").n;
  f.learning.manual(attempt.id, 1, {
    score: 0,
    passed: false,
    status: "confirmed",
    reason: "correction",
    explanation: "수동 확인",
    expectedVersion: 1,
  });
  assert.equal(f.learning.result(attempt.id).finalScore, 24);
  assert.equal(f.store.one("SELECT COUNT(*) n FROM review_events").n, events);
  assert.equal(
    f.store.all(
      "SELECT * FROM assessments WHERE attempt_id=? AND slot=1",
      attempt.id,
    ).length,
    2,
  );
  assert.equal(f.learning.wrong(f.goal.id).length, 1);
});
test("past-only shortage is explicit and never silently filled", async (t) => {
  const f = await fixture(t, 17);
  f.store.run(
    "UPDATE sources SET data=? WHERE id=?",
    JSON.stringify({
      ...decode<any>(f.store.get("sources", f.source.id).data),
      kind: "past_exam",
      examEvidence: "synthetic test evidence",
    }),
    f.source.id,
  );
  for (let i = 0; i < 17; i++) {
    const q = f.catalog.createQuestion(
      {
        ...f.make(i),
        origin: "past_exam",
        pastExamEvidence: "synthetic test evidence",
      },
      { questionId: f.questions[i].id },
    );
    f.catalog.review(q.revisionId, "usable", "synthetic past-paper fixture");
  }
  const template = f.exams.template({
    name: "기출",
    total: 25,
    single: 25,
    short: 0,
    policy: "past_only",
  });
  const exam = f.exams.create(f.goal.id, template.id);
  assert.equal(exam.items.length, 17);
  assert.throws(() => f.exams.finalize(exam.id), /부족/);
  const jobs = new Jobs(f.store);
  t.after(() => jobs.close());
  registerWorkflows(
    jobs,
    f.catalog,
    f.sources,
    f.exams,
    f.learning,
    new FakeAgent(),
  );
  const job = jobs.enqueue("prepare_exam", { examId: exam.id });
  const result = await waitJob(jobs, job.id);
  assert.equal(result.status, "waiting_user");
  assert.equal(result.error.details.missing, 8);
  assert.equal(f.exams.get(exam.id).status, "preparing");
});
test("a wrong answer in the latest attempt keeps its concept weak even when a later slot is correct", async (t) => {
  const f = await fixture(t, 2);
  const template = f.exams.template({
    name: "mixed outcome",
    total: 2,
    single: 2,
    short: 0,
  });
  const exam = f.exams.create(f.goal.id, template.id);
  f.exams.finalize(exam.id);
  const attempt = f.exams.start(exam.id);
  for (const slot of [1, 2])
    f.exams.saveAnswer(attempt.id, slot, {
      value: [slot === 1 ? "b" : "a"],
      version: 0,
      flagged: false,
      uncertain: false,
      hintUsed: false,
      recall: null,
    });
  f.learning.submit(attempt.id, "mixed");
  const progress = f.learning.progress(f.goal.id)[0];
  assert.equal(progress.status, "review_needed");
  assert.equal(progress.lastEvidence.passed, false);
  assert.equal(progress.independentSuccessDays, 0);
});
test("fixture agent generation fills exactly 25 typed slots through the contract", async (t) => {
  const f = await fixture(t, 0);
  const jobs = new Jobs(f.store);
  t.after(() => jobs.close());
  const agent = new FakeAgent();
  registerWorkflows(jobs, f.catalog, f.sources, f.exams, f.learning, agent);
  const template = f.exams.template({ name: "AI", policy: "ai_only" });
  const exam = f.exams.create(f.goal.id, template.id);
  const job = jobs.enqueue("prepare_exam", { examId: exam.id });
  const result = await waitJob(jobs, job.id);
  assert.equal(result.status, "succeeded", JSON.stringify(result.error));
  const ready = f.exams.get(exam.id);
  assert.equal(ready.status, "ready");
  assert.equal(ready.items.filter((q: any) => q.type === "single").length, 20);
  assert.equal(ready.items.filter((q: any) => q.type === "short").length, 5);
  assert.equal(agent.calls.filter((x) => x === "verify_question").length, 25);
});
test("generation retries receive validation feedback and only current source revisions", async (t) => {
  const f = await fixture(t, 0);
  f.sources.commit(
    f.source.id,
    await f.sources.prepare(f.source.id, {
      text: "새 자료. 반복문은 반복한다.",
    }),
  );
  const agent = new FakeAgent();
  const ask = agent.ask.bind(agent);
  const inputs: any[] = [];
  agent.ask = async (role, input: any, schema) => {
    if (role === "generate_question") {
      inputs.push(input);
      if (inputs.length === 1)
        throw new Error("fixture invalid written rubric");
    }
    return ask(role, input, schema);
  };
  const jobs = new Jobs(f.store);
  t.after(() => jobs.close());
  registerWorkflows(jobs, f.catalog, f.sources, f.exams, f.learning, agent);
  const template = f.exams.template({
    name: "retry",
    total: 1,
    single: 0,
    short: 1,
    policy: "ai_only",
  });
  const exam = f.exams.create(f.goal.id, template.id);
  const result = await waitJob(
    jobs,
    jobs.enqueue("prepare_exam", { examId: exam.id }).id,
  );
  assert.equal(result.status, "succeeded", JSON.stringify(result.error));
  assert.equal(inputs.length, 2);
  assert.equal(inputs[1].previousFailure, "fixture invalid written rubric");
  assert.equal(inputs[1].materials.length, 1);
  assert.match(inputs[1].materials[0].text, /새 자료/);
});
test("same question can be imported under a new scope without silently reusing the old scope", async (t) => {
  const f = await fixture(t, 1);
  const scope = f.catalog.scope(f.goal.id, {
    title: "개정 범위",
    concepts: [{ name: "반복문", area: "파이썬" }],
  });
  const question = f.catalog.createQuestion({
    ...f.make(0),
    scopeId: scope.id,
    conceptIds: [scope.concepts[0]!.id!],
  });
  assert.notEqual(question.id, f.questions[0].id);
  assert.equal(question.scopeId, scope.id);
  const multiple = f.catalog.createQuestion({ ...f.make(0), type: "multiple" });
  assert.notEqual(multiple.id, f.questions[0].id);
});
test("grading outage remains pending, not zero or half credit", async (t) => {
  const f = await fixture(t, 0);
  const q = f.catalog.createQuestion(f.make(100, "short"));
  f.catalog.review(q.revisionId, "usable", "test");
  const template = f.exams.template({
    name: "short",
    total: 1,
    single: 0,
    short: 1,
  });
  const e = f.exams.create(f.goal.id, template.id);
  f.exams.finalize(e.id);
  const a = f.exams.start(e.id);
  f.exams.saveAnswer(a.id, 1, {
    value: "repeat",
    version: 0,
    flagged: false,
    uncertain: false,
    hintUsed: false,
    recall: null,
  });
  f.learning.submit(a.id, "x");
  const jobs = new Jobs(f.store);
  t.after(() => jobs.close());
  const agent = new FakeAgent();
  agent.fail = true;
  registerWorkflows(jobs, f.catalog, f.sources, f.exams, f.learning, agent);
  const job = jobs.enqueue("grade_attempt", { attemptId: a.id });
  assert.equal((await waitJob(jobs, job.id)).status, "failed");
  assert.equal(f.learning.result(a.id).finalScore, null);
  assert.equal(f.learning.result(a.id).confirmedPossible, 0);
  agent.fail = false;
  jobs.resume(job.id);
  assert.equal((await waitJob(jobs, job.id)).status, "succeeded");
  assert.equal(f.learning.result(a.id).finalScore, 1);
});
test("duplicate material/question detection and exact evidence validation", async (t) => {
  const f = await fixture(t, 1);
  assert.equal(f.catalog.createQuestion(f.make(0)).duplicate, true);
  assert.throws(
    () =>
      f.catalog.createQuestion(
        f.make(2, "single", {
          evidence: [{ segmentId: f.segment.id, quote: "invented quote" }],
        }),
      ),
    /원문/,
  );
  const same = await f.sources.prepare(f.source.id, {
    text: "반복문은 반복한다. Python loops repeat. 日本語の資料です。",
  });
  assert.equal(f.sources.commit(f.source.id, same).duplicate, true);
  assert.equal(f.catalog.listQuestions(f.goal.id, { q: "반복문" }).total, 1);
  assert.throws(
    () =>
      f.catalog.createQuestion(f.make(2, "single", { origin: "past_exam" })),
    /기출/,
  );
});
test("scope version and foreign-goal evidence cannot leak into an exam", async (t) => {
  const f = await fixture(t, 1);
  const g = f.catalog.goal({ title: "다른 목표" });
  const sc = f.catalog.scope(g.id, {
    title: "다른 범위",
    concepts: [{ name: "x", area: "y" }],
  });
  assert.throws(
    () =>
      f.catalog.createQuestion({
        ...f.make(2),
        goalId: g.id,
        scopeId: sc.id,
        conceptIds: [sc.concepts[0]!.id!],
      }),
    /다른 목표/,
  );
  f.catalog.scope(f.goal.id, {
    title: "새 범위",
    concepts: [{ name: "함수", area: "Python" }],
  });
  const template = f.exams.template({
    name: "new",
    total: 1,
    single: 1,
    short: 0,
  });
  assert.equal(f.exams.create(f.goal.id, template.id).items.length, 0);
});
test("passage groups are selected atomically", async (t) => {
  const f = await fixture(t, 0);
  for (let n = 0; n < 2; n++) {
    const q = f.catalog.createQuestion(
      f.make(n, "single", { groupId: "passage-1", passage: "Shared passage" }),
    );
    f.catalog.review(q.revisionId, "usable", "test");
  }
  const t1 = f.exams.template({ name: "one", total: 1, single: 1, short: 0 });
  assert.equal(f.exams.create(f.goal.id, t1.id).items.length, 0);
  const t2 = f.exams.template({ name: "two", total: 2, single: 2, short: 0 });
  assert.equal(f.exams.create(f.goal.id, t2.id).items.length, 2);
});
test("rubrics without required criteria need all criteria satisfied to pass", async (t) => {
  const f = await fixture(t, 0);
  const q = f.catalog.createQuestion(f.make(1, "short", {
    rubric: [{ id: "r", description: "반복 설명", points: 1, required: false }],
  }));
  f.catalog.review(q.revisionId, "usable", "test");
  const template = f.exams.template({ name: "short", total: 1, single: 0, short: 1 });
  const exam = f.exams.create(f.goal.id, template.id);
  f.exams.finalize(exam.id);
  for (const correct of [false, true]) {
    const attempt = f.exams.start(exam.id);
    const slot = attempt.exam.items[0].slot;
    f.exams.saveAnswer(attempt.id, slot, {
      value: correct ? "repeat" : "unknown", version: 0,
      flagged: false, uncertain: false, hintUsed: false, recall: null,
    });
    f.learning.submit(attempt.id, `submit-${correct}`);
    const grade = {
      status: "confirmed", passed: correct,
      criteria: [{ id: "r", score: correct ? 1 : 0, evidence: correct ? "repeat" : "", reason: "test" }],
      explanation: "test", reason: "concept",
    };
    assert.throws(() => f.learning.aiGrade(attempt.id, slot, { ...grade, passed: !correct }, 1), /통과 판정/);
    const result = f.learning.aiGrade(attempt.id, slot, grade, 1);
    assert.equal(result.passed, correct);
    assert.equal(result.score, correct ? 1 : 0);
  }
});

test("question and rubric validation rejects broken counts and references", async (t) => {
  const f = await fixture(t, 0);
  assert.throws(() =>
    f.exams.template({ name: "bad", total: 25, single: 25, short: 5 }),
  );
  assert.throws(() =>
    f.catalog.createQuestion(f.make(1, "single", { answer: ["missing"] })),
  );
  assert.throws(() =>
    f.catalog.createQuestion(f.make(1, "short", { points: 4 })),
  );
});
test("timed expiry uses last saved answers and practice pause preserves remaining time", async (t) => {
  const f = await fixture(t, 1);
  f.catalog.scope(f.goal.id, {
    title: "official",
    concepts: [
      { id: f.scope.concepts[0]!.id!, name: "반복문", area: "파이썬" },
    ],
    examFormat: {
      total: 1,
      minutes: 1,
      evidenceUrl: "https://example.com/format",
    },
  });
  const q = f.catalog.createQuestion({
    ...f.make(3),
    scopeId: f.catalog.latestScope(f.goal.id).id,
  });
  f.catalog.review(q.revisionId, "usable", "test");
  const mock = f.exams.template({
    name: "mock",
    total: 1,
    single: 1,
    short: 0,
    mode: "mock",
    minutes: 1,
  });
  const exam = f.exams.create(f.goal.id, mock.id);
  f.exams.finalize(exam.id);
  const a = f.exams.start(exam.id);
  assert.throws(() => f.exams.pause(a.id), /실전/);
  f.store.run(
    "UPDATE attempts SET deadline=? WHERE id=?",
    "2000-01-01T00:00:00.000Z",
    a.id,
  );
  assert.deepEqual(f.learning.expire(), [a.id]);
  assert.equal(f.learning.result(a.id).finalScore, 0);
  const practice = f.exams.template({
    name: "p",
    total: 1,
    single: 1,
    short: 0,
    minutes: 5,
  });
  const e2 = f.exams.create(f.goal.id, practice.id);
  f.exams.finalize(e2.id);
  const a2 = f.exams.start(e2.id);
  assert.equal(f.exams.pause(a2.id).status, "paused");
  assert.equal(f.exams.pause(a2.id, true).status, "active");
});
test("hint and same-family same-day attempts do not inflate recall success", async (t) => {
  const f = await fixture(t, 1);
  const template = f.exams.template({
    name: "one",
    total: 1,
    single: 1,
    short: 0,
  });
  const e = f.exams.create(f.goal.id, template.id);
  f.exams.finalize(e.id);
  for (let i = 0; i < 3; i++) {
    const a = f.exams.start(e.id);
    f.exams.saveAnswer(a.id, 1, {
      value: ["a"],
      version: 0,
      flagged: false,
      uncertain: false,
      hintUsed: i === 0,
      recall: "easy",
    });
    f.learning.submit(a.id, "s" + i);
  }
  const ev = f.store
    .all("SELECT data FROM review_events ORDER BY occurred_at")
    .map((r) => decode(r.data));
  assert.equal(ev.filter((x) => x.affectsSchedule).length, 1);
  assert.equal(ev.filter((x) => x.excluded === "hint_used").length, 1);
  assert.equal(f.learning.progress(f.goal.id)[0].independentSuccessDays, 1);
});
test("job checkpoints resume without duplicating committed steps; cancellation fences late results", async (t) => {
  const s = new Store(temp());
  t.after(() => s.close());
  const jobs = new Jobs(s);
  t.after(() => jobs.close());
  let fail = true,
    calls = 0;
  jobs.handlers.set("trial", async (_input, ctx) => {
    await ctx.step("a", async () => ++calls);
    if (fail) throw new Error("interrupted");
    return ctx.step("b", async () => ++calls);
  });
  const job = jobs.enqueue("trial", {}, "one");
  assert.equal(jobs.enqueue("trial", {}, "one").id, job.id);
  assert.throws(
    () => jobs.enqueue("trial", { different: true }, "one"),
    /같은 요청/,
  );
  assert.equal((await waitJob(jobs, job.id)).status, "failed");
  fail = false;
  jobs.resume(job.id);
  assert.equal((await waitJob(jobs, job.id)).status, "succeeded");
  assert.equal(calls, 2);
  let unblock: () => void = () => {};
  jobs.handlers.set("late", async (_i, ctx) =>
    ctx.step(
      "late",
      () =>
        new Promise<number>((r) => {
          unblock = () => r(99);
        }),
    ),
  );
  const late = jobs.enqueue("late", {});
  while (jobs.get(late.id).status !== "running")
    await new Promise((r) => setTimeout(r, 10));
  jobs.cancel(late.id);
  unblock();
  while (jobs.running) await new Promise((r) => setTimeout(r, 10));
  assert.equal(jobs.get(late.id).status, "cancelled");
  assert.equal(
    s.one("SELECT * FROM job_steps WHERE job_id=?", late.id),
    undefined,
  );
  assert.ok(jobs.events(late.id).length >= 3);
});
test("jobs recovered after process restart start at durable checkpoints", async (t) => {
  const s = new Store(temp());
  t.after(() => s.close());
  s.run(
    "INSERT INTO jobs(id,kind,input,status,generation,created_at,updated_at) VALUES('j','resume','{}','running',1,?,?)",
    now(),
    now(),
  );
  s.run("INSERT INTO job_steps VALUES('j','a','7')");
  const jobs = new Jobs(s);
  t.after(() => jobs.close());
  jobs.handlers.set("resume", async (_i, ctx) =>
    ctx.step("a", async () => {
      throw new Error("must not rerun");
    }),
  );
  assert.equal(jobs.get("j").status, "queued");
  jobs.kick();
  assert.equal((await waitJob(jobs, "j")).result, 7);
});
test("backup validates hashes, restores records and refuses a live data directory", async (t) => {
  const f = await fixture(t, 1);
  const manifest = backup(f.store);
  const dir = join(f.store.dir, "backups", manifest.id);
  assert.equal(verifyBackup(dir).id, manifest.id);
  const target = temp();
  restoreBackup(dir, target);
  const restored = new Store(target);
  try {
    assert.equal(
      new Catalog(restored).readQuestion(f.questions[0].id).stem,
      f.questions[0].stem,
    );
  } finally {
    restored.close();
  }
  const unlock = lockData(target);
  assert.throws(() => restoreBackup(dir, target), /먼저 종료/);
  unlock();
  writeFileSync(join(dir, "study-cafe.db"), Buffer.from("corrupt"));
  assert.throws(() => verifyBackup(dir), /해시/);
});
test("HTTP auth, origin, host, contract validation and OpenAPI work without frontend", async (t) => {
  const service = await createApp({
    dataDir: temp(),
    agent: new FakeAgent(),
    token: "test-token",
    autoWorker: false,
    allowedOrigins: ["http://localhost:5173"],
  });
  t.after(() => service.app.close());
  const request = (
    method: any,
    url: string,
    payload?: any,
    headers: any = {},
  ) =>
    service.app.inject({
      method,
      url,
      payload,
      headers: { authorization: "Bearer test-token", ...headers },
    });
  assert.equal((await service.app.inject("/api/goals")).statusCode, 401);
  assert.equal((await service.app.inject("/health")).statusCode, 200);
  assert.equal(
    (
      await request("GET", "/api/goals", undefined, {
        origin: "https://evil.example",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await request("GET", "/api/goals", undefined, { host: "evil.example" }))
      .statusCode,
    403,
  );
  const created = await request("POST", "/api/goals", { title: "API goal" });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(
    (await request("POST", "/api/goals", { title: "" })).statusCode,
    400,
  );
  const spec = (await request("GET", "/api/openapi.json")).json();
  assert.equal(spec.openapi, "3.1.0");
  assert.ok(Object.keys(spec.paths).length >= 40);
  assert.equal((await request("GET", "/api/settings")).json().frontend, false);
  assert.equal(
    (
      await request("OPTIONS", "/api/goals", undefined, {
        origin: "http://localhost:5173",
      })
    ).statusCode,
    204,
  );
});
test("stored goals, exams and answer revisions survive database reopen", async (t) => {
  const f = await fixture(t, 1);
  const template = f.exams.template({
    name: "persist",
    total: 1,
    single: 1,
    short: 0,
  });
  const e = f.exams.create(f.goal.id, template.id);
  f.exams.finalize(e.id);
  const a = f.exams.start(e.id);
  f.exams.saveAnswer(a.id, 1, {
    value: ["b"],
    version: 0,
    flagged: true,
    uncertain: true,
    hintUsed: false,
    recall: null,
  });
  const second = new Store(f.store.dir);
  try {
    const restored = new Exams(new Catalog(second)).attempt(a.id);
    assert.equal(restored.answers[0].version, 1);
    assert.deepEqual(restored.answers[0].value, ["b"]);
    assert.equal(restored.exam.items.length, 1);
  } finally {
    second.close();
  }
});
test("public fetch blocks IPv4, IPv6, mapped internal hosts and unsupported schemes", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "0.0.0.0",
  ])
    assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress("1.1.1.1"), true);
  await assert.rejects(() => fetchPublic("http://127.0.0.1/"), /내부 주소/);
  await assert.rejects(() => fetchPublic("file:///etc/passwd"), /URL/);
});
test("HTML extraction removes active content and preserves links; text PDF retains page locators", async () => {
  const html = await extract(
    Buffer.from(
      '<html><head><title>Study</title></head><body><nav>menu</nav><main><p>반복문 설명</p><script>alert(1)</script><a href="answers.pdf">정답</a></main></body></html>',
    ),
    "text/html",
    "https://example.com/",
  );
  assert.ok(html.pages[0]!.text.includes("반복문"));
  assert.ok(!html.pages[0]!.text.includes("alert"));
  assert.deepEqual(html.links, ["https://example.com/answers.pdf"]);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText("Question 1: loops repeat.", { font });
  const pdf = await extract(await doc.save(), "application/pdf");
  assert.equal(pdf.pages[0]!.locator.pdfPage, 1);
  assert.match(pdf.pages[0]!.text, /loops repeat/);
  const scan = await PDFDocument.create();
  scan.addPage();
  const blankPdf = await scan.save();
  await assert.rejects(() => extract(blankPdf, "application/pdf"), /OCR/);
});
test("research records link-only sources and uncovered scope without pretending acquisition", async (t) => {
  const f = await fixture(t, 0);
  const jobs = new Jobs(f.store);
  t.after(() => jobs.close());
  registerWorkflows(
    jobs,
    f.catalog,
    f.sources,
    f.exams,
    f.learning,
    new FakeAgent(),
  );
  const job = jobs.enqueue("research", { goalId: f.goal.id });
  const result = await waitJob(jobs, job.id);
  assert.equal(result.status, "succeeded");
  assert.equal(result.result.outcomes[0].status, "link_only");
  assert.deepEqual(result.result.uncovered, ["audio"]);
});

test("corrected answer keys regrade old attempts once and preserve the frozen exam", async (t) => {
  const f = await fixture(t, 1);
  const template = f.exams.template({
    name: "correction",
    total: 1,
    single: 1,
    short: 0,
  });
  const exam = f.exams.create(f.goal.id, template.id);
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
  f.learning.submit(attempt.id, "submit");
  assert.equal(f.learning.result(attempt.id).finalScore, 0);
  const corrected = f.catalog.createQuestion(
    { ...f.make(0), answer: ["b"] },
    { questionId: f.questions[0].id },
  );
  f.catalog.review(corrected.revisionId, "usable", "정답표 정정 확인");
  const result = f.learning.regradeQuestion(
    corrected.id,
    corrected.revisionId,
    "정답표 오류 수정",
  );
  assert.equal(result.affected.length, 1);
  assert.equal(f.learning.result(attempt.id).finalScore, 1);
  assert.deepEqual(f.exams.get(exam.id, true).items[0].answer, ["a"]);
  assert.equal(
    f.learning.regradeQuestion(corrected.id, corrected.revisionId, "again")
      .affected.length,
    0,
  );
  assert.equal(f.store.one("SELECT COUNT(*) n FROM review_events").n, 1);
});
test("research acquires an allowed paper and answer sheet, extracts and reviews grounded questions", async (t) => {
  const f = await fixture(t, 0);
  const license =
    "These test materials may be copied and reused for any purpose.";
  const downloaded: string[] = [];
  const fetcher: typeof fetchPublic = async (url) => {
    downloaded.push(url);
    const content = url.endsWith("/license")
      ? license.replace("may be", "may\n  be")
      : url.endsWith("/answers")
        ? "1번 정답 a. 반복문은 반복한다."
        : "1번 반복문은 무엇인가? a 반복한다 b 반복하지 않는다. 2번은 정답표가 없다.";
    return {
      url,
      bytes: Buffer.from(`<main>${content}</main>`),
      mime: "text/html",
    };
  };
  const sources = new Sources(f.catalog, fetcher);
  const agent = new FakeAgent(),
    ask = agent.ask.bind(agent);
  agent.ask = async (role, input: any, schema) => {
    if (role === "research_sources")
      return schema.parse({
        candidates: [
          {
            title: "Test paper",
            url: "https://example.com/paper",
            publisher: "Fixture",
            kind: "official_practice",
            examEvidence: null,
            reuseEvidence: {
              quote: license,
              url: "https://example.com/license",
            },
            answerUrls: ["https://example.com/answers"],
          },
        ],
        uncovered: [],
        summary: "Fixture research",
      });
    if (role === "extract_existing_questions") {
      assert.equal(input.answerSegments.length, 1);
      return schema.parse({
        questions: [
          {
            ...f.make(99),
            stem: "1번 반복문은 무엇인가?",
            origin: "official_practice",
            evidence: [
              {
                segmentId: input.segments[0].segmentId,
                quote: "1번 반복문은 무엇인가?",
              },
              { segmentId: input.answerSegments[0].id, quote: "1번 정답 a." },
            ],
          },
        ],
        unresolved: [{ reference: "2번", reason: "정답표 없음" }],
      });
    }
    return ask(role, input, schema);
  };
  const jobs = new Jobs(f.store);
  t.after(() => jobs.close());
  registerWorkflows(jobs, f.catalog, sources, f.exams, f.learning, agent);
  const result = await waitJob(
    jobs,
    jobs.enqueue("research", { goalId: f.goal.id }).id,
  );
  assert.equal(result.status, "succeeded", JSON.stringify(result.error));
  assert.equal(
    result.result.extracted[0].count,
    1,
    JSON.stringify(result.result),
  );
  assert.equal(result.result.extracted[0].unresolved[0].reference, "2번");
  const question = f.catalog.readQuestion(
    result.result.extracted[0].questionIds[0],
  );
  assert.equal(question.status, "usable");
  assert.equal(question.evidence.length, 2);
  assert.deepEqual(downloaded, [
    "https://example.com/license",
    "https://example.com/paper",
    "https://example.com/answers",
  ]);
});
test("variants preserve the parent family and identical output cannot masquerade as a variant", async (t) => {
  const f = await fixture(t, 1),
    agent = new FakeAgent(),
    jobs = new Jobs(f.store);
  t.after(() => jobs.close());
  registerWorkflows(jobs, f.catalog, f.sources, f.exams, f.learning, agent);
  const result = await waitJob(
    jobs,
    jobs.enqueue("generate_variant", { questionId: f.questions[0].id }).id,
  );
  assert.equal(result.status, "succeeded", JSON.stringify(result.error));
  assert.equal(result.result.origin, "ai_variant");
  assert.equal(result.result.parentId, f.questions[0].id);
  assert.equal(result.result.familyId, f.questions[0].familyId);
  const ask = agent.ask.bind(agent);
  agent.ask = async (role, input: any, schema) => {
    if (role === "generate_variant")
      return schema.parse({
        ...f.make(0),
        origin: "ai_variant",
        parentId: f.questions[0].id,
      });
    return ask(role, input, schema);
  };
  const unchanged = await waitJob(
    jobs,
    jobs.enqueue("generate_variant", { questionId: f.questions[0].id }).id,
  );
  assert.equal(unchanged.status, "failed");
  assert.equal(unchanged.error.code, "VARIANT_UNCHANGED");
});
test("graceful shutdown leaves interrupted work queued with its committed checkpoint", async (t) => {
  const f = await fixture(t, 0);
  const jobs = new Jobs(f.store);
  let started = false;
  jobs.handlers.set("shutdown", async (_input, ctx) => {
    await ctx.step("saved", async () => 42);
    started = true;
    await new Promise<void>((resolve) =>
      ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    ctx.signal.throwIfAborted();
  });
  const job = jobs.enqueue("shutdown", {});
  for (let i = 0; i < 100 && !started; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(started, true);
  await jobs.close();
  assert.equal(jobs.get(job.id).status, "queued");
  const resumed = new Jobs(f.store);
  t.after(() => resumed.close());
  resumed.handlers.set("shutdown", async (_input, ctx) =>
    ctx.step("saved", async () => {
      throw new Error("must reuse checkpoint");
    }),
  );
  resumed.kick();
  const result = await waitJob(resumed, job.id);
  assert.equal(result.status, "succeeded");
  assert.equal(result.result, 42);
});

test("HTTP contract drives the full 25-question submit and grading workflow", async (t) => {
  const f = await fixture(t);
  const service = await createApp({
    dataDir: f.store.dir,
    agent: new FakeAgent(),
    token: "http-flow",
    autoWorker: false,
    lock: false,
  });
  t.after(() => service.app.close());
  const request = async (method: any, url: string, payload?: any) => {
    const response = await service.app.inject({
      method,
      url,
      payload,
      headers: { authorization: "Bearer http-flow" },
    });
    assert.ok(response.statusCode < 300, response.body);
    return response.json();
  };
  const template = await request("POST", "/api/exam-templates", {
    name: "HTTP 25",
  });
  const exam = await request("POST", "/api/exams", {
    goalId: f.goal.id,
    templateId: template.id,
  });
  await request("POST", `/api/exams/${exam.id}/finalize`, {});
  const attempt = await request("POST", `/api/exams/${exam.id}/attempts`, {});
  for (const item of attempt.exam.items)
    await request("PUT", `/api/attempts/${attempt.id}/answers/${item.slot}`, {
      value: item.type === "short" ? "repeat" : ["a"],
      version: 0,
    });
  const submitted = await request(
    "POST",
    `/api/attempts/${attempt.id}/submit`,
    { requestId: "http-submit" },
  );
  assert.equal(submitted.pending, 5);
  assert.equal(
    (await waitJob(service.jobs, submitted.gradingJobId)).status,
    "succeeded",
  );
  const result = await request("GET", `/api/attempts/${attempt.id}/result`);
  assert.equal(result.finalScore, 25);
  const home = await request("GET", "/api/home");
  assert.equal(home.continueAttempts.length, 0);
  assert.equal(home.goals[0].progress[0].independentSuccessDays, 1);
  const manifest = await request("POST", "/api/backups", {});
  assert.equal(
    (await request("POST", `/api/backups/${manifest.id}/verify`, {})).id,
    manifest.id,
  );
});

test("SSE resumes from Last-Event-ID with committed events", async (t) => {
  const service = await createApp({
    dataDir: temp(),
    agent: new FakeAgent(),
    token: "sse-token",
    autoWorker: false,
  });
  t.after(() => service.app.close());
  service.jobs.handlers.set("events", async (_input, ctx) => {
    ctx.event({ phase: "first" });
    ctx.event({ phase: "second" });
    return { ok: true };
  });
  const job = service.jobs.enqueue("events", {});
  await waitJob(service.jobs, job.id);
  const history = service.jobs.events(job.id);
  const cursor = history[1]!.id;
  const address = await service.app.listen({ host: "127.0.0.1", port: 0 });
  const abort = new AbortController();
  const response = await fetch(`${address}/api/jobs/${job.id}/stream`, {
    headers: {
      authorization: "Bearer sse-token",
      "Last-Event-ID": String(cursor),
    },
    signal: abort.signal,
  });
  assert.equal(response.status, 200);
  const first = await response.body!.getReader().read();
  const eventText = new TextDecoder().decode(first.value);
  abort.abort();
  assert.match(eventText, /event: progress/);
  assert.ok(!eventText.includes(`id: ${cursor}\n`));
  assert.ok(eventText.includes(`id: ${history[2]!.id}\n`));
});
