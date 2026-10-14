import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/app.js";
import { questionInput } from "../src/core.js";
import {
  latestMaterials,
  selectMaterials,
  validateExtraction,
  type Material,
} from "../src/materials.js";
import type { AgentPort } from "../src/agent.js";
import { revisionInput } from "../apps/web/src/question-input.js";

const agentWith = (ask: AgentPort["ask"]): AgentPort => ({
  ask,
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
});
const material = (
  segmentId: string,
  text: string,
  sourceId = segmentId,
): Material => ({
  segmentId,
  text,
  sourceId,
  revisionId: sourceId,
  title: "자료",
  kind: "user_material",
  url: null,
  locator: {},
});

test("retrieval finds late concept evidence, bounds whole segments and uses a source-diverse synonym fallback", () => {
  const pool = Array.from({ length: 60 }, (_, i) =>
    material(`n${i}`, "무관한 내용".repeat(100), "noise"),
  );
  pool.push(
    material("moon", "달의 위상은 관측 위치에 따라 달라집니다."),
    material("photo", "셔터 속도와 노출 시간의 관계."),
  );
  assert.deepEqual(
    selectMaterials(pool, "달의 위상").map((m) => m.segmentId),
    ["moon"],
  );
  assert.deepEqual(
    selectMaterials(pool, "셔터 속도").map((m) => m.segmentId),
    ["photo"],
  );
  assert.deepEqual(selectMaterials(pool, "다른 표현"), []);
  const fallback = selectMaterials(pool, "다른 표현", {
    allowFallback: true,
    maxSegments: 3,
  });
  assert.deepEqual(
    fallback.map((m) => m.sourceId),
    ["noise", "moon", "photo"],
  );
  const budget = selectMaterials(pool, "무관한", { maxChars: 1200 });
  assert.equal(budget.length, 2);
  assert.equal(
    budget[0]!.text,
    pool[0]!.text,
    "Never truncate source evidence",
  );
});

const body = material(
  "q",
  "2026 연습판. 1번 중앙값은? a 가운데 값 b 최댓값.",
  "paper",
);
const answer = material("a", "2026 연습판. 1번 정답 a.", "answers");
const questionQuote = { segmentId: "q", quote: "1번 중앙값은?" };
const answerQuote = { segmentId: "a", quote: "1번 정답 a." };
const editions = [
  { segmentId: "q", quote: "2026 연습판" },
  { segmentId: "a", quote: "2026 연습판" },
];
const extracted = () =>
  questionInput.parse({
    goalId: "goal",
    scopeId: "scope",
    type: "single",
    stem: "1번 중앙값은?",
    choices: [
      { id: "a", text: "가운데 값" },
      { id: "b", text: "최댓값" },
    ],
    answer: ["a"],
    origin: "official_practice",
    conceptIds: ["concept"],
    evidence: [questionQuote, answerQuote, ...editions],
    sourceMatch: {
      questionReference: "1번",
      answerReference: "1번",
      questionEvidence: questionQuote,
      answerEvidence: answerQuote,
      edition: "2026 연습판",
      editionEvidence: editions,
    },
  });

