// Explicit, resumable live evaluation. Never uses the existing study-room DB.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexAgent, type AgentPort } from "../src/agent.js";
import { createApp } from "../src/app.js";
import { Fault } from "../src/core.js";
import { latestMaterials } from "../src/materials.js";
import { materialGoals } from "./fixtures/material-goals.js";

const arg = (name: string) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");
if (!process.argv.includes("--live")) {
  console.log(
    "No AI calls. Use --live [--only=astronomy,css,statistics] [--phase=research|generate|extract|all] [--resume=<evaluation-directory>] [--rediscover] [--refresh-scope] [--refresh-control] [--max-calls=40].",
  );
  process.exit(0);
}
const selected = arg("only")?.split(",");
assert.ok(
  !selected?.some((id) => !materialGoals.some((g) => g.id === id)),
  "Unknown goal",
);
const cases = materialGoals.filter((c) => !selected || selected.includes(c.id));
const phase = arg("phase") ?? "all";
assert.ok(["all", "research", "generate", "extract"].includes(phase));
const maxCalls = Number(arg("max-calls") ?? 40);
assert.ok(Number.isInteger(maxCalls) && maxCalls >= 1 && maxCalls <= 100);
const resume = arg("resume");
const dataDir = resume
  ? resolve(resume)
  : mkdtempSync(join(tmpdir(), "study-cafe-live-materials-"));
const reportPath = join(dataDir, "materials-report.json");
if (resume)
  assert.ok(
    existsSync(reportPath),
    "Only a marked live-materials evaluation directory can be resumed",
  );
const report: any = resume
  ? JSON.parse(readFileSync(reportPath, "utf8"))
  : {
      marker: "study-cafe-live-materials-v1",
      startedAt: new Date().toISOString(),
      accountType: "chatgpt",
      model: "existing configuration, no override",
      effort: "medium",
      goals: {},
      calls: [],
      sessions: [],
    };
