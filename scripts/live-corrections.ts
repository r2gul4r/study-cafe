// Opt-in: existing ChatGPT login only. Copies a marked PDF evaluation, never a user room.
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { CodexAgent, type AgentPort } from "../src/agent.js";
import { createApp } from "../src/app.js";

if (!process.argv.includes("--live")) {
  console.log(
    "No calls. Use --live --pdf-dir=<marked PDF evaluation directory>. Four real reviews; existing ChatGPT login only.",
  );
  process.exit(0);
}
const sourceDir = resolve(
  process.argv.find((a) => a.startsWith("--pdf-dir="))?.slice(10) ?? "",
);
const pdfReport = JSON.parse(
  readFileSync(join(sourceDir, "pdf-report.json"), "utf8"),
);
assert.equal(pdfReport.marker, "study-cafe-live-pdf-v1");
assert.ok(
  !existsSync(join(sourceDir, "study-cafe.db-wal")) ||
    statSync(join(sourceDir, "study-cafe.db-wal")).size === 0,
  "Close the PDF evaluation before copying it",
);
const dataDir = mkdtempSync(join(tmpdir(), "study-cafe-live-corrections-"));
cpSync(join(sourceDir, "study-cafe.db"), join(dataDir, "study-cafe.db"));
cpSync(join(sourceDir, "assets"), join(dataDir, "assets"), { recursive: true });
const reportPath = join(dataDir, "corrections-report.json");
const report: any = {
  marker: "study-cafe-live-corrections-v1",
  startedAt: new Date().toISOString(),
  scope:
    "One real public MIT PDF intermediate error plus one authored wrong-final-answer contrast; four independent Codex reviews. No user room data.",
  sourcePdfSession: pdfReport.sessions.at(-1),
  codeHashes: Object.fromEntries(
    ["corrections", "catalog", "source-quality", "workflows"].map((n) => [
      n,
      createHash("sha256")
        .update(readFileSync(new URL(`../src/${n}.ts`, import.meta.url)))
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
  async ask(role, input: any, schema, options) {
    assert.equal(role, "verify_question");
    assert.ok(report.calls.length < 4, "Bounded live call budget");
    const call: any = {
      role,
      revisionId: input.question.revisionId,
      startedAt: new Date().toISOString(),
      images: (options?.images ?? []).map((i) => ({
        ...JSON.parse(i.label),
        sha256: createHash("sha256").update(readFileSync(i.path)).digest("hex"),
      })),
    };
    report.calls.push(call);
    save();
    console.log(`Real correction review ${report.calls.length}/4`);
    const started = Date.now();
    try {
      const output = await real.ask(role, input, schema, options);
      call.output = output;
      return output;
    } catch (e) {
      call.error = (e as Error).message;
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
const token = "correction-fixture";
const f = await createApp({ dataDir, token, autoWorker: false, agent });
const post = async (path: string, body: unknown, expected = 200) => {
  const res = await f.app.inject({
    method: "POST",
    url: `/api${path}`,
    headers: { authorization: `Bearer ${token}` },
    payload: body as any,
  });
  assert.equal(res.statusCode, expected, res.body);
  return res.json();
};
const verify = async (q: any) => {
  const job = await post(`/questions/${q.id}/verify`, {}, 202);
  await f.jobs.tick();
  assert.equal(
    f.jobs.get(job.id).status,
    "succeeded",
    JSON.stringify(f.jobs.get(job.id).error),
  );
  return f.catalog.readQuestion(q.id);
};
const evidence = (q: any) =>
  q.review.sourceCheck.issues
    .filter((i: any) => i.kind === "answer_error")
    .map(
      (i: any) =>
        q.evidence.find(
          (e: any) =>
            e.segmentId === i.evidence.segmentId &&
            e.quote.includes(i.evidence.quote),
        ) ?? i.evidence,
    );
const correction = (
  q: any,
  reason: string,
  explanation: string,
  answer = q.modelAnswer,
) => ({
  expectedRevisionId: q.revisionId,
  reason,
  evidence: q.review.answerCorrection?.evidence ?? evidence(q),
  answer: q.answer,
  modelAnswer: answer,
  rubric: q.rubric,
  explanation,
});
console.log(`Report: ${reportPath}`);
try {
  const account = await real.status();
  assert.ok(account.authenticated && account.type === "chatgpt");
  const original = f.catalog
    .listQuestions(pdfReport.goalId, { limit: 300 })
    .items.find(
      (q: any) =>
        q.sourceMatch?.questionReference.includes("6") &&
        q.review?.sourceCheck?.issues.some(
          (i: any) => i.kind === "answer_error",
        ),
    );
  assert.ok(
    original,
    "Fresh page-8 extraction must have retained a complete held Q6",
  );
  const unchangedSource = JSON.stringify(
    f.catalog.questionEvidence(original.id),
  );
  const pdfCase: any = { name: "MIT_18_05_Q6", original, stages: [] };
  report.cases.push(pdfCase);
  save();
  const draft = await post(
    `/questions/${original.id}/corrections`,
    correction(
      original,
      "원본 분산의 중간 계산 10^5를 10^6으로 정정한다. 최종 확률과 문제의 요구, 배점은 유지한다.",
      "원본 정답표의 Var(S)=20×5×10^4=10^5는 곱셈 오류이다. 정확한 분산은 1,000,000=10^6이며 표준편차는 1000이다. 독립인 20일 총생산량의 평균은 10000이다. 중심극한정리로 P(S>10500)≈1−Φ((10500−10000)/1000)=1−Φ(0.5)=0.3085. 원본의 최종 확률은 맞다. 이 정정은 중간 등식을 바로잡는 별도 해설이며, 문제에서 요구한 확률만 맞게 답해도 만점을 준다.",
    ),
  );
  assert.equal(draft.status, "needs_review");
  pdfCase.stages.push({ stage: "draft", question: draft });
  await post(
    `/questions/${draft.id}/corrections/confirm`,
    {
      revisionId: draft.revisionId,
      reviewToken: draft.correctionReviewToken,
      reason: "premature",
    },
    400,
  );
  const checked = await verify(draft);
  pdfCase.stages.push({ stage: "verified_pending_human", question: checked });
  save();
  assert.equal(checked.status, "needs_review");
  assert.equal(
    checked.review.answerCorrection.verification.passed,
    true,
    JSON.stringify(checked.review),
  );
  assert.equal(
    JSON.stringify(f.catalog.questionEvidence(original.id)),
    unchangedSource,
  );
  assert.equal(
    f.catalog.readQuestion(original.id, original.revisionId).explanation,
    original.explanation,
  );
  pdfCase.passed = true;
  pdfCase.awaitingBrowserConfirmation = true;

  const goal = f.catalog.goal({
    title: "정답 정정 대조 검증",
    kind: "general",
  });
  const scope = f.catalog.scope(goal.id, {
    title: "산술",
    concepts: [{ name: "덧셈", area: "수" }],
  });
  const source = f.catalog.source(goal.id, {
    title: "직접 작성한 오류 정답표",
    rights: "user_provided",
    rightsBasis: "Authored evaluation fixture, not a real exam.",
  });
  const stem = "1. Compute 2 + 2. Give only the result.",
    key = "1. Solution: 2 + 2 = 5. Final answer: 5.";
  f.sources.commit(
    source.id,
    await f.sources.prepare(source.id, { text: stem + "\n" + key }),
  );
  const segment = f.catalog.segments(source.id)[0]!;
  const qe = { segmentId: segment.id, quote: stem },
    ae = { segmentId: segment.id, quote: key };
  const item = f.catalog.createQuestion({
    goalId: goal.id,
    scopeId: scope.id,
    type: "short",
    stem,
    modelAnswer: "5",
    explanation: key,
    rubric: [
      {
        id: "r",
        description:
          "문제에서 요구한 합의 정확한 값을 제시한다. 설명은 요구하지 않는다.",
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
  const held = await verify(item);
  assert.equal(held.status, "needs_review");
  const contrast: any = {
    name: "authored_wrong_final_answer",
    original: held,
    stages: [],
  };
  report.cases.push(contrast);
  save();
  const bad = await post(
    `/questions/${item.id}/corrections`,
    correction(
      held,
      "제안된 수정값 6의 타당성을 검사한다.",
      "원본 5 대신 합을 6으로 정정한다. 2+2=6이다.",
      "6",
    ),
  );
  const refused = await verify(bad);
  contrast.stages.push({
    stage: "incorrect_correction_refused",
    question: refused,
  });
  save();
  assert.equal(refused.review.answerCorrection.verification.passed, false);
  await post(
    `/questions/${item.id}/corrections/confirm`,
    {
      revisionId: refused.revisionId,
      reviewToken: refused.correctionReviewToken,
      reason: "incorrect draft",
    },
    400,
  );
  const good = await post(
    `/questions/${item.id}/corrections`,
    correction(
      refused,
      "2에 2를 더하면 4이다. 원본 정답표의 5를 4로 정정한다.",
      "원본은 2+2=5라고 쓰였으나 정확한 합은 4이다. 문제는 결과만 요구하므로 4와 동등한 값에 만점을 주고 설명은 요구하지 않는다.",
      "4",
    ),
  );
  const approved = await verify(good);
  contrast.stages.push({
    stage: "corrected_pending_human",
    question: approved,
  });
  save();
  assert.equal(approved.status, "needs_review");
  assert.equal(
    approved.review.answerCorrection.verification.passed,
    true,
    JSON.stringify(approved.review),
  );
  const confirmed = await post(`/questions/${item.id}/corrections/confirm`, {
    revisionId: approved.revisionId,
    reviewToken: approved.correctionReviewToken,
    reason: "원본 5, 오정정 6, 올바른 합 4를 대조하여 확정했다.",
  });
  assert.equal(confirmed.status, "usable");
  assert.equal(
    f.catalog.readQuestion(item.id, held.revisionId).modelAnswer,
    "5",
  );
  assert.equal(
    f.catalog.readQuestion(item.id, bad.revisionId).modelAnswer,
    "6",
  );
  contrast.stages.push({ stage: "human_confirmed", question: confirmed });
  contrast.passed = true;
  report.passed = report.cases.every((c: any) => c.passed);
} catch (e) {
  report.passed = false;
  report.error = (e as Error).message;
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  save();
  await f.app.close();
  console.log(`Finished: ${report.passed ? "PASS" : "STOPPED"}; ${reportPath}`);
}
