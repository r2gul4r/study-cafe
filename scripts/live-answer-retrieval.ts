// Opt-in only: existing ChatGPT login, isolated marked DB, bounded calls.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { CodexAgent, type AgentPort } from "../src/agent.js";
import { createApp } from "../src/app.js";
import {
  latestMaterials,
  selectMaterials,
  documentEdges,
  type Material,
} from "../src/materials.js";
import { AnswerIndex } from "../src/answer-retrieval.js";

const option = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!process.argv.includes("--live")) {
  console.log(
    "No calls. Use --live [--cases=single,numeric,section,continuation,edition,pdf] [--resume=<marked directory>] [--max-calls=14]. Existing ChatGPT login only.",
  );
  process.exit(0);
}
const resume = option("resume"),
  maxCalls = Number(option("max-calls") ?? 14);
assert.ok(Number.isInteger(maxCalls) && maxCalls >= 1 && maxCalls <= 20);
const selectedCases = (
  option("cases") ?? "single,numeric,section,continuation,edition,pdf"
).split(",");
assert.ok(
  selectedCases.every((c) =>
    ["single", "numeric", "section", "continuation", "edition", "pdf"].includes(
      c,
    ),
  ),
);
const dataDir = resume
  ? resolve(resume)
  : mkdtempSync(join(tmpdir(), "study-cafe-live-answer-search-"));
const reportPath = join(dataDir, "answer-search-report.json");
if (resume) assert.ok(existsSync(reportPath));
const report: any = resume
  ? JSON.parse(readFileSync(reportPath, "utf8"))
  : {
      marker: "study-cafe-live-answer-search-v1",
      startedAt: new Date().toISOString(),
      cases: {},
      sessions: [],
      calls: [],
    };
assert.equal(report.marker, "study-cafe-live-answer-search-v1");
const session: any = {
  index: report.sessions.length,
  startedAt: new Date().toISOString(),
  maxCalls,
  calls: 0,
  codeHashes: Object.fromEntries(
    ["answer-retrieval", "workflows"].map((name) => [
      name,
      createHash("sha256")
        .update(readFileSync(new URL(`../src/${name}.ts`, import.meta.url)))
        .digest("hex"),
    ]),
  ),
};
report.sessions.push(session);
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2));
const real = new CodexAgent({
  cwd: join(dataDir, "agent-work"),
  timeoutMs: 240000,
});
let active = "setup",
  stopped: unknown;
