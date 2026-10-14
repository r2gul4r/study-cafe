import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/app.js";
import type { AgentPort } from "../src/agent.js";

// Subject data belongs in fixtures, never in the product's routing logic.
const cases = [
  {
    kind: "general",
    title: "밤하늘 이해하기",
    area: "천문",
    concept: "달의 위상",
    fact: "달의 위상은 태양과 지구와 달의 상대 위치에 따라 달라진다.",
  },
  {
    kind: "skill",
    title: "움직이는 피사체 촬영하기",
    area: "사진",
    concept: "셔터 속도",
    fact: "짧은 노출 시간은 움직이는 피사체의 흔들림을 줄인다.",
  },
  {
    kind: "exam",
    title: "자료 해석 평가 준비",
    area: "통계",
    concept: "중앙값",
    fact: "중앙값은 자료를 크기순으로 정렬했을 때 가운데에 놓인 값이다.",
  },
];

for (const sample of cases) {
  test(`${sample.kind}: arbitrary goal through 25 questions, grading, summary and variant across scope changes`, async (t) => {
    let goalId = "",
      scopeId = "",
      conceptId = "",
      segmentId = "";
    const calls: string[] = [];
    const agent: AgentPort = {
      async ask(role, raw, schema) {
        const input = raw as any;
        calls.push(role);
        if (input.goal) {
          assert.equal(input.goal.id, goalId);
          assert.equal(input.goal.title, sample.title);
          assert.equal(input.goal.kind, sample.kind);
          assert.equal(input.goal.level, "처음 시작");
        }
        if (role === "plan_goal")
          return schema.parse({
            scope: {
              title: sample.title,
              concepts: [{ name: sample.concept, area: sample.area }],
            },
            questions: [],
            summary: "범위를 확인해 주세요.",
          });
        if (role === "research_sources") {
          if (sample.kind === "exam")
            assert.match(input.instruction, /Prioritize the confirmed exam/);
          else {
            assert.match(
              input.instruction,
              /Past papers and an exam syllabus are not prerequisites/,
            );
            assert.doesNotMatch(
              input.instruction,
              /Prioritize the confirmed exam/,
            );
          }
          return schema.parse({
            candidates: [],
            uncovered: [sample.concept],
            summary: "등록 자료로 학습",
          });
        }
        if (role === "generate_question" || role === "generate_variant") {
          assert.equal(
            input.goal.scope.id,
            scopeId,
            "Use the original scope even after the user changes it",
          );
          assert.equal(input.goal.scope.concepts[0].name, sample.concept);
          assert.deepEqual(
            input.materials.map((m: any) => m.segmentId),
            [segmentId],
            "Another goal's materials must not leak",
          );
          const variant = role === "generate_variant";
          const type = variant ? input.parent.type : input.slot.type;
          const short = type === "short";
          return schema.parse({
            goalId,
            scopeId,
            type,
            stem: `${sample.concept} ${variant ? "상황을 바꾼 복습" : input.slot.slot}: 근거를 확인하세요.`,
            choices: short
              ? []
              : [
                  { id: "yes", text: sample.fact },
                  { id: "no", text: "근거와 반대인 설명" },
                ],
            answer: short ? [] : ["yes"],
            modelAnswer: short ? sample.fact : null,
            rubric: short
              ? [
                  {
                    id: "fact",
                    description: sample.fact,
                    points: 1,
                    required: true,
                  },
                ]
              : [],
            origin: variant ? "ai_variant" : "ai_generated",
            parentId: variant ? input.parent.id : null,
            ...(variant ? { familyId: input.parent.familyId } : {}),
            conceptIds: [conceptId],
            evidence: [{ segmentId, quote: sample.fact }],
          });
        }
        if (role === "verify_question")
          return schema.parse({
            usable: true,
            evidenceValid: true,
            answerValid: true,
            reason: "모의 근거 검토",
          });
        if (role === "grade_answer") {
          assert.equal(input.question.modelAnswer, sample.fact);
          const passed = input.answer === sample.fact;
          return schema.parse({
            status: "confirmed",
            criteria: [
              {
                id: "fact",
                score: passed ? 1 : 0,
                evidence: input.answer,
                reason: "모의 기준 대조",
              },
            ],
            explanation: "모의 채점",
            reason: "concept",
            passed,
          });
        }
        if (role === "summarize_misconceptions") {
          assert.deepEqual(
            input.concepts.map((c: any) => c.id),
            [conceptId],
            "Historical mistakes keep their concept names after scope changes",
          );
          assert.equal(input.concepts[0].name, sample.concept);
          assert.equal(input.wrong.length, 2);
          assert.ok(input.wrong.every((w: any) => w.goalId === goalId));
          return schema.parse({
            concepts: [
              {
                conceptId,
                summary: sample.fact,
                example: "다른 상황에도 같은 개념을 적용해 보세요.",
                reasonIsInferred: true,
                attemptIds: [input.wrong[0].attemptId],
              },
            ],
          });
        }
        throw new Error(`Unexpected role: ${role}`);
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
      dataDir: mkdtempSync(join(tmpdir(), "study-generic-")),
      agent,
      token: "test",
      autoWorker: false,
    });
    t.after(() => f.app.close());
    const run = async (kind: string, input: any) => {
      const queued = f.jobs.enqueue(kind, input);
      await f.jobs.tick();
      const job = f.jobs.get(queued.id);
      assert.equal(job.status, "succeeded", JSON.stringify(job.error));
      return job.result;
    };
    // Put an unrelated goal's material in the same store before the real goal.
    const other = f.catalog.goal({ title: "무관한 목표" });
    const foreign = f.catalog.source(other.id, {
      title: "다른 자료",
      kind: "user_material",
      rights: "user_provided",
      rightsBasis: "test authored",
    });
    f.sources.commit(
      foreign.id,
      await f.sources.prepare(foreign.id, {
        text: "이 자료는 다른 목표에서만 사용한다.",
      }),
    );

    const goal = f.catalog.goal({
      title: sample.title,
      kind: sample.kind,
      level: "처음 시작",
      description: "근거를 설명하고 상황에 적용하기",
    });
    goalId = goal.id;
    const plan = await run("plan_goal", { goalId });
    assert.equal(
      f.catalog.readGoal(goalId).scope,
      null,
      "A plan remains a draft until accepted",
    );
    const scope = f.catalog.scope(goalId, plan.scope);
    scopeId = scope.id;
    conceptId = scope.concepts[0]!.id!;
    await run("research", { goalId });
    const source = f.catalog.source(goalId, {
      title: sample.title,
      kind: "user_material",
      rights: "user_provided",
      rightsBasis: "test authored",
    });
    f.sources.commit(
      source.id,
      await f.sources.prepare(source.id, { text: sample.fact }),
    );
    segmentId = f.catalog.segments(source.id)[0].id;

    const template = f.exams.template({
      name: "공통 25문항",
      single: 18,
      multiple: 2,
      short: 5,
      policy: "ai_only",
    });
    const exam = f.exams.create(goalId, template.id);
    f.catalog.scope(goalId, {
      title: "다음 학습 단계",
      concepts: [{ name: "새 개념", area: sample.area }],
    });
    await run("prepare_exam", { examId: exam.id });
    const ready = f.exams.get(exam.id, true);
    assert.equal(ready.items.length, 25);
    assert.ok(
      ready.items.every(
        (q: any) => q.scopeId === scopeId && q.conceptIds.includes(conceptId),
      ),
    );
    const attempt = f.exams.start(exam.id);
    for (const item of ready.items) {
      const wrong = item.slot === 1 || item.slot === 25;
      f.exams.saveAnswer(attempt.id, item.slot, {
        value:
          item.type === "short"
            ? wrong
              ? "잘못된 설명"
              : sample.fact
            : [wrong ? "no" : "yes"],
        version: 0,
        flagged: false,
        uncertain: false,
        hintUsed: false,
        recall: null,
      });
    }
    assert.equal(f.learning.submit(attempt.id, "submit").pending, 5);
    const result = await run("grade_attempt", { attemptId: attempt.id });
    assert.equal(result.pending, 0);
    assert.equal(result.finalScore, 23);
    assert.equal(f.learning.wrong(other.id).length, 0);
    const note = await run("summarize_wrong", { goalId });
    assert.equal(note.concepts[0].conceptId, conceptId);
    const original = ready.items[0];
    await run("generate_variant", { questionId: original.id });
    const variants = f.store.all(
      "SELECT data FROM question_revisions WHERE json_extract(data,'$.parentId')=?",
      original.id,
    );
    assert.equal(variants.length, 1);
    assert.equal(JSON.parse(variants[0].data).scopeId, scopeId);
    assert.equal(
      f.store.one(
        "SELECT count(*) n FROM review_states WHERE goal_id=?",
        goalId,
      ).n,
      25,
    );
    assert.equal(
      f.store.one(
        "SELECT count(*) n FROM review_states WHERE goal_id=?",
        other.id,
      ).n,
      0,
    );
    assert.equal(
      calls.filter((role) => role === "generate_question").length,
      25,
    );
  });
}