test("extraction requires exact wording, supplied evidence, matching numbers and both edition citations", () => {
  const source = { kind: "official_practice" };
  assert.doesNotThrow(() =>
    validateExtraction(extracted(), source, [body], [answer]),
  );
  const split = body.text.indexOf("가운데") + 1;
  const left = {
    ...body,
    text: body.text.slice(0, split),
    locator: { charStart: 0, charEnd: split },
  };
  const right = {
    ...body,
    segmentId: "q-next",
    text: body.text.slice(split),
    locator: { charStart: split, charEnd: body.text.length },
  };
  assert.doesNotThrow(
    () => validateExtraction(extracted(), source, [left, right], [answer]),
    "Rejoin adjacent stored chunks without splitting a word",
  );
  const mutations: [string, (q: ReturnType<typeof extracted>) => void][] = [
    [
      "SOURCE_MATCH_REQUIRED",
      (q) => {
        q.sourceMatch = null;
      },
    ],
    [
      "ANSWER_REFERENCE",
      (q) => {
        q.sourceMatch!.answerReference = "2번";
      },
    ],
    [
      "ANSWER_EDITION",
      (q) => {
        q.sourceMatch!.editionEvidence = [editions[0]!];
      },
    ],
    [
      "ANSWER_EDITION",
      (q) => {
        q.sourceMatch!.edition = "2025 연습판";
      },
    ],
    [
      "EXTRACTION_WORDING",
      (q) => {
        q.choices[1]!.text = "지어낸 보기";
      },
    ],
    [
      "SOURCE_ORIGIN",
      (q) => {
        q.origin = "ai_generated";
      },
    ],
    [
      "SUPPLIED_EVIDENCE",
      (q) => {
        q.evidence.push({ segmentId: "other", quote: "다른 자료" });
      },
    ],
    [
      "SOURCE_MATCH_EVIDENCE",
      (q) => {
        q.evidence = [questionQuote, ...editions];
      },
    ],
  ];
  for (const [code, mutate] of mutations) {
    const q = extracted();
    mutate(q);
    assert.throws(
      () => validateExtraction(q, source, [body], [answer]),
      (error: any) => error.code === code,
      code,
    );
  }
  const q = extracted();
  q.evidence = [questionQuote, { segmentId: "q", quote: "1번 정답 a." }];
  q.sourceMatch = {
    ...q.sourceMatch!,
    answerEvidence: q.evidence[1]!,
    edition: null,
    editionEvidence: [],
  };
  assert.doesNotThrow(() =>
    validateExtraction(
      q,
      source,
      [{ ...body, text: body.text + " 1번 정답 a." }],
      [],
    ),
  );
});

test("generation uses current late evidence, waits on unsupported answers, then resumes without unverified items", async (t) => {
  let supported = false;
  const requests: any[] = [];
  const agent = agentWith(async (role, raw, schema) => {
    const input = raw as any;
    if (role === "generate_question") {
      requests.push(input);
      assert.equal(input.materials.length, 1);
      assert.match(input.materials[0].text, /중앙값/);
      assert.doesNotMatch(input.materials[0].text, /폐기판/);
      return schema.parse({
        goalId: input.goal.id,
        scopeId: input.scopeId,
        type: "single",
        stem: "중앙값의 의미는?",
        choices: [
          { id: "a", text: "가운데 값" },
          { id: "b", text: "최댓값" },
        ],
        answer: ["a"],
        origin: "ai_generated",
        conceptIds: [input.slot.conceptId],
        evidence: [
          {
            segmentId: input.materials[0].segmentId,
            quote: "중앙값은 가운데 값이다.",
          },
        ],
      });
    }
    assert.equal(role, "verify_question");
    return schema.parse({
      usable: supported,
      evidenceValid: supported,
      answerValid: supported,
      reason: supported ? "근거 대조" : "인용만으로 정답을 확정할 수 없음",
    });
  });
  const f = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "study-grounding-")),
    token: "test",
    agent,
    autoWorker: false,
  });
  t.after(() => f.app.close());
  const goal = f.catalog.goal({ title: "통계 이해" });
  f.catalog.scope(goal.id, {
    title: "기초",
    concepts: [{ name: "중앙값", area: "통계" }],
  });
  const add = async (goalId: string, title: string, text: string) => {
    const src = f.catalog.source(goalId, {
      title,
      kind: "user_material",
      rights: "user_provided",
      rightsBasis: "test",
    });
    f.sources.commit(src.id, await f.sources.prepare(src.id, { text }));
    return src;
  };
  await add(goal.id, "긴 앞부분", "무관한 내용 ".repeat(50000));
  const src = await add(goal.id, "기준", "폐기판 중앙값은 틀린 설명.");
  f.sources.commit(
    src.id,
    await f.sources.prepare(src.id, { text: "중앙값은 가운데 값이다." }),
  );
  const other = f.catalog.goal({ title: "다른 목표" });
  await add(other.id, "다른 목표 자료", "중앙값은 다른 목표의 자료.");
  const blocked = await add(
    goal.id,
    "링크 전용",
    "중앙값은 이 구간에서 가져오면 안 됨.",
  );
  const blockedRow = f.store.get("sources", blocked.id);
  f.store.run(
    "UPDATE sources SET data=? WHERE id=?",
    JSON.stringify({ ...JSON.parse(blockedRow.data), rights: "link_only" }),
    blocked.id,
  );
  assert.ok(
    latestMaterials(f.catalog, goal.id).every(
      (m) => m.sourceId !== blocked.id && !m.text.includes("폐기판"),
    ),
  );
  const template = f.exams.template({
    name: "근거 검증",
    total: 1,
    single: 1,
    short: 0,
    policy: "ai_only",
  });
  const exam = f.exams.create(goal.id, template.id);
  const job = f.jobs.enqueue("prepare_exam", { examId: exam.id });
  await f.jobs.tick();
  assert.equal(f.jobs.get(job.id).status, "waiting_user");
  assert.equal(
    f.jobs.get(job.id).error.details.code,
    "GENERATION_REVIEW_REQUIRED",
  );
  assert.equal(f.exams.get(exam.id).items.length, 0);
  assert.equal(f.catalog.listQuestions(goal.id, {}).total, 0);
  assert.equal(requests.length, 3);
  supported = true;
  f.jobs.resume(job.id);
  await f.jobs.tick();
  assert.equal(f.jobs.get(job.id).status, "succeeded");
  assert.equal(f.exams.get(exam.id).items.length, 1);
});

