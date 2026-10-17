// Isolated interactive acceptance fixture. No production records or credentials.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createApp } from "../src/app.js";
const dataDir = resolve(
  process.env.STUDY_CAFE_EXTENSION_DATA ?? "output/extension-ui-data",
);
const port = Number(process.env.PORT ?? 4321);
const host = `127.0.0.1:${port}`;
const f = await createApp({
  dataDir,
  webDir: resolve("apps/web/dist"),
  allowedOrigins: [`http://${host}`],
});
if (!f.store.one("SELECT id FROM goals LIMIT 1")) {
  const g = f.catalog.goal({ title: "[확장 화면 검증] Python 실행·섹션·복습" });
  const scope = f.catalog.scope(g.id, {
    title: "정수 입력과 연산",
    concepts: [{ name: "정수 입출력", area: "Python" }],
  });
  const source = f.catalog.source(g.id, {
    title: "직접 작성한 검증 자료",
    kind: "user_material",
    rights: "user_provided",
    rightsBasis: "검증용 자체 작성",
  });
  f.sources.commit(
    source.id,
    await f.sources.prepare(source.id, {
      text: "input()은 한 줄을 읽는다. int()는 정수 문자열을 정수로 바꾼다. print()는 값을 출력한다. 정수 x의 다음 정수는 x+1, 두 배는 x*2이다.",
    }),
  );
  const seg = f.catalog.segments(source.id)[0];
  for (const [operation, expected, expression] of [
    ["다음 정수", "3", "+ 1"],
    ["두 배", "4", "* 2"],
  ]) {
    const q = f.catalog.createQuestion({
      goalId: g.id,
      scopeId: scope.id,
      type: "short",
      stem: `입력 한 줄의 정수 x를 읽어서 ${operation}를 한 줄로 출력하는 Python 프로그램을 작성하시오. 각 테스트는 동일 배점이다.`,
      modelAnswer: `print(int(input()) ${expression})`,
      rubric: [
        {
          id: "execution",
          description: "요구한 값을 모든 입력에서 출력한다.",
          points: 2,
        },
      ],
      points: 2,
      origin: "external_practice",
      conceptIds: [scope.concepts[0]!.id],
      evidence: [{ segmentId: seg.id, quote: seg.text }],
      python: {
        language: "python",
        starterCode: "x = int(input())\nprint(x)",
        timeoutMs: 1000,
        tests: [
          { name: "기본 예제", stdin: "2", stdout: expected },
          {
            name: "음수 입력",
            stdin: "-1",
            stdout: expression === "+ 1" ? "0" : "-2",
            hidden: true,
          },
        ],
      },
    });
    f.catalog.review(q.revisionId, "usable", "자체 작성한 화면 검증용 문항");
  }
  const template = f.exams.template({
    name: "Python 실행과 섹션 화면 검증",
    total: 2,
    single: 0,
    short: 2,
    python: 2,
    minutes: 20,
    sections: [
      { title: "첫 코드", count: 1, minutes: 10 },
      { title: "두 번째 코드", count: 1, minutes: 10 },
    ],
  });
  const exam = f.exams.create(g.id, template.id);
  f.exams.finalize(exam.id);
}
await f.app.listen({ host: "127.0.0.1", port });
mkdirSync(resolve("output"), { recursive: true });
writeFileSync(
  resolve("output/extension-ui-connection.txt"),
  `http://${host}/#/connect?code=${f.browserSessions.issue(host)}`,
);
console.log(
  `Extension UI: http://${host}; data=${dataDir}; connection=output/extension-ui-connection.txt`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void f.app.close().then(() => process.exit(0)));