assert.equal(report.marker, "study-cafe-live-materials-v1");
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2));
save();
const session: any = {
  startedAt: new Date().toISOString(),
  phase,
  selected: cases.map((c) => c.id),
  maxCalls,
  calls: 0,
};
report.sessions.push(session);
let activeCase = "setup";
let providerFailure: unknown;
const real = new CodexAgent({
  cwd: join(dataDir, "agent-work"),
  timeoutMs: 240_000,
});
const agent: AgentPort = {
  async ask(role, input: any, schema, options) {
    if (providerFailure) throw providerFailure;
    if (session.calls >= maxCalls)
      throw new Fault(
        429,
        "LIVE_CALL_BUDGET",
        "Live evaluation call budget reached",
      );
    session.calls++;
    const started = Date.now();
    const call: any = {
      caseId: activeCase,
      role,
      startedAt: new Date().toISOString(),
      searchEvents: 0,
    };
    if (input.materials)
      call.materials = input.materials.map((m: any) => ({
        segmentId: m.segmentId,
        sourceId: m.sourceId,
        url: m.url,
        chars: m.text.length,
      }));
    console.log(`[${activeCase}] ${role} (${session.calls}/${maxCalls})`);
    try {
      if (input.materials && input.goal) {
        call.materialGoalIds = [
          ...new Set(
            input.materials.map(
              (m: any) =>
                f.store.one(
                  "SELECT src.goal_id FROM segments seg JOIN source_revisions r ON r.id=seg.revision_id JOIN sources src ON src.id=r.source_id WHERE seg.id=?",
                  m.segmentId,
                )?.goal_id,
            ),
          ),
        ];
        assert.deepEqual(
          call.materialGoalIds,
          [input.goal.id],
          "Model input must not contain another goal's material",
        );
      }
      const output = await real.ask(role, input, schema, {
        ...options,
        onProgress(event) {
          call.searchEvents++;
          options?.onProgress?.(event);
        },
      });
      call.output = output;
      return output;
    } catch (error) {
      call.error =
        error instanceof Fault
          ? { code: error.code, message: error.message, details: error.details }
          : { message: String(error) };
      if (error instanceof Fault && error.code.startsWith("CODEX_"))
        providerFailure = error;
      throw error;
    } finally {
      call.elapsedMs = Date.now() - started;
      report.calls.push(call);
      save();
      console.log(
        `[${activeCase}] ${role}: ${call.error ? JSON.stringify(call.error) : "completed"} (${(call.elapsedMs / 1000).toFixed(1)}s)`,
      );
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
  autoWorker: false,
  token: "live-materials-fixture",
});
async function run(state: any, key: string, kind: string, input: any) {
  let job = state[key] ? f.jobs.get(state[key]) : null;
  if (!job) {
    job = f.jobs.enqueue(kind, input);
    state[key] = job.id;
    save();
  } else if (["failed", "waiting_user", "paused"].includes(job.status))
    job = f.jobs.resume(job.id);
  const deadline = Date.now() + 20 * 60_000;
  while (["queued", "running"].includes(job.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    job = f.jobs.get(job.id);
  }
  if (["queued", "running"].includes(job.status)) {
    f.jobs.cancel(job.id);
    throw new Error("Evaluation deadline exceeded");
  }
  state[key + "Result"] = job;
  save();
  assert.equal(
    job.status,
    "succeeded",
    `${kind}: ${JSON.stringify(job.error)}`,
  );
  return job.result;
}
console.log(`Report: ${reportPath}`);
try {
  const account = await real.status();
  assert.ok(
    account.authenticated && account.type === "chatgpt",
    "Existing ChatGPT login required; no API billing fallback",
  );
  // All goals coexist so isolation checks can detect cross-goal evidence.
  for (const c of materialGoals) {
    if (report.goals[c.id]) {
      if (process.argv.includes("--refresh-scope") && cases.includes(c)) {
        const state = report.goals[c.id];
        assert.ok(
          !state.examId && !state.paperId,
          "Do not change a scope after generating evaluation questions",
        );
        const scope = f.catalog.scope(state.goalId, {
          title: c.title,
          concepts: [{ name: c.concept, area: c.area }],
          references: c.references,
        });
        (state.scopeHistory ??= []).push(state.scopeId);
        state.scopeId = scope.id;
        state.referenceSupplement = c.references;
        save();
      }
      continue;
    }
    const goal = f.catalog.goal({
      title: c.title,
      kind: c.kind,
      level: "기초",
      description:
        c.detail +
        " 이번 자료 조사는 본문 수집 가능한 설명 자료 1~2개만 찾습니다. 참고 URL이 적합하면 그대로 활용하고 이용 근거를 확인하세요. 기존 연습문제 모음 전체 수집은 이번 조사 범위에서 제외합니다. 한국어 문제를 원합니다.",
    });
    const scope = f.catalog.scope(goal.id, {
      title: c.title,
      concepts: [{ name: c.concept, area: c.area }],
      references: c.references,
    });
    report.goals[c.id] = { goalId: goal.id, scopeId: scope.id };
    save();
  }
  if (["all", "research"].includes(phase))
    for (const c of cases) {
      activeCase = c.id;
      const state = report.goals[c.id];
      if (process.argv.includes("--rediscover") && state.researchJob) {
        (state.researchHistory ??= []).push({
          jobId: state.researchJob,
          result: state.researchJobResult,
          sources: state.sources,
        });
        delete state.researchJob;
        delete state.researchJobResult;
        save();
      }
      await run(state, "researchJob", "research", { goalId: state.goalId });
      state.sources = f.store
        .all("SELECT id FROM sources WHERE goal_id=?", state.goalId)
        .map((r) => {
          const source = f.catalog.readSource(r.id);
          return {
            id: source.id,
            title: source.title,
            url: source.url,
            kind: source.kind,
            rights: source.rights,
            status: source.status,
            segments: f.catalog.segments(source.id).length,
          };
        });
      save();
      console.log(`[${c.id}] research: ${JSON.stringify(state.sources)}`);
    }
  if (["all", "generate"].includes(phase))
    for (const c of cases) {
      activeCase = c.id;
      const state = report.goals[c.id];
      const materials = latestMaterials(f.catalog, state.goalId);
      assert.ok(
        materials.length,
        `${c.id}: research has no usable source text; inspect acquisition instead of substituting invented text`,
      );
      if (!state.examId) {
        const template = f.exams.template({
          name: "실제 자료 생성 표본",
          total: 4,
          single: 2,
          multiple: 1,
          short: 1,
          policy: "ai_only",
        });
        state.examId = f.exams.create(state.goalId, template.id).id;
        save();
      }
      await run(state, "prepareJob", "prepare_exam", { examId: state.examId });
      const exam = f.exams.get(state.examId, true);
      assert.equal(exam.status, "ready");
      assert.equal(exam.items.length, 4);
      assert.deepEqual(exam.items.map((q: any) => q.type).sort(), [
        "multiple",
        "short",
        "single",
        "single",
      ]);
      for (const q of exam.items) {
        assert.equal(q.goalId, state.goalId);
        assert.equal(q.scopeId, state.scopeId);
        assert.equal(q.origin, "ai_generated");
        assert.equal(q.sourceMatch, null);
        for (const e of q.evidence) {
          const m = materials.find((m) => m.segmentId === e.segmentId);
          assert.ok(
            m?.text.includes(e.quote),
            "Evidence must be exact and from this goal's acquired material",
          );
          assert.ok(m?.url, "Generation must use actual downloaded sources");
        }
        const current = f.catalog.readQuestion(q.id);
        assert.equal(current.status, "usable");
      }
      state.generated = exam.items;
      state.generationPassed = true;
      save();
      console.log(`[${c.id}] generated and independently verified: 4/4`);
    }
  if (["all", "extract"].includes(phase))
    for (const c of cases) {
      activeCase = c.id;
      const state = report.goals[c.id];
      // Authored controls test extraction/edition mapping; they are not web finds.
      if (process.argv.includes("--refresh-control") && state.paperId) {
        state.controlHistory ??= [];
        state.controlHistory.push({
          paperId: state.paperId,
          jobId: state.extractJob,
          result: state.extractJobResult,
          question: state.extractedControl,
          passed: state.extractionPassed ?? false,
        });
        delete state.paperId;
        delete state.extractJob;
        delete state.extractJobResult;
        delete state.extractedControl;
        delete state.extractionPassed;
        save();
      }
      if (!state.paperId) {
        const answerSource = f.catalog.source(state.goalId, {
          title: "직접 작성한 검증 정답표",
          kind: "user_material",
          rights: "user_provided",
          rightsBasis: "Authored evaluation control",
        });
        f.sources.commit(
          answerSource.id,
          await f.sources.prepare(answerSource.id, { text: c.answers }),
        );
        const paper = f.catalog.source(state.goalId, {
          title: "직접 작성한 검증 문제",
          kind: "user_material",
          rights: "user_provided",
          rightsBasis: "Authored evaluation control",
          answerSourceIds: [answerSource.id],
        });
        f.sources.commit(
          paper.id,
          await f.sources.prepare(paper.id, { text: c.paper }),
        );
        state.paperId = paper.id;
        save();
      }
      const result = await run(state, "extractJob", "extract_questions", {
        sourceId: state.paperId,
      });
      if (result.questionIds?.[0]) {
        state.extractedControl = f.catalog.readQuestion(result.questionIds[0]);
        save();
      }
      assert.equal(result.count, 1, JSON.stringify(result));
      assert.equal(result.usable, 1, JSON.stringify(result));
      const question = state.extractedControl;
      assert.equal(question.origin, "external_practice");
      assert.equal(
        question.choices.find((v: any) => v.id === question.answer[0])?.text,
        c.expectedAnswer,
      );
      assert.ok(question.sourceMatch?.edition);
      state.extractedControl = question;
      state.extractionPassed = true;
      save();
      console.log(`[${c.id}] authored extraction control: 1/1`);
    }
  session.passed = true;
} catch (error) {
  session.passed = false;
  session.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(session.error);
} finally {
  session.finishedAt = new Date().toISOString();
  save();
  await f.app.close();
  console.log(
    `Finished: ${session.passed ? "PASS" : "STOPPED"}; report=${reportPath}`,
  );
}