const agent: AgentPort = {
  async ask(role, input: any, schema, options) {
    if (stopped) throw stopped;
    assert.ok(session.calls < maxCalls, "Live call budget exhausted");
    session.calls++;
    const call: any = {
      session: session.index,
      case: active,
      role,
      startedAt: new Date().toISOString(),
      answerRetrieval: input.answerRetrieval ?? null,
      suppliedAnswers: (input.answerSegments ?? []).map((m: Material) => ({
        segmentId: m.segmentId,
        ordinal: m.ordinal,
        pdfPage: m.locator.pdfPage,
      })),
      imageCount: options?.images?.length ?? 0,
    };
    report.calls.push(call);
    save();
    console.log(`[${active}] ${role} ${session.calls}/${maxCalls}`);
    const started = Date.now();
    try {
      const output: any = await real.ask(role, input, schema, options);
      // Full output remains in the isolated job DB. The export has only audit metadata.
      call.output =
        role === "extract_existing_questions"
          ? {
              questionCount: output.questions.length,
              hasMore: output.hasMore,
              answerSearch: output.answerSearch,
              unresolved: output.unresolved,
            }
          : {
              usable: output.usable,
              evidenceValid: output.evidenceValid,
              answerValid: output.answerValid,
              reason: output.reason,
              sourceCheck: output.sourceCheck,
              visualCheck: output.visualCheck,
            };
      return output;
    } catch (e) {
      call.error = String(e);
      stopped = e;
      throw e;
    } finally {
      call.elapsedMs = Date.now() - started;
      save();
      console.log(
        `[${active}] finished in ${Math.round(call.elapsedMs / 1000)}s`,
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
  token: "answer-search-fixture",
  agent,
  autoWorker: false,
});
const chunk = (text: string) => (text + "\n").padEnd(8000, " ");
const definitions = {
  edition: {
    title: "Spectrum comparison",
    concept: "Wavelength",
    edition: "Optics Lagoon 2045",
    number: "3",
    question:
      "3. Which colour has the shortest wavelength?\nA Red\nB Blue\nC Green",
    answer: "3 | B",
    segments: 80,
    at: 66,
  },
  single: {
    title: "Visible spectrum",
    concept: "Wavelength",
    edition: "Optics Fern 2044",
    number: "3",
    question:
      "3. Which colour has the shortest wavelength?\nA Red\nB Blue\nC Green",
    answer: "3 | B",
    segments: 80,
    at: 66,
  },
  numeric: {
    title: "Visible light",
    concept: "Wavelength",
    edition: "Optics Cedar 2041",
    number: "117",
    question:
      "117. Which colour has the shortest wavelength?\nA Red\nB Blue\nC Green",
    answer: "117 | B",
    segments: 80,
    at: 65,
  },
  section: {
    title: "English past tense",
    concept: "Past tense of go",
    edition: "Language Orchid 2042",
    number: "7",
    question:
      "Section Starlight\n7. Select the past tense of 'go'.\nA goed\nB went\nC going",
    answer: "Section Starlight\n7 | B",
    segments: 72,
    at: 61,
  },
  continuation: {
    title: "Linear equations",
    concept: "Solve a linear equation",
    edition: "Algebra River 2043",
    number: "41",
    question: "41. Solve 3x = 12. Give only the value of x.",
    answer:
      "41. Divide both sides of 3x = 12 by 3. The final value continues in the next archive segment.",
    segments: 96,
    at: 83,
  },
};
const course =
  "https://ocw.mit.edu/courses/6-042j-mathematics-for-computer-science-fall-2010/";
async function prepareCase(name: string) {
  if (report.cases[name]) return report.cases[name];
  const def =
    name === "pdf"
      ? { title: "Finite directed graphs", concept: "Cycles and longest paths" }
      : definitions[name as keyof typeof definitions];
  const goal = f.catalog.goal({ title: def.title });
  f.catalog.scope(goal.id, {
    title: def.title,
    concepts: [{ name: def.concept, area: def.title }],
  });
  const pdf = name === "pdf";
  const provenance =
    "MIT OCW 6.042J Fall 2010 exam archive, 2008 final exam, Tom Leighton and Marten van Dijk; " +
    course +
    "pages/exams/";
  const sourceFields = pdf
    ? {
        kind: "past_exam",
        rights: "allowed",
        rightsBasis:
          "CC BY-NC-SA 4.0; https://ocw.mit.edu/pages/privacy-and-terms-of-use/",
        examEvidence: provenance,
      }
    : {
        kind: "external_practice",
        rights: "user_provided",
        rightsBasis: "Original evaluation fixture; not a real exam.",
      };
  const answer = f.catalog.source(goal.id, {
    ...sourceFields,
    title: def.title + " answers",
    ...(pdf
      ? {
          url:
            course +
            "f2742c4fd6fcac9d60a74ee610e126f1_MIT6_042JF10_fnl_2008_sol.pdf",
        }
      : {}),
  });
  const paper = f.catalog.source(goal.id, {
    ...sourceFields,
    title: def.title + " questions",
    answerSourceIds: [answer.id],
    ...(pdf
      ? {
          url:
            course +
            "7a388c9bc011b32657aba364ef3ed10d_MIT6_042JF10_final_2008.pdf",
        }
      : {}),
  });
  for (const source of [answer, paper]) {
    let input: { text?: string } = {};
    if (!pdf) {
      const d = definitions[name as keyof typeof definitions];
      input = {
        text:
          source.id === paper.id
            ? `${d.edition}\n${d.question}`
            : Array.from({ length: d.segments }, (_, i) => {
                if (name === "edition" && i === 44)
                  return chunk(
                    d.edition +
                      ". This edition applies to all answer entries in this archive.",
                  );
                if (i === 0 || i === d.segments - 1)
                  return chunk(
                    name === "edition"
                      ? "Answer archive. Edition identity is printed inside the archive."
                      : d.edition + ". Answer archive.",
                  );
                if (i === d.at)
                  return chunk(
                    name === "single" || name === "edition"
                      ? d.answer
                      : d.edition + "\n" + d.answer,
                  );
                if (name === "continuation" && i === d.at + 1)
                  return chunk(
                    "Thus x = 4. This is the final value for the preceding calculation.",
                  );
                if (name === "section" && i < 15)
                  return chunk(
                    d.edition + `\nSection Daylight\n7 | C\n${i + 1000} | A`,
                  );
                return chunk(
                  `${i + 1000} | A\n${i + 2000} | D\nArchive entry.`,
                );
              }).join(""),
      };
    }
    const prepared = await f.sources.prepare(source.id, input);
    f.sources.commit(source.id, prepared);
    if (pdf)
      writeFileSync(
        join(dataDir, source.id === paper.id ? "paper.pdf" : "answers.pdf"),
        Buffer.from(prepared.file.base64, "base64"),
      );
  }
  const state = {
    goalId: goal.id,
    paperId: paper.id,
    answerId: answer.id,
    ...(pdf
      ? { pdfPages: [17], provenance, license: sourceFields.rightsBasis }
      : {}),
  };
  report.cases[name] = state;
  save();
  return state;
}
console.log(`Report: ${reportPath}`);
try {
  const status = await real.status();
  assert.ok(
    status.authenticated && status.type === "chatgpt",
    "Existing ChatGPT login required; no paid API fallback",
  );
  for (active of selectedCases) {
    const state = await prepareCase(active);
    const materials = latestMaterials(f.catalog, state.goalId),
      pool = materials.filter((m) => m.sourceId === state.answerId);
    const question = materials.find(
      (m) =>
        m.sourceId === state.paperId &&
        (!state.pdfPages || state.pdfPages.includes(m.locator.pdfPage)),
    )!;
    const old = [
      ...new Map(
        [
          ...documentEdges(pool),
          ...selectMaterials(pool, question.text, {
            maxSegments: 7,
            maxChars: 56000,
          }),
          ...pool,
        ].map((m) => [m.segmentId, m]),
      ).values(),
    ].slice(0, 10);
    const current = new AnswerIndex(pool).search(question.text, {
      context: question.text,
    });
    const targetOrdinal =
      active === "pdf"
        ? 12
        : definitions[active as keyof typeof definitions].at;
    state.retrievalComparison = {
      totalSegments: pool.length,
      expectedAnchorOrdinal: targetOrdinal,
      oldSelectedOrdinals: old.map((m) => m.ordinal),
      oldContainsTarget: old.some((m) => m.ordinal === targetOrdinal),
      newSelectedOrdinals: current.materials.map((m) => m.ordinal),
      newContainsTarget: current.materials.some(
        (m) => m.ordinal === targetOrdinal,
      ),
    };
    assert.ok(state.retrievalComparison.newContainsTarget);
    let job = state.jobId ? f.jobs.get(state.jobId) : null;
    if (job && process.argv.includes("--new-extraction")) {
      state.previousRuns = [
        ...(state.previousRuns ?? []),
        {
          job,
          questionAudit: state.questionAudit,
          passed: state.passed ?? false,
        },
      ];
      delete state.questionAudit;
      delete state.passed;
      job = null;
    }
    if (!job) {
      job = f.jobs.enqueue("extract_questions", {
        sourceId: state.paperId,
        ...(state.pdfPages ? { pdfPages: state.pdfPages } : {}),
      });
      state.jobId = job.id;
      save();
    } else if (["failed", "paused", "waiting_user"].includes(job.status))
      f.jobs.resume(job.id);
    if (f.jobs.get(job.id).status !== "succeeded") await f.jobs.tick();
    const done = f.jobs.get(job.id);
    state.result = done;
    save();
    assert.equal(done.status, "succeeded", JSON.stringify(done.error));
    assert.equal(done.result.count, 1, JSON.stringify(done.result));
    // An actual public source is not assumed mathematically correct. Retrieval
    // is successful when exact linked evidence is found and reviewed; preserve
    // a substantive source-quality hold rather than weakening the verifier.
    if (active !== "pdf")
      assert.equal(done.result.usable, 1, JSON.stringify(done.result));
    assert.equal(done.result.unresolved.length, 0, JSON.stringify(done.result));
    const q = f.catalog.readQuestion(done.result.questionIds[0]);
    if (active === "pdf") {
      const review = report.calls.findLast(
        (c: any) =>
          c.case === "pdf" && c.role === "verify_question" && !c.error,
      )?.output;
      assert.equal(review?.evidenceValid, true);
      assert.equal(review?.visualCheck?.faithful, true);
      assert.equal(review?.visualCheck?.complete, true);
      assert.equal(review?.visualCheck?.noAnswerLeak, true);
    }
    if (active === "pdf" && q.status !== "usable") {
      assert.equal(q.status, "needs_review");
      assert.ok(
        q.review.sourceCheck?.issues.length,
        "A held public source must have a recorded source audit",
      );
      state.sourceQualityHold = {
        reason: q.review.reason,
        issues: q.review.sourceCheck.issues,
      };
    }
    const matched = pool.find(
      (m) => m.segmentId === q.sourceMatch?.answerEvidence.segmentId,
    )!;
    assert.equal(matched.ordinal, targetOrdinal);
    if (
      active === "single" ||
      active === "numeric" ||
      active === "section" ||
      active === "edition"
    )
      assert.match(
        q.choices.find((c: any) => q.answer.includes(c.id))!.text,
        active === "section" ? /went/i : /Blue/i,
      );
    if (active === "continuation") {
      assert.match(q.modelAnswer, /4/);
      assert.ok(q.sourceMatch.answerContinuationEvidence.length);
    }
    state.questionAudit = {
      id: q.id,
      status: q.status,
      answerAnchorOrdinal: matched.ordinal,
      continuationCount: q.sourceMatch.answerContinuationEvidence.length,
      answerImageHidden: q.visualEvidence
        .filter((v: any) => v.role === "answer")
        .every((v: any) => !q.requiredAssetIds.includes(v.assetId)),
      citationsExact: q.evidence.every((e: any) =>
        materials.some(
          (m) => m.segmentId === e.segmentId && m.text.includes(e.quote),
        ),
      ),
    };
    assert.equal(state.questionAudit.citationsExact, true);
    assert.equal(state.questionAudit.answerImageHidden, true);
    state.passed = true;
    save();
    console.log(`[${active}] PASS`);
  }
  session.passed = true;
} catch (e) {
  session.error = String(e);
  process.exitCode = 1;
  console.error(e);
} finally {
  session.endedAt = new Date().toISOString();
  save();
  await f.app.close();
}
