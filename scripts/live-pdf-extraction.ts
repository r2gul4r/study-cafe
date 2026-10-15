// Opt-in evaluation of actual public PDFs; never opens a user study-room DB.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { CodexAgent, type AgentPort } from "../src/agent.js";
import { createApp } from "../src/app.js";
import { Fault, questionInput } from "../src/core.js";
import {
  latestMaterials,
  validateExtraction,
  withExtractionEvidence,
} from "../src/materials.js";

const option = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!process.argv.includes("--live")) {
  console.log(
    "No network or AI calls. Use --live [--phase=ingest|extract|recheck|audit|all] [--resume=<evaluation-directory>] [--new-extraction] [--pages=2,6,7,8] [--max-calls=30]. audit is local only; recheck replays saved real outputs through evidence assembly then calls Codex review.",
  );
  process.exit(0);
}
const phase = option("phase") ?? "all";
assert.ok(["ingest", "extract", "recheck", "audit", "all"].includes(phase));
const maxCalls = Number(option("max-calls") ?? 30);
assert.ok(Number.isInteger(maxCalls) && maxCalls >= 1 && maxCalls <= 100);
const resume = option("resume");
if (["audit", "recheck"].includes(phase))
  assert.ok(resume, "audit requires an existing evaluation directory");
const dataDir = resume
  ? resolve(resume)
  : mkdtempSync(join(tmpdir(), "study-cafe-live-pdf-"));
const reportPath = join(dataDir, "pdf-report.json");
if (resume)
  assert.ok(
    existsSync(reportPath),
    "Only a marked PDF evaluation can be resumed",
  );
const report: any = resume
  ? JSON.parse(readFileSync(reportPath, "utf8"))
  : {
      marker: "study-cafe-live-pdf-v1",
      startedAt: new Date().toISOString(),
      accountType: "chatgpt",
      model: "existing configuration, no override",
      effort: "medium",
      sources: {},
      calls: [],
      sessions: [],
    };
assert.equal(report.marker, "study-cafe-live-pdf-v1");
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2));
const session: any = {
  index: report.sessions.length,
  startedAt: new Date().toISOString(),
  phase,
  maxCalls,
  calls: 0,
  pdfPages: option("pages")?.split(",").map(Number) ?? null,
  workflowHash: createHash("sha256")
    .update(readFileSync(new URL("../src/workflows.ts", import.meta.url)))
    .digest("hex"),
};
report.sessions.push(session);
save();
const course =
  "https://ocw.mit.edu/courses/18-05-introduction-to-probability-and-statistics-spring-2022/";
