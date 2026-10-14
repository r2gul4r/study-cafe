// Isolated browser-QA server. Never reads production data or calls a real agent.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../src/app.js";
import type { AgentPort } from "../src/agent.js";
const agent: AgentPort = {
  async ask(role, input: any, schema) {
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
    return [];
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
await runtime.app.listen({ host: "127.0.0.1", port: 4319 });
console.log(
  "UI verification only: http://127.0.0.1:4319 | token: study-cafe-ui-only",
);
console.log(`UI data: ${dataDir}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(
    signal,
    () => void runtime.app.close().then(() => process.exit(0)),
  );