test("evidence API keeps historical source revision, authenticates access and public exams omit answer matching", async (t) => {
  const f = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "study-evidence-")),
    token: "test",
    agent: agentWith(async () => {
      throw new Error("No AI expected");
    }),
    autoWorker: false,
  });
  t.after(() => f.app.close());
  const goal = f.catalog.goal({ title: "원문 대조" });
  const scope = f.catalog.scope(goal.id, {
    title: "통계",
    concepts: [{ name: "중앙값", area: "통계" }],
  });
  const src = f.catalog.source(goal.id, {
    title: "저장된 연습문제",
    kind: "official_practice",
    rights: "user_provided",
    rightsBasis: "test",
  });
  f.sources.commit(
    src.id,
    await f.sources.prepare(src.id, { text: body.text + " 1번 정답 a." }),
  );
  const seg = f.catalog.segments(src.id)[0];
  const q = extracted();
  q.goalId = goal.id;
  q.scopeId = scope.id;
  q.conceptIds = [scope.concepts[0]!.id!];
  q.evidence = [questionQuote, answerQuote].map((e) => ({
    ...e,
    segmentId: seg.id,
  }));
  q.sourceMatch = {
    ...q.sourceMatch!,
    questionEvidence: q.evidence[0]!,
    answerEvidence: q.evidence[1]!,
    edition: null,
    editionEvidence: [],
  };
  const created = f.catalog.createQuestion(q);
  f.catalog.review(created.revisionId, "usable", "원문 확인");
  f.sources.commit(
    src.id,
    await f.sources.prepare(src.id, { text: "새 판본의 다른 내용" }),
  );
  const endpoint = `/api/questions/${created.id}/evidence?revisionId=${created.revisionId}`;
  assert.equal(
    (await f.app.inject({ method: "GET", url: endpoint })).statusCode,
    401,
  );
  const reply = await f.app.inject({
    method: "GET",
    url: endpoint,
    headers: { authorization: "Bearer test" },
  });
  assert.equal(reply.statusCode, 200);
  const evidence = reply.json();
  assert.equal(evidence[0].sourceRevisionId, seg.revision_id);
  assert.match(evidence[0].text, /2026 연습판/);
  assert.equal(evidence[0].title, "저장된 연습문제");
  assert.deepEqual(
    new Set(evidence.map((e: any) => e.role)),
    new Set(["question", "answer"]),
  );
  assert.deepEqual(revisionInput(created).sourceMatch, q.sourceMatch);
  const template = f.exams.template({
    name: "공개 문항",
    total: 1,
    single: 1,
    short: 0,
  });
  const exam = f.exams.create(goal.id, template.id);
  assert.equal(exam.items.length, 1);
  assert.equal("sourceMatch" in exam.items[0], false);
  assert.equal("evidence" in exam.items[0], false);
});

