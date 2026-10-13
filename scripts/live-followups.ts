import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createApp } from "../src/app.js";

export async function runFollowups(
  service: Awaited<ReturnType<typeof createApp>>,
) {
  const goalId = service.store.one(
    "SELECT id FROM goals ORDER BY created_at LIMIT 1",
  ).id;
  assert.equal(service.catalog.readGoal(goalId).title, "Python 반복문 기초");
  async function done(jobId: string) {
    for (let i = 0; i < 1200; i++) {
      const job = service.jobs.get(jobId);
      if (!["queued", "running"].includes(job.status)) {
        assert.equal(job.status, "succeeded", JSON.stringify(job.error));
        return job.result;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Followup job timeout");
  }
  const template = service.exams.template({
    name: "오답 순환 연결 검사",
    total: 1,
    single: 1,
    short: 0,
    policy: "mixed",
  });
  const exam = service.exams.create(goalId, template.id);
  service.exams.finalize(exam.id);
  const question = service.exams.get(exam.id, true).items[0];
  const wrongChoice = question.choices.find(
    (choice: any) => !question.answer.includes(choice.id),
  );
  assert.ok(wrongChoice);
  const attempt = service.exams.start(exam.id);
  service.exams.saveAnswer(attempt.id, 1, {
    value: [wrongChoice.id],
    version: 0,
    flagged: false,
    uncertain: false,
    hintUsed: false,
    recall: null,
  });
  service.learning.submit(attempt.id, "followups-wrong");
  assert.equal(service.learning.result(attempt.id).earned, 0);
  const note = await done(
    service.jobs.enqueue("summarize_wrong", { goalId }).id,
  );
  assert.ok(note.concepts.length > 0);
  assert.ok(
    note.concepts.some((item: any) => item.attemptIds.includes(attempt.id)),
  );
  console.log("Live wrong-answer summary: OK");
  const variant = await done(
    service.jobs.enqueue("generate_variant", { questionId: question.id }).id,
  );
  assert.equal(variant.status, "usable", JSON.stringify(variant.review));
  assert.equal(variant.origin, "ai_variant");
  assert.equal(variant.parentId, question.id);
  assert.equal(variant.familyId, question.familyId);
  console.log("Live variant generation and review: OK");
  assert.ok(
    service.store.one(
      "SELECT COUNT(*) n FROM review_states WHERE goal_id=?",
      goalId,
    ).n > 0,
  );
  return [
    {
      name: "live_wrong_summary",
      passed: true,
      concepts: note.concepts.length,
    },
    { name: "live_variant_and_schedule", passed: true },
  ];
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const reportFile = process.argv[2] ?? "live-smoke-result.json";
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  assert.equal(
    report.full,
    true,
    "Requires a full synthetic live smoke report",
  );
  assert.ok(!report.error, "Original smoke must have passed");
  const service = await createApp({
    dataDir: report.dataDir,
    autoWorker: false,
  });
  try {
    report.checks.push(...(await runFollowups(service)));
    writeFileSync(reportFile, JSON.stringify(report, null, 2));
  } finally {
    await service.app.close();
  }
}
