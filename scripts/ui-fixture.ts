// Isolated browser-QA server. Never reads production data or calls a real agent.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../src/app.js";
import { openBrowser } from "../src/local-browser.js";
import type { AgentPort } from "../src/agent.js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { pdfPageImage } from "../src/pdf-visuals.js";
const agent: AgentPort = {
  async ask(role, input: any, schema, options) {
    const delayMs = Number(process.env.STUDY_CAFE_UI_AGENT_DELAY_MS ?? 0);
    if (Number.isFinite(delayMs) && delayMs > 0)
      await delay(Math.min(delayMs, 60_000), undefined, {
        signal: options?.signal,
      });
    if (
      role === "verify_question" &&
      input.correction &&
      input.question.stem.startsWith("[UI correction]")
    )
      return schema.parse({
        usable: true,
        evidenceValid: true,
        answerValid: true,
        reason: "UI fixture only; no model evaluation",
        rubricCheck: {
          criteria: input.question.rubric.map((r: { id: string }) => ({
            id: r.id,
            aligned: true,
            promptField: "stem",
            promptQuote: input.question.stem,
            reason: "UI fixture only",
          })),
          explanation: "UI fixture only",
        },
        sourceCheck: input.correction.originalAudit,
        correctionCheck: {
          correctedAnswerValid: true,
          allIssuesAddressed: true,
          reason: "UI fixture only",
        },
      });
    if (role === "summarize_misconceptions")
      return schema.parse({
        concepts: input.concepts.map((concept: { id: string }) => ({
          conceptId: concept.id,
          summary:
            "검증용 요약입니다. 선택한 답안을 근거로 반복 횟수를 다시 확인해요.\n\nrange(n)은 n개의 정수를 만들어요. 종료 값은 포함하지 않아요.",
          example:
            "```python\nfor i in range(3):\n    print(i)\n```\n\n출력은 0, 1, 2이며 반복 횟수는 3번이에요.",
          reasonIsInferred: true,
          attemptIds: [
            ...new Set(
              input.wrong
                .filter((item: { conceptIds: string[] }) =>
                  item.conceptIds.includes(concept.id),
                )
                .map((item: { attemptId: string }) => item.attemptId),
            ),
          ],
        })),
      });
    if (role === "plan_goal")
      return schema.parse({
        scope: {
          title: input.goal.title,
          concepts: [{ name: "기초 개념", area: "학습", weight: 1 }],
          references: [],
          examFormat: null,
        },
        questions: [],
        summary: "UI 검증용 범위 초안입니다.",
      });
    throw new Error("UI 검증 모드: 실제 AI 호출은 실행하지 않았습니다.");
  },
  async status() {
    return { connected: true, authenticated: false, type: "ui-fixture" };
  },
  async login() {
    throw new Error("UI 검증 모드에서는 로그인하지 않습니다.");
  },
  async models() {
    return {
      data: [
        {
          id: "ui-test-model",
          model: "ui-test-model",
          displayName: "UI test model (no AI)",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "UI test" },
            { reasoningEffort: "medium", description: "UI test" },
          ],
        },
      ],
    };
  },
  async close() {},
};
const dataDir =
  process.env.STUDY_CAFE_UI_DATA_DIR ??
  mkdtempSync(join(tmpdir(), "study-cafe-ui-"));