test("extraction isolates rejected candidates and keeps uncertain answer mappings out of exams", async (t) => {
  const agent = agentWith(async (role, raw, schema) => {
    const input = raw as any;
    if (role === "extract_existing_questions") {
      const segmentId = input.segments[0].segmentId;
      const make = (number: number) => {
        const qe = { segmentId, quote: `${number}번 중앙값은?` };
        const ae = { segmentId, quote: `${number}번 정답 a.` };
        return {
          ...extracted(),
          goalId: input.source.goalId,
          scopeId: input.scope.id,
          conceptIds: [input.scope.concepts[0].id],
          stem: qe.quote,
          evidence: [qe, ae],
          sourceMatch: {
            questionReference: `${number}번`,
            answerReference: `${number}번`,
            questionEvidence: qe,
            answerEvidence: ae,
            edition: null,
            editionEvidence: [],
          },
        };
      };
      return schema.parse({
        questions: [
          make(1),
          { ...make(2), answer: ["b"] },
          {
            ...make(3),
            choices: [
              { id: "a", text: "가운데 값" },
              { id: "b", text: "원문에 없는 보기" },
            ],
          },
          { ...make(4), sourceMatch: null },
        ],
        unresolved: [{ reference: "5번", reason: "정답 없음" }],
      });
    }
    assert.equal(role, "verify_question");
    const good = input.question.answer[0] === "a";
    return schema.parse({
      usable: good,
      evidenceValid: true,
      answerValid: good,
      reason: good ? "정답표 대조" : "보기와 정답표 매핑 불일치",
    });
  });
  const f = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "study-extract-check-")),
    agent,
    token: "test",
    autoWorker: false,
  });
  t.after(() => f.app.close());
  const goal = f.catalog.goal({ title: "기존 문항 확인" });
  f.catalog.scope(goal.id, {
    title: "통계",
    concepts: [{ name: "중앙값", area: "통계" }],
  });
  const src = f.catalog.source(goal.id, {
    title: "기존 연습문제",
    kind: "official_practice",
    rights: "user_provided",
    rightsBasis: "test",
  });
  f.sources.commit(
    src.id,
    await f.sources.prepare(src.id, {
      text: Array.from(
        { length: 4 },
        (_, i) =>
          `${i + 1}번 중앙값은? a 가운데 값 b 최댓값. ${i + 1}번 정답 a.`,
      ).join("\n"),
    }),
  );
  const job = f.jobs.enqueue("extract_questions", { sourceId: src.id });
  await f.jobs.tick();
  const finished = f.jobs.get(job.id);
  assert.equal(finished.status, "succeeded", JSON.stringify(finished.error));
  assert.equal(finished.result.count, 2);
  assert.equal(finished.result.usable, 1);
  assert.equal(finished.result.needsReview, 1);
  assert.equal(finished.result.unresolved.length, 3);
  const template = f.exams.template({
    name: "확인된 문항만",
    total: 2,
    single: 2,
    short: 0,
  });
  const exam = f.exams.create(goal.id, template.id);
  assert.equal(exam.items.length, 1);
  assert.match(exam.items[0].stem, /^1번/);
  assert.throws(() => f.exams.finalize(exam.id));
});
