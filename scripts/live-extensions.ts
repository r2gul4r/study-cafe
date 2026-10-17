// Explicit live acceptance; isolated data and existing Codex account only.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { gradePython } from "../src/python.js";
import { CodexAgent } from "../src/agent.js";

if (!process.argv.includes("--live")) {
  console.log(
    "Use --live [--pdf=<completed live-pdf directory>]. Uses existing Codex quota.",
  );
  process.exit(0);
}
const dataDir = mkdtempSync(join(tmpdir(), "study-cafe-live-extensions-"));
const reportPath = join(dataDir, "report.json");
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  dataDir,
};
const f = await createApp({ dataDir, autoWorker: false });
async function wait(app: typeof f, kind: string, input: object) {
  let job = app.jobs.enqueue(kind, input);
  const until = Date.now() + 12 * 60_000;
  while (["queued", "running"].includes(job.status) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 300));
    job = app.jobs.get(job.id);
  }
  assert.equal(job.status, "succeeded", JSON.stringify(job.error));
  return job.result;
}
console.log(`Report: ${reportPath}`);
try {
  const status = await f.agent.status();
  assert.ok(status.authenticated && status.type === "chatgpt");
  const goal = f.catalog.goal({
    title: "[실행 검증] 정수 입출력 Python",
    kind: "skill",
    description:
      "Python 표준입출력 실행 문제. 정수를 읽어 사칙연산과 조건을 적용하고 결과를 출력한다.",
  });
  f.catalog.scope(goal.id, {
    title: "정수 계산",
    concepts: [{ name: "정수 입출력", area: "Python" }],
  });
  const source = f.catalog.source(goal.id, {
    title: "직접 작성한 입출력 설명",
    kind: "user_material",
    rights: "user_provided",
    rightsBasis: "Authored acceptance fixture",
  });
  f.sources.commit(
    source.id,
    await f.sources.prepare(source.id, {
      text: "Python input() reads one line as text. int() converts integer text to an integer. print() outputs a value followed by a newline. Integers support +, -, *, // and %. For an integer n, n + 1 is its successor and n % 2 == 0 checks whether it is even. if/else selects one branch. Negative integers and zero are valid inputs. abs(n) returns its absolute value.",
    }),
  );
  const template = f.exams.template({
    name: "실제 Python 생성",
    total: 2,
    single: 0,
    short: 2,
    python: 2,
    policy: "ai_only",
  });
  const exam = f.exams.create(goal.id, template.id);
  await wait(f, "prepare_exam", { examId: exam.id });
  const ready = f.exams.get(exam.id, true);
  assert.equal(ready.items.length, 2);
  for (const q of ready.items) {
    assert.ok(q.python?.tests.length >= 2);
    assert.ok(
      (await gradePython(q.modelAnswer, q.python)).every(
        (r) => r.status === "passed",
      ),
    );
  }
  const variant = await wait(f, "generate_variant", {
    questionId: ready.items[0].id,
  });
  assert.equal(variant.status, "usable");
  report.python = {
    examId: exam.id,
    questions: ready.items.map(
      (q: { id: string; stem: string; python: unknown }) => ({
        id: q.id,
        stem: q.stem,
        python: q.python,
      }),
    ),
    variant,
  };
  const pdfDir = process.argv.find((s) => s.startsWith("--pdf="))?.slice(6);
  if (pdfDir) {
    const pdfReport = JSON.parse(
      readFileSync(join(pdfDir, "pdf-report.json"), "utf8"),
    );
    assert.ok(pdfReport, "Completed marked PDF evaluation required");
    const pdf = await createApp({
      dataDir: pdfDir,
      autoWorker: false,
      agent: new CodexAgent({
        cwd: join(pdfDir, "agent-work"),
        timeoutMs: 240000,
      }),
    });
    try {
      const id = pdf.store.one(
        "SELECT id FROM questions ORDER BY created_at LIMIT 1",
      ).id;
      const q = pdf.catalog.readQuestion(id);
      const suggestions = await wait(pdf, "suggest_regions", {
        questionId: q.id,
        revisionId: q.revisionId,
      });
      assert.ok(suggestions.regions.length);
      assert.equal(
        pdf.catalog.readQuestion(id).revisionId,
        q.revisionId,
        "Suggestions never mutate a question",
      );
      report.regions = { questionId: q.id, ...suggestions };
    } finally {
      await pdf.app.close();
    }
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  await f.app.close();
  console.log(JSON.stringify(report, null, 2));
}