const license = "https://ocw.mit.edu/pages/privacy-and-terms-of-use/";
const provenance = `${course}pages/exams/ lists Exam 1 separately from practice exams and links its solutions. MIT 18.05, Spring 2022. Authors Jeremy Orloff and Jennifer French Kamrin.`;
const real = new CodexAgent({
  cwd: join(dataDir, "agent-work"),
  timeoutMs: 240_000,
});
let stopped: unknown;
const agent: AgentPort = {
  async ask(role, input: any, schema, options) {
    if (stopped) throw stopped;
    if (session.calls >= maxCalls)
      throw new Fault(
        429,
        "LIVE_CALL_BUDGET",
        "Evaluation call budget reached",
      );
    session.calls++;
    const started = Date.now();
    const call: any = {
      session: session.index,
      role,
      startedAt: new Date().toISOString(),
      searchEvents: 0,
      inputBytes: Buffer.byteLength(JSON.stringify(input)),
      questionId: input.question?.id ?? null,
      questionRevisionId: input.question?.revisionId ?? null,
      images: (options?.images ?? []).map((image) => ({
        ...JSON.parse(image.label),
        sha256: createHash("sha256")
          .update(readFileSync(image.path))
          .digest("hex"),
      })),
    };
    for (const name of [
      "segments",
      "adjacentSegments",
      "sourceContext",
      "answerSegments",
      "materials",
    ]) {
      if (input[name])
        call[name] = input[name].map((m: any) => ({
          segmentId: m.segmentId,
          pdfPage: m.locator?.pdfPage,
          chars: m.text.length,
        }));
    }
    save(); // Persist the attempt count even if the process is interrupted.
    console.log(`${role} (${session.calls}/${maxCalls})`);
    // Diagnostics contain event types and counts only, never reasoning text.
    call.events = {};
    call.streamedCharacters = 0;
    let answerPrefix = "",
      answerTail = "";
    const progress = (message: any) => {
      call.events[message.method] = (call.events[message.method] ?? 0) + 1;
      call.lastEvent = message.method;
      if (typeof message.params?.delta === "string")
        call.streamedCharacters += message.params.delta.length;
      if (
        message.method === "item/agentMessage/delta" &&
        typeof message.params?.delta === "string"
      ) {
        answerPrefix = (answerPrefix + message.params.delta).slice(0, 6000);
        answerTail = (answerTail + message.params.delta).slice(-6000);
      }
    };
    real.on("notification", progress);
    const timer = setInterval(() => {
      session.activeCall = {
        role,
        elapsedMs: Date.now() - started,
        lastEvent: call.lastEvent,
        streamedCharacters: call.streamedCharacters,
      };
      save();
      console.log(`Progress: ${JSON.stringify(session.activeCall)}`);
      writeFileSync(
        join(dataDir, "partial-answer.json"),
        JSON.stringify({
          role,
          elapsedMs: Date.now() - started,
          prefix: answerPrefix,
          tail: answerTail,
        }),
      );
    }, 30_000);
    try {
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
        stopped = error;
      throw error;
    } finally {
      clearInterval(timer);
      real.off("notification", progress);
      delete session.activeCall;
      call.elapsedMs = Date.now() - started;
      report.calls.push(call);
      save();
      console.log(
        `${role}: ${call.error ? JSON.stringify(call.error) : "completed"} (${(call.elapsedMs / 1000).toFixed(1)}s)`,
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
  token: "live-pdf-fixture",
  autoWorker: false,
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    session.interrupted = true;
    save();
    void f.app.close();
  });
}
async function job(key: string, kind: string, input: any) {
  let value = report[key] ? f.jobs.get(report[key]) : null;
  if (!value) {
    value = f.jobs.enqueue(kind, input);
    report[key] = value.id;
    save();
  } else if (["failed", "waiting_user", "paused"].includes(value.status))
    value = f.jobs.resume(value.id);
  const deadline = Date.now() + 20 * 60_000;
  while (
    ["queued", "running"].includes(value.status) &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 250));
    value = f.jobs.get(value.id);
  }
  if (["queued", "running"].includes(value.status)) {
    f.jobs.cancel(value.id);
    throw new Error("Evaluation deadline exceeded");
  }
  report[key + "Result"] = value;
  save();
  assert.equal(
    value.status,
    "succeeded",
    `${kind}: ${JSON.stringify(value.error)}`,
  );
  return value.result;
}
console.log(`Report: ${reportPath}`);
try {
  if (["all", "extract", "recheck"].includes(phase)) {
    const account = await real.status();
    assert.ok(
      account.authenticated && account.type === "chatgpt",
      "Existing ChatGPT login required; no paid API fallback",
    );
  }
  if (!report.goalId) {
    const g = f.catalog.goal({
      title: "공개 확률·통계 시험의 문제 풀이",
      kind: "exam",
      level: "학부 기초",
      description:
        "MIT 18.05 Spring 2022 Exam 1의 확률, 경우의 수, 조건부 확률, 이산·연속 결합분포, 기댓값·분산·공분산과 중심극한정리를 학습한다. 원문 영어를 유지하고, 그림이나 수식 또는 정답 연결이 불확실하면 추측하지 말고 미해결로 보고한다.",
    });
    const s = f.catalog.scope(g.id, {
      title: "공개 시험 1 전체 범위",
      concepts: [{ name: "확률과 확률변수의 분포·통계량", area: "확률·통계" }],
      references: [course + "pages/exams/"],
    });
    report.goalId = g.id;
    report.scopeId = s.id;
    save();
  }
  if (["all", "ingest"].includes(phase)) {
    for (const key of ["answers", "paper"] as const) {
      if (!report.sources[key]) {
        const source = f.catalog.source(report.goalId, {
          title: `MIT 18.05 Spring 2022 Exam 1${key === "answers" ? " Solutions" : ""}`,
          url:
            course +
            (key === "answers"
              ? "mit18_05_s22_exam01_sol.pdf"
              : "mit18_05_s22_exam01.pdf"),
          publisher:
            "MIT OpenCourseWare; Jeremy Orloff and Jennifer French Kamrin",
          kind: key === "paper" ? "past_exam" : "reference",
          rights: "allowed",
          rightsBasis: `CC BY-NC-SA 4.0; attribution retained; noncommercial isolated evaluation; original PDFs not redistributed in Git. ${license}`,
          examEvidence: provenance,
          answerSourceIds: key === "paper" ? [report.sources.answers.id] : [],
        });
        report.sources[key] = { id: source.id };
        save();
      }
      await job(`ingest_${key}`, "ingest_source", {
        sourceId: report.sources[key].id,
      });
      const source = f.catalog.readSource(report.sources[key].id);
      const segments = f.catalog.segments(source.id);
      report.sources[key] = {
        ...source,
        pages: segments.map((s: any) => ({
          id: s.id,
          locator: s.locator,
          chars: s.text.length,
        })),
      };
      const revision = source.revisions.at(-1)!;
      const asset = f.store.get("assets", revision.assetId);
      const assetPath = join(dataDir, "assets", asset.hash);
      assert.ok(existsSync(assetPath));
      writeFileSync(join(dataDir, `${key}.pdf`), readFileSync(assetPath));
      writeFileSync(
        join(dataDir, `${key}-text.json`),
        JSON.stringify(segments, null, 2),
      );
      save();
      console.log(`${key}: ${segments.length} stored PDF segments`);
    }
  }
  if (["all", "extract"].includes(phase)) {
    assert.ok(
      report.sources.paper?.id && report.sources.answers?.id,
      "Ingest both original PDFs first",
    );
    if (process.argv.includes("--new-extraction") && report.extract) {
      assert.ok(
        !["queued", "running"].includes(f.jobs.get(report.extract).status),
        "Finish or cancel the previous extraction before starting another",
      );
      (report.extractionHistory ??= []).push({
        job: report.extract,
        result: report.extractResult,
        questions: report.questions,
      });
      delete report.extract;
      delete report.extractResult;
      save();
    }
    const result = await job("extract", "extract_questions", {
      sourceId: report.sources.paper.id,
      ...(option("pages")
        ? { pdfPages: option("pages")!.split(",").map(Number) }
        : {}),
    });
    report.questions = f.catalog.listQuestions(report.goalId, {
      limit: 300,
    }).items;
    session.result = result;
    console.log(`Extraction: ${JSON.stringify(result)}`);
    assert.ok(
      result.usable > 0,
      "No usable question; inspect unresolved reasons before claiming success",
    );
  }
  if (phase === "recheck") {
    const extraction = f.jobs.get(report.extract);
    assert.equal(extraction.status, "succeeded");
    if (report.recovery?.extractionJobId !== extraction.id) {
      if (report.recovery)
        (report.recoveryHistory ??= []).push(report.recovery);
      report.recovery = {
        extractionJobId: extraction.id,
        candidates: [],
        rejected: [],
        method:
          "Unmodified saved real Codex outputs -> server citation assembly -> exact-source validation -> fresh real Codex review",
      };
    }
    const pool = latestMaterials(f.catalog, report.goalId);
    const source = f.catalog.readSource(report.sources.paper.id);
    const calls = report.calls
      .map((call: any, index: number) => ({ call, index }))
      .filter(
        ({ call }: any) =>
          call.role === "extract_existing_questions" &&
          call.output &&
          call.startedAt >= extraction.createdAt &&
          call.startedAt <= extraction.updatedAt,
      );
    for (const { call, index } of calls) {
      const supplied = (names: string[]) =>
        new Set(
          names.flatMap((name) =>
            (call[name] ?? []).map((m: any) => m.segmentId),
          ),
        );
      const bodyIds = supplied([
        "segments",
        "adjacentSegments",
        "sourceContext",
      ]);
      const answerIds = supplied(["answerSegments"]);
      const body = pool.filter((m) => bodyIds.has(m.segmentId));
      const answers = pool.filter((m) => answerIds.has(m.segmentId));
      for (const [questionIndex, raw] of call.output.questions.entries()) {
        const q = questionInput.parse(raw);
        let rejectedBefore: any;
        try {
          validateExtraction(q, source, body, answers);
          continue;
        } catch (e) {
          if (!(e instanceof Fault)) throw e;
          rejectedBefore = { code: e.code, message: e.message };
        }
        const fixed = withExtractionEvidence(q);
        try {
          assert.equal(fixed.goalId, report.goalId);
          assert.equal(fixed.scopeId, report.scopeId);
          validateExtraction(fixed, source, body, answers);
          assert.ok(
            call.segments.some(
              (m: any) =>
                m.segmentId === fixed.sourceMatch!.questionEvidence.segmentId,
            ),
          );
        } catch (e) {
          if (!(e instanceof Fault)) throw e;
          if (
            !report.recovery.rejected.some(
              (v: any) =>
                v.callIndex === index && v.questionIndex === questionIndex,
            )
          )
            report.recovery.rejected.push({
              callIndex: index,
              questionIndex,
              reason: e.message,
            });
          continue;
        }
        const saved = f.catalog.createQuestion(fixed);
        if (
          !report.recovery.candidates.some(
            (v: any) => v.questionId === saved.id,
          )
        )
          report.recovery.candidates.push({
            callIndex: index,
            questionIndex,
            questionId: saved.id,
            rejectedBefore,
            rawOutputSha256: createHash("sha256")
              .update(JSON.stringify(raw))
              .digest("hex"),
          });
        save();
        await job(`recheck_${saved.id}`, "verify_question", {
          questionId: saved.id,
        });
      }
    }
    session.rechecked = report.recovery.candidates.length;
    save();
  }
  if (["all", "extract", "recheck", "audit"].includes(phase)) {
    const pool = latestMaterials(f.catalog, report.goalId);
    const paper = f.catalog.readSource(report.sources.paper.id);
    const body = pool.filter((m) => m.sourceId === paper.id);
    const answers = pool.filter(
      (m) => m.sourceId === report.sources.answers.id,
    );
    const stored = f.catalog.listQuestions(report.goalId, {
      limit: 300,
    }).items;
    const finalJob = f.jobs.get(report.extract);
    assert.equal(
      finalJob.status,
      "succeeded",
      "Finish the extraction before auditing it",
    );
    const currentIds = new Set(finalJob.result.questionIds);
    if (report.recovery?.extractionJobId === finalJob.id)
      for (const c of report.recovery.candidates) currentIds.add(c.questionId);
    const questions = stored.filter((q) => currentIds.has(q.id));
    assert.equal(questions.length, currentIds.size);
    const audited = questions.map((q) => {
      assert.equal(q.goalId, report.goalId);
      assert.equal(q.scopeId, report.scopeId);
      assert.equal(q.origin, "past_exam");
      validateExtraction(q, paper, body, answers);
      const citations = f.catalog.questionEvidence(q.id);
      assert.ok(citations.every((e: any) => e.text.includes(e.quote)));
      assert.equal(q.review.actor, "codex");
      return {
        id: q.id,
        revisionId: q.revisionId,
        status: q.status,
        reference: q.sourceMatch.questionReference,
        visualTranscription: q.visualTranscription ?? false,
        visualEvidence: q.visualEvidence ?? [],
        answerContinuationEvidence: (
          q.sourceMatch.answerContinuationEvidence ?? []
        ).map((e: any) => ({
          segmentId: e.segmentId,
          quoteHash: createHash("sha256").update(e.quote).digest("hex"),
        })),
        review: q.review,
        evidence: citations.map((e: any) => ({
          sourceId: e.sourceId,
          revisionId: e.sourceRevisionId,
          page: e.locator.pdfPage,
          role: e.role,
          quoteHash: createHash("sha256").update(e.quote).digest("hex"),
          exactQuote: true,
        })),
      };
    });
    assert.ok(
      audited.some((q) => q.status === "usable"),
      "No usable question for the structural audit",
    );
    report.audit = {
      at: new Date().toISOString(),
      structuralOnly: true,
      extractionJobId: finalJob.id,
      historicalCandidateCount: stored.length - questions.length,
      scope:
        "Exact wording/evidence, source and edition linkage, stored independent review. Manual content review is separate.",
      sources: ["paper", "answers"].map((key) => ({
        sourceId: report.sources[key].id,
        url: report.sources[key].url,
        pdfSha256: createHash("sha256")
          .update(readFileSync(join(dataDir, `${key}.pdf`)))
          .digest("hex"),
        pdfBytes: readFileSync(join(dataDir, `${key}.pdf`)).length,
        pages: [
          ...new Set(
            f.catalog
              .segments(report.sources[key].id)
              .map((s) => s.locator.pdfPage),
          ),
        ],
      })),
      questions: audited,
    };
    save();
    console.log(
      `Structural audit: ${audited.length} questions; ${audited.filter((q) => q.status === "usable").length} usable`,
    );
  }
  session.passed = true;
} catch (error) {
  session.passed = false;
  session.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(session.error);
} finally {
  report.questions = report.goalId
    ? f.catalog.listQuestions(report.goalId, {
        limit: 300,
      }).items
    : [];
  session.finishedAt = new Date().toISOString();
  save();
  await f.app.close();
  console.log(
    `Finished: ${session.passed ? "PASS" : "STOPPED"}; ${reportPath}`,
  );
}
