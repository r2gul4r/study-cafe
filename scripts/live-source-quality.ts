// Opt-in real Codex contrast evaluation. Authored cases, never a user DB.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CodexAgent, type AgentPort } from "../src/agent.js";
import { createApp } from "../src/app.js";
import { Fault } from "../src/core.js";

if (!process.argv.includes("--live")) {
  console.log(
    "No calls. Use --live for six authored contrast cases with existing ChatGPT login.",
  );
  process.exit(0);
}
const cases = [
  {
    name: "intermediate_differential",
    stem: "1. Compute the double integral integral_0^1 integral_0^1 1 dy dx. Give only its value.",
    key: "1. Solution: I = integral_0^1 [integral_0^1 1] dx = integral_0^1 1 dx = 1. The inner integration is with respect to y as defined in the question. Final answer: 1.",
    answer: "1",
    expected: "usable",
    issue: "notation_only",
  },
  {
    name: "intermediate_spelling",
    stem: "1. Compute 3 times 4. Give only the result.",
    key: "1. Intermediate note: The prodcut is 3 x 4 = 12. Final answer: 12.",
    answer: "12",
    expected: "usable",
    issue: "notation_only",
  },
  {
    name: "wrong_final_answer",
    stem: "1. Compute 2 + 2. Give only the result.",
    key: "1. Solution: 2 + 2 = 5. Final answer: 5.",
    answer: "5",
    expected: "needs_review",
    issue: "answer_error",
  },
  {
    name: "wrong_intermediate_equality",
    stem: "1. Compute 2 times 3. Give only the result.",
    key: "1. Intermediate calculation: 2 x 3 = 5. Final answer: 6.",
    answer: "6",
    expected: "needs_review",
    issue: "answer_error",
  },
  {
    name: "wrong_final_unit",
    stem: "1. A vehicle moves at 10 m/s for 2 s. Give the distance traveled, including its unit.",
    key: "1. Solution: distance = speed x time = 10 x 2. Final answer: 20 s.",
    answer: "20 s",
    expected: "needs_review",
    issue: "answer_error",
  },
  {
    name: "missing_question_operator",
    stem: "1. Compute 3 [missing operator] 4. Give only the result.",
    key: "1. Final answer: 7.",
    answer: "7",
    expected: "needs_review",
    issue: "ambiguous",
  },
];
const dataDir = mkdtempSync(join(tmpdir(), "study-cafe-source-quality-"));
const reportPath = join(dataDir, "source-quality-report.json");
const report: any = {
  kind: "study-cafe-live-source-quality-v1",
  startedAt: new Date().toISOString(),
  scope:
    "Six authored text contrast cases, not public past exam questions. Real product verify_question workflow. Existing ChatGPT login; no paid API fallback.",
  codeHashes: Object.fromEntries(
    ["source-quality", "workflows"].map((name) => [
      name,
      createHash("sha256")
        .update(readFileSync(new URL(`../src/${name}.ts`, import.meta.url)))
        .digest("hex"),
    ]),
  ),
  calls: [],
  cases: [],
};
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2));
const real = new CodexAgent({
  cwd: join(dataDir, "agent-work"),
  timeoutMs: 240000,
});
const agent: AgentPort = {
  async ask(role, input, schema, options) {
    assert.equal(role, "verify_question");
    assert.ok(report.calls.length < cases.length);
    const started = Date.now();
    const call: any = { role, startedAt: new Date().toISOString() };
    report.calls.push(call);
    save();
    console.log(`Real review ${report.calls.length}/${cases.length}`);
    try {
      const result = await real.ask(role, input, schema, options);
      call.output = result;
      return result;
    } catch (e) {
      call.error =
        e instanceof Fault
          ? { code: e.code, message: e.message }
          : { message: String(e) };
      throw e;
    } finally {
      call.elapsedMs = Date.now() - started;
      save();
    }
  },
  status: () => real.status(),
  login: () => real.login(),
  models: () => real.models(),
  close: () => real.close(),
};
const f = await createApp({
  dataDir,
  token: "source-quality-fixture",
  autoWorker: false,
  agent,
});
console.log(`Report: ${reportPath}`);
try {
  const account = await real.status();
  assert.ok(
    account.authenticated && account.type === "chatgpt",
    "Existing ChatGPT login required",
  );
  const goal = f.catalog.goal({
    title: "Quantitative reasoning",
    kind: "general",
    description:
      "Arithmetic, basic calculus and physical quantities; preserve original source evidence.",
  });
  const scope = f.catalog.scope(goal.id, {
    title: "Source-based reasoning",
    concepts: [
      {
        name: "Mathematical reasoning and quantities",
        area: "Quantitative reasoning",
      },
    ],
  });
  for (const entry of cases) {
    const source = f.catalog.source(goal.id, {
      title: `Authored contrast: ${entry.name}`,
      rights: "user_provided",
      rightsBasis: "Original evaluation fixture; not an actual exam.",
    });
    f.sources.commit(
      source.id,
      await f.sources.prepare(source.id, {
        text: entry.stem + "\nAnswer key:\n" + entry.key,
      }),
    );
    const segment = f.catalog.segments(source.id)[0]!;
    const qe = { segmentId: segment.id, quote: entry.stem },
      ae = { segmentId: segment.id, quote: entry.key };
    const q = f.catalog.createQuestion({
      goalId: goal.id,
      scopeId: scope.id,
      type: "short",
      stem: entry.stem,
      modelAnswer: entry.answer,
      rubric: [
        {
          id: "result",
          description: `Requested result: ${entry.answer}`,
          points: 1,
        },
      ],
      origin: "external_practice",
      conceptIds: [scope.concepts[0]!.id],
      evidence: [qe, ae],
      sourceMatch: {
        questionReference: "1.",
        answerReference: "1.",
        questionEvidence: qe,
        answerEvidence: ae,
        edition: null,
        editionEvidence: [],
      },
    });
    const job = f.jobs.enqueue("verify_question", { questionId: q.id });
    await f.jobs.tick();
    const result = f.jobs.get(job.id);
    assert.equal(result.status, "succeeded", JSON.stringify(result.error));
    const saved = f.catalog.readQuestion(q.id);
    const issueMatches = saved.review.sourceCheck?.issues.some(
      (i: any) => i.kind === entry.issue,
    );
    const passed = saved.status === entry.expected && issueMatches;
    report.cases.push({
      ...entry,
      questionId: q.id,
      status: saved.status,
      review: saved.review,
      passed,
    });
    save();
    console.log(
      `${entry.name}: ${saved.status} (${passed ? "PASS" : "MISMATCH"})`,
    );
  }
  report.passed = report.cases.every((c: any) => c.passed);
  if (!report.passed) process.exitCode = 1;
} catch (e) {
  report.passed = false;
  report.error = e instanceof Error ? e.message : String(e);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  save();
  await f.app.close();
  console.log(`Finished: ${report.passed ? "PASS" : "STOPPED"}; ${reportPath}`);
}