const runtime = await createApp({
  dataDir,
  webDir: resolve("apps/web/dist"),
  token: "study-cafe-ui-only",
  agent,
  allowedOrigins: ["http://127.0.0.1:4319"],
});
const { catalog, sources, exams, learning, store } = runtime;
if (
  !store.setting("ui_fixture_seeded", false) &&
  !store.one("SELECT count(*) AS n FROM goals").n
) {
  const goal = catalog.goal({
    title: "[검증] 파이썬 기초 다지기",
    description: "반복문을 읽고, 실행 결과를 설명할 수 있어요.",
    kind: "skill",
    minutesPerDay: 30,
  });
  const scope = catalog.scope(goal.id, {
    title: "파이썬 반복문",
    concepts: [{ name: "반복문과 range", area: "파이썬", weight: 1 }],
  });
  catalog.goal({
    title: "[검증] JLPT N2 도전하기",
    description: "읽고 이해하는 일본어에서, 자신 있게 활용하는 일본어로.",
    kind: "exam",
    minutesPerDay: 40,
  });
  catalog.goal({
    title: "[검증] AI 개념 이해하기",
    description: "일상 속 AI 서비스의 작동 원리를 설명해요.",
    kind: "general",
    minutesPerDay: 20,
  });
  const source = catalog.source(goal.id, {
    title: "[검증] 직접 작성한 파이썬 학습 자료",
    kind: "user_material",
    rights: "user_provided",
    rightsBasis: "브라우저 검증을 위해 직접 작성한 자료",
  });
  sources.commit(
    source.id,
    await sources.prepare(source.id, {
      text: "range(n)은 0부터 n-1까지 정수를 차례로 만든다. for문은 주어진 항목마다 본문을 한 번 실행한다. 반복문을 사용하면 같은 작업을 여러 번 수행할 수 있다.",
    }),
  );
  const segment = catalog.segments(source.id)[0];
  for (let n = 1; n <= 25; n++) {
    const short = n > 20;
    const q = catalog.createQuestion({
      goalId: goal.id,
      scopeId: scope.id,
      type: short ? "short" : "single",
      stem: short
        ? `range(${n})을 사용하는 for문이 몇 번 실행되는지, 그 이유와 함께 설명하세요.`
        : `다음 코드를 실행했을 때 print 함수는 몇 번 호출될까요?\n\nfor i in range(${n}):\n    print(i)`,
      choices: short
        ? []
        : [
            { id: "a", text: `${n}번` },
            { id: "b", text: `${n + 1}번` },
            { id: "c", text: `${n - 1}번` },
            { id: "d", text: "실행되지 않는다" },
          ],
      answer: short ? [] : ["a"],
      modelAnswer: short
        ? `${n}번. range(${n})은 0부터 ${n - 1}까지 총 ${n}개 정수를 만든다.`
        : null,
      rubric: short
        ? [
            {
              id: "count",
              description: "반복 횟수와 range 범위를 정확하게 설명",
              points: 1,
              required: true,
            },
          ]
        : [],
      points: 1,
      origin: "external_practice",
      conceptIds: [scope.concepts[0]!.id!],
      evidence: [
        {
          segmentId: segment.id,
          quote: "range(n)은 0부터 n-1까지 정수를 차례로 만든다.",
        },
      ],
      explanation: `range(${n})은 ${n}개의 값을 제공하므로 본문은 ${n}번 실행됩니다.`,
    });
    catalog.review(q.revisionId, "usable", "검증용 자체 작성 문항 확인");
  }
  const template = exams.template({ name: "[검증] 파이썬 반복문 · 25문항" });
  const exam = exams.create(goal.id, template.id, "ui-verification");
  exams.finalize(exam.id);
  const old = exams.start(exam.id);
  for (const q of old.exam.items)
    exams.saveAnswer(old.id, q.slot, {
      value:
        q.type === "short"
          ? "반복 횟수를 잘 모르겠습니다."
          : q.slot % 4 === 0
            ? ["b"]
            : ["a"],
      version: 0,
      flagged: false,
      uncertain: q.slot === 2,
      hintUsed: false,
      recall: "good",
    });
  learning.submit(old.id, "fixture-completed");
  store.run(
    "UPDATE review_states SET due=?",
    new Date(Date.now() - 60000).toISOString(),
  );
}
store.run(
  "INSERT OR REPLACE INTO settings(key,value) VALUES('ui_fixture_seeded','true')",
);
if (!store.setting("ui_fixture_rich_seeded", false)) {
  const goal = store.one(
    "SELECT id FROM goals WHERE json_extract(data, '$.title')=?",
    "[검증] 파이썬 기초 다지기",
  );
  const scope = catalog.readGoal(goal.id).scope!;
  const pythonSource = catalog.source(goal.id, {
    title: "[검증] Python 정수 입력",
    kind: "user_material",
    rights: "user_provided",
    rightsBasis: "자체 작성 테스트 자료",
  });
  sources.commit(
    pythonSource.id,
    await sources.prepare(pythonSource.id, {
      text: "int(input())는 입력을 정수로 변환한다. print(int(input()) + 1)은 입력한 정수의 다음 값을 출력한다.",
    }),
  );
  const pythonSegment = catalog.segments(pythonSource.id)[0];
  const question = catalog.createQuestion({
    goalId: goal.id,
    evidence: [{ segmentId: pythonSegment.id, quote: pythonSegment.text }],
    scopeId: scope.id,
    type: "short",
    origin: "external_practice",
    stem: "정수를 하나 입력받아 1을 더한 값을 출력하세요.\n\n```python\n# 입력: 2\n# 출력: 3\n```",
    modelAnswer: "print(int(input()) + 1)",
    rubric: [
      { id: "tests", description: "예제와 비공개 테스트 통과", points: 2 },
    ],
    points: 2,
    conceptIds: scope.concepts.map((c: { id?: string }) => c.id!),
    python: {
      language: "python",
      tests: [
        { name: "기본 예제", stdin: "2", stdout: "3" },
        { name: "음수", stdin: "-1", stdout: "0", hidden: true },
      ],
    },
    explanation: "입력은 문자열이므로 int로 바꾸고 1을 더해 출력해요.",
  });
  catalog.review(question.revisionId, "usable", "자체 작성 UI 테스트 문항");
  const template = exams.template({
    name: "[검증] Python 실행 · 1문항",
    total: 1,
    single: 0,
    short: 1,
    python: 1,
  });
  const exam = exams.create(goal.id, template.id, "ui-python");
  exams.finalize(exam.id);
  store.run(
    "INSERT OR REPLACE INTO settings(key,value) VALUES('ui_fixture_rich_seeded','true')",
  );
}
if (!store.setting("ui_fixture_deep_seeded", false)) {
  const goal = catalog.readGoal(
    store.one(
      "SELECT id FROM goals WHERE json_extract(data,'$.title')=?",
      "[검증] 파이썬 기초 다지기",
    ).id,
  );
  const scope = goal.scope;
  const source = catalog.source(goal.id, {
    title: "[UI검증] PDF 영역·정답 정정 자료",
    kind: "user_material",
    rights: "user_provided",
    rightsBasis: "직접 작성한 UI 검증 자료",
  });
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 400]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("UI visual question: What is 2 + 2?", {
    x: 30,
    y: 340,
    font,
    size: 14,
  });
  page.drawText("A. 4    B. 5", { x: 30, y: 310, font, size: 14 });
  sources.commit(
    source.id,
    await sources.prepare(source.id, {
      mime: "application/pdf",
      base64: Buffer.from(await pdf.save()).toString("base64"),
    }),
  );
  const segment = catalog.segments(source.id)[0];
  const image = await pdfPageImage(
    store,
    store.get("segments", segment.id).revision_id,
    1,
  );
  const visual = catalog.createQuestion({
    goalId: goal.id,
    scopeId: scope.id,
    type: "single",
    stem: "[UI visual] 2 + 2의 결과를 고르세요.",
    choices: [
      { id: "a", text: "4" },
      { id: "b", text: "5" },
    ],
    answer: ["a"],
    explanation: "2 + 2 = 4",
    origin: "external_practice",
    conceptIds: [scope.concepts[0].id],
    evidence: [{ segmentId: segment.id, quote: segment.text }],
    visualTranscription: true,
    requiredAssetIds: [image.assetId],
    visualEvidence: [
      { segmentId: segment.id, assetId: image.assetId, role: "question" },
    ],
  });
  catalog.review(visual.revisionId, "usable", "자체 작성한 UI fixture");
  const correctionSource = catalog.source(goal.id, {
    title: "[UI검증] 의도적으로 틀린 정답표",
    kind: "user_material",
    rights: "user_provided",
    rightsBasis: "정정 UI 검증용 자체 작성",
  });
  const stem = "[UI correction] 2 + 2의 결과만 쓰세요.",
    keyText = "정답표: 2 + 2 = 5. 정답 5.";
  sources.commit(
    correctionSource.id,
    await sources.prepare(correctionSource.id, { text: stem + "\n" + keyText }),
  );
  const correctionSegment = catalog.segments(correctionSource.id)[0];
  const qe = { segmentId: correctionSegment.id, quote: stem },
    ae = { segmentId: correctionSegment.id, quote: keyText };
  const correction = catalog.createQuestion({
    goalId: goal.id,
    scopeId: scope.id,
    type: "short",
    stem,
    modelAnswer: "5",
    rubric: [{ id: "r", description: "5", points: 1 }],
    explanation: keyText,
    origin: "external_practice",
    conceptIds: [scope.concepts[0].id],
    evidence: [qe, ae],
    sourceMatch: {
      questionReference: "1",
      answerReference: "1",
      questionEvidence: qe,
      answerEvidence: ae,
      edition: null,
      editionEvidence: [],
    },
  });
  catalog.review(
    correction.revisionId,
    "needs_review",
    "의도적인 정답 오류를 가진 UI fixture",
    "codex",
    {
      questionUnambiguous: true,
      finalAnswerMatches: false,
      independentAnswer: "4",
      issues: [
        {
          kind: "answer_error",
          location: "final_answer",
          evidence: ae,
          description:
            "2 + 2의 결과는 4임. 5로 표기한 오류를 검증용으로 삽입함.",
          contextResolves: false,
          affectsAnswer: true,
          affectsGrading: true,
        },
      ],
    },
  );
  store.run(
    "INSERT OR REPLACE INTO settings(key,value) VALUES('ui_fixture_deep_seeded','true')",
  );
}
await runtime.app.listen({ host: "127.0.0.1", port: 4319 });
console.log("UI verification only: http://127.0.0.1:4319");
console.log(`UI data: ${dataDir}`);
writeFileSync(
  join(dataDir, "ui-connect.json"),
  JSON.stringify({
    url: `http://127.0.0.1:4319/#/connect?code=${runtime.browserSessions.issue("127.0.0.1:4319")}`,
  }),
);
if (process.env.STUDY_CAFE_NO_OPEN !== "1")
  void openBrowser(
    `http://127.0.0.1:4319/#/connect?code=${runtime.browserSessions.issue("127.0.0.1:4319")}`,
  ).catch(() => console.error("브라우저 자동 열기에 실패했습니다."));
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(
    signal,
    () => void runtime.app.close().then(() => process.exit(0)),
  );
