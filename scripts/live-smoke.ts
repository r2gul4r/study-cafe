import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CodexAgent } from "../src/agent.js";
import { createApp } from "../src/app.js";
import { fetchPublic } from "../src/sources.js";
import { runFollowups } from "./live-followups.js";
const dataDir = mkdtempSync(join(tmpdir(), "study-cafe-live-"));
const full = process.argv.includes("--full");
const agent = new CodexAgent({
  cwd: join(dataDir, "agent-work"),
  timeoutMs: 180000,
});
const service = await createApp({
  dataDir,
  agent,
  token: "live-smoke-local",
  autoWorker: false,
});
const report: any = { dataDir, full, checks: [] };
console.log(`Temporary verification data: ${dataDir}`);
service.jobs.on("event", (jobId: string) => {
  const job = service.jobs.get(jobId);
  if (job.kind === "prepare_exam") {
    const count = service.exams.get(job.input.examId).items.length;
    if (count !== report.prepared) {
      report.prepared = count;
      console.log(`Prepared: ${count}/${full ? 25 : 2}`);
    }
  }
});
async function jobDone(id: string) {
  for (let i = 0; i < (full ? 10800 : 1200); i++) {
    const job = service.jobs.get(id);
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Live job timeout");
}
agent.on("notification", (msg: any) => {
  if (msg.method === "error")
    console.error(
      JSON.stringify({
        providerError: msg.params?.error?.codexErrorInfo,
        message: String(msg.params?.error?.message ?? "")
          .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
          .slice(0, 1200),
      }),
    );
});
try {
  const status = await agent.status();
  if (!status.authenticated)
    throw new Error("Existing Codex login is required.");
  report.checks.push({ name: "codex_account", passed: true });
  console.log("Codex account: OK");
  const network = await fetchPublic("https://example.com");
  if (network.bytes.length === 0) throw new Error("Empty network response");
  report.checks.push({
    name: "public_http_download",
    passed: true,
    mime: network.mime,
    bytes: network.bytes.length,
  });
  console.log("Public download: OK");
  let searches = 0;
  const searched = await agent.ask(
    "research_probe",
    {
      instruction:
        "Use web search to find the official Python tutorial page on for statements. Return its actual URL and title. Do not run shell commands.",
    },
    z.object({ url: z.url(), title: z.string() }).strict(),
    { search: true, onProgress: () => searches++ },
  );
  if (!new URL(searched.url).hostname.endsWith("python.org") || searches === 0)
    throw new Error("Search was not verified");
  report.checks.push({
    name: "codex_live_search",
    passed: true,
    events: searches,
    url: searched.url,
  });
  console.log("Codex live search: OK");
  const goal = service.catalog.goal({ title: "Python 반복문 기초" });
  const scope = service.catalog.scope(goal.id, {
    title: "반복문",
    concepts: [{ name: "for 반복문", area: "Python" }],
  });
  const source = service.catalog.source(goal.id, {
    title: "자체 작성 검증 자료",
    kind: "user_material",
    rights: "user_provided",
    rightsBasis: "study-cafe test author",
  });
  const original =
    "Python의 for 문은 리스트 같은 iterable의 항목을 차례로 변수에 대입하고 본문을 실행한다. for x in [1, 2, 3]은 세 번 실행된다. range(3)은 0, 1, 2를 차례로 제공한다. break는 현재 반복문을 종료하고 continue는 현재 반복의 나머지를 건너뛰고 다음 반복으로 이동한다. 빈 리스트를 순회하면 반복문 본문은 한 번도 실행되지 않는다. range(a, b)는 a 이상 b 미만의 정수를 제공한다. range(a, b, s)는 간격 s로 이동하고 s가 양수면 b 미만, 음수면 b 초과 값을 제공한다. range의 간격은 0일 수 없다. 반복 시작 전 total=0으로 두고 매 반복에서 total += x를 실행하면 모든 x의 합을 구한다. count=0으로 시작하여 조건을 만족할 때만 count += 1을 실행하면 조건에 맞는 원소 수를 센다. 이중 반복문에서 바깥이 2회, 매번 안쪽이 3회 실행되면 안쪽 본문은 6회 실행된다. break는 가장 안쪽의 반복문 하나만 종료한다. for문의 else절은 break 없이 반복이 완료되면 실행되며 빈 iterable이어도 실행된다. enumerate(items)는 기본적으로 0부터 시작하는 인덱스와 항목의 쌍을 제공한다. enumerate(items, start=1)은 인덱스를 1부터 시작한다. zip(a, b)는 같은 위치 항목을 쌍으로 묶으며 기본적으로 짧은 쪽이 끝나면 중단된다. 문자열을 순회하면 한 문자씩 얻는다. 딕셔너리를 직접 순회하면 키를 얻고 items()를 순회하면 키와 값의 쌍을 얻는다. sorted(items)는 정렬된 새 리스트를 만들고 원래 리스트는 변경하지 않는다. 리스트 내포 [x*2 for x in values if x>0]은 양수인 원소만 골라 두 배로 한 새 리스트를 만든다. 반복 안에서 만들어진 변수는 같은 함수 범위에서 반복 뒤에도 남으며 빈 반복에서는 대입이 실행되지 않는다. 반복 중 순회하는 원래 리스트를 수정하면 원소를 건너뛸 수 있으므로 복사본을 순회하거나 새 리스트를 만드는 편이 명확하다.";
  service.sources.commit(
    source.id,
    await service.sources.prepare(source.id, { text: original }),
  );
  const template = service.exams.template({
    name: "실제 모델 연결 검증",
    total: full ? 25 : 2,
    single: full ? 20 : 1,
    short: full ? 5 : 1,
    policy: "ai_only",
  });
  const exam = service.exams.create(goal.id, template.id);
  const preparation = await jobDone(
    service.jobs.enqueue("prepare_exam", { examId: exam.id }).id,
  );
  if (preparation.status !== "succeeded")
    throw new Error(JSON.stringify(preparation.error));
  report.checks.push({
    name: "live_generate_and_verify",
    passed: true,
    count: preparation.result.items.length,
  });
  console.log("Live generated and reviewed questions: OK");
  const attempt = service.exams.start(exam.id);
  const fixed = service.exams.get(exam.id, true);
  for (const item of fixed.items)
    service.exams.saveAnswer(attempt.id, item.slot, {
      value: item.type === "short" ? item.modelAnswer : item.answer,
      version: 0,
      flagged: false,
      uncertain: false,
      hintUsed: false,
      recall: null,
    });
  service.learning.submit(attempt.id, "live-smoke");
  const grading = await jobDone(
    service.jobs.enqueue("grade_attempt", { attemptId: attempt.id }).id,
  );
  if (grading.status !== "succeeded" || grading.result.pending)
    throw new Error(JSON.stringify(grading.error ?? grading.result));
  report.checks.push({
    name: "live_rubric_grading",
    passed: true,
    earned: grading.result.earned,
    possible: grading.result.totalPossible,
  });
  console.log("Live written-answer grading: OK");
  if (full) report.checks.push(...(await runFollowups(service)));
} catch (e) {
  report.error = e instanceof Error ? e.message : String(e);
  process.exitCode = 1;
  console.error(report.error);
} finally {
  await service.app.close();
  writeFileSync("live-smoke-result.json", JSON.stringify(report, null, 2));
}
