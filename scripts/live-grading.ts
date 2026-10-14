// Opt-in real Codex evaluation. Uses existing ChatGPT login and a fresh temp DB.
// No paid API fallback; never opens or changes the user's study-room data.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAgent, type AgentPort } from "../src/agent.js";
import { createApp } from "../src/app.js";
import { Fault } from "../src/core.js";
import { shortAnswerCases } from "./fixtures/short-answers.js";

const selected = process.argv
  .find((arg) => arg.startsWith("--only="))
  ?.slice(7)
  .split(",");
const cases = shortAnswerCases.filter(
  (c) => !selected || selected.includes(c.id),
);
if (!process.argv.includes("--live")) {
  console.log(
    "Use --live to consume existing Codex account usage. Optional --only=id,id.",
  );
  console.log(shortAnswerCases.map((c) => c.id).join("\n"));
  process.exit(0);
}
if (
  !cases.length ||
  selected?.some((id) => !shortAnswerCases.some((c) => c.id === id))
)
  throw new Error("Unknown or empty case selection");
const dataDir = mkdtempSync(join(tmpdir(), "study-cafe-live-grading-"));
const reportPath = join(dataDir, "report.json");
const real = new CodexAgent({
  cwd: join(dataDir, "agent-work"),
  timeoutMs: 180_000,
});
let activeCase = "setup";
let providerFailed = false;
const report: any = {
  startedAt: new Date().toISOString(),
  dataDir,
  model: "Existing Codex configuration; no model override",
  effort: "medium",
  calls: [],
  cases: [],
};
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2));
const agent: AgentPort = {
  async ask(role, input, schema, options) {
    if (options?.search)
      throw new Error("Grading evaluation must not use web search");
    const started = Date.now();
    console.log(`[${activeCase}] ${role} started`);
    try {
      const output = await real.ask(role, input, schema, options);
      report.calls.push({
        caseId: activeCase,
        role,
        elapsedMs: Date.now() - started,
        output,
      });
      save();
      console.log(
        `[${activeCase}] ${role} completed (${((Date.now() - started) / 1000).toFixed(1)}s)`,
      );
      return output;
    } catch (e) {
      if (e instanceof Fault && e.code.startsWith("CODEX_"))
        providerFailed = true;
      report.calls.push({
        caseId: activeCase,
        role,
        elapsedMs: Date.now() - started,
        error: e instanceof Error ? e.message : String(e),
        ...(e instanceof Fault ? { code: e.code, details: e.details } : {}),
      });
      save();
      throw e;
    }
  },
  status: () => real.status(),
  login: () => real.login(),
  models: () => real.models(),
  close: () => real.close(),
};
const f = await createApp({
  dataDir,
  agent,
  token: "live-grading-fixture",
  autoWorker: false,
});
async function run(kind: string, input: any) {
  const job = f.jobs.enqueue(kind, input);
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const current = f.jobs.get(job.id);
    if (!["queued", "running"].includes(current.status)) return current;
    await new Promise((r) => setTimeout(r, 250));
  }
  f.jobs.cancel(job.id);
  throw new Error("Evaluation job deadline exceeded");
}
console.log(`Report: ${reportPath}`);
try {
  const status = await agent.status();
  if (!status.authenticated || status.type !== "chatgpt")
    throw new Error(
      "An existing ChatGPT Codex login is required; API billing is not allowed.",
    );
  for (const c of cases) {
    activeCase = c.id;
    const started = Date.now();
    const goal = f.catalog.goal({
      title: `[실제 채점 검증] ${c.title}`,
      kind: c.kind,
    });
    const scope = f.catalog.scope(goal.id, {
      title: c.title,
      concepts: [{ name: c.concept, area: c.title }],
    });
    const source = f.catalog.source(goal.id, {
      title: "직접 작성한 검증 자료",
      kind: "user_material",
      rights: "user_provided",
      rightsBasis: "Hand-authored evaluation fixture",
    });
    f.sources.commit(
      source.id,
      await f.sources.prepare(source.id, { text: c.material }),
    );
    const points = c.rubric.reduce((sum, r) => sum + r.points, 0);
    const q = f.catalog.createQuestion({
      goalId: goal.id,
      scopeId: scope.id,
      type: "short",
      stem: c.stem,
      modelAnswer: c.modelAnswer,
      rubric: c.rubric,
      points,
      origin: "external_practice",
      conceptIds: [scope.concepts[0]!.id!],
      evidence: [
        { segmentId: f.catalog.segments(source.id)[0].id, quote: c.material },
      ],
    });
    // Deliberately permit bad legacy rubrics to reach the grading guard.
    f.catalog.review(
      q.revisionId,
      "usable",
      "Evaluation fixture, not product approval",
    );
    const template = f.exams.template({
      name: "단일 사례 검증",
      total: 1,
      single: 0,
      short: 1,
    });
    const exam = f.exams.create(goal.id, template.id);
    f.exams.finalize(exam.id);
    const frozen = JSON.stringify(f.exams.get(exam.id, true));
    const attempt = f.exams.start(exam.id);
    f.exams.saveAnswer(attempt.id, 1, {
      value: c.answer,
      version: 0,
      flagged: false,
      uncertain: false,
      hintUsed: false,
      recall: null,
    });
    f.learning.submit(attempt.id, "live-grading");
    const job = await run("grade_attempt", { attemptId: attempt.id });
    const result = f.learning.result(attempt.id);
    const assessment = result.items[0].assessment;
    const expected = [c.expected, ...(c.alternative ? [c.alternative] : [])];
    const correct =
      job.status === "succeeded" &&
      expected.some(
        (e) =>
          assessment.status === e.status &&
          assessment.score === e.score &&
          assessment.passed === e.passed,
      );
    const expectedWrong =
      assessment.status === "confirmed" && !assessment.passed ? 1 : 0;
    const stateCorrect =
      JSON.stringify(f.exams.get(exam.id, true)) === frozen &&
      f.learning.wrong(goal.id).length === expectedWrong &&
      f.store.one(
        "SELECT COUNT(*) n FROM review_events WHERE goal_id=?",
        goal.id,
      ).n === (assessment.status === "pending" ? 0 : 1);
    let verification: any = null;
    if (c.verifyStatuses && !providerFailed) {
      const verified = await run("verify_question", { questionId: q.id });
      verification = {
        jobStatus: verified.status,
        error: verified.error,
        status: f.catalog.readQuestion(q.id).status,
      };
    }
    const passed =
      correct &&
      stateCorrect &&
      (!verification ||
        (verification.jobStatus === "succeeded" &&
          c.verifyStatuses!.includes(verification.status)));
    report.cases.push({
      id: c.id,
      passed,
      expected,
      stateCorrect,
      jobStatus: job.status,
      error: job.error,
      assessment,
      verification,
      elapsedMs: Date.now() - started,
      goalId: goal.id,
      attemptId: attempt.id,
    });
    save();
    console.log(
      `[${c.id}] ${passed ? "PASS" : "FAIL"}: ${assessment.status}, score=${assessment.score}, passed=${assessment.passed}`,
    );
    if (providerFailed) {
      report.stopped =
        "Provider failure: remaining cases were not called. Resume explicitly with --only after recovery.";
      report.notRun = cases.slice(report.cases.length).map((c) => c.id);
      break;
    }
  }
  report.passed =
    report.cases.length === cases.length &&
    report.cases.every((c: any) => c.passed);
  if (!report.passed) process.exitCode = 1;
} catch (e) {
  report.error = e instanceof Error ? e.message : String(e);
  report.passed = false;
  process.exitCode = 1;
  console.error(report.error);
} finally {
  report.finishedAt = new Date().toISOString();
  save();
  await f.app.close();
  console.log(
    `Finished: ${report.cases.filter((c: any) => c.passed).length}/${cases.length}; report=${reportPath}`,
  );
}
