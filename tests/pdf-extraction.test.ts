import test from "node:test";
import { cleanSourceCheck } from "./helpers/source-quality.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createApp } from "../src/app.js";
import {
  documentEdges,
  validateExtraction,
  withExtractionEvidence,
  type Material,
} from "../src/materials.js";
import type { AgentPort } from "../src/agent.js";
import { Fault, questionInput } from "../src/core.js";

test("short-answer format feedback identifies fields without echoing answer content", () => {
  const q = {
    goalId: "g",
    scopeId: "s",
    type: "short",
    stem: "Question",
    origin: "external_practice",
    conceptIds: ["c"],
    modelAnswer: "private answer text",
    points: 5,
    rubric: [{ id: "r", description: "Result", points: 2 }],
    answer: ["incorrect-slot"],
    choices: [],
  };
  const parsed = questionInput.safeParse(q);
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => i.message).join(" ");
    assert.match(message, /choices와 answer는 빈 배열/);
    assert.match(message, /합계\(2\).*points\(5\)/);
    assert.doesNotMatch(message, /private answer text|incorrect-slot/);
  }
});

test("subquestion references use actual printed anchors and retain parent evidence", () => {
  const paper = {
    segmentId: "paper",
    sourceId: "source",
    revisionId: "paper-rev",
    text: "Problem 2. Context. (a) Compute a value. Session 2030",
  } as Material;
  const answers = {
    segmentId: "answers",
    sourceId: "answer-source",
    revisionId: "answer-rev",
    text: "Problem 2. (a) Solution: 5. Session 2030",
  } as Material;
  const qe = {
    segmentId: "paper",
    quote: "Problem 2. Context. (a) Compute a value.",
  };
  const ae = { segmentId: "answers", quote: "Problem 2. (a) Solution: 5." };
  const editions = [paper, answers].map((m) => ({
    segmentId: m.segmentId,
    quote: "Session 2030",
  }));
  const q = questionInput.parse({
    goalId: "g",
    scopeId: "s",
    type: "short",
    stem: "(a) Compute a value.",
    passage: "Context.",
    modelAnswer: "5",
    rubric: [{ id: "value", description: "5", points: 1 }],
    origin: "external_practice",
    conceptIds: ["c"],
    evidence: [qe, ae, ...editions],
    sourceMatch: {
      questionReference: "(a)",
      answerReference: "(a)",
      questionEvidence: qe,
      answerEvidence: ae,
      edition: "Session 2030",
      editionEvidence: editions,
    },
  });
  assert.doesNotThrow(() =>
    validateExtraction(q, { kind: "external_practice" }, [paper], [answers]),
  );
  const assembled = withExtractionEvidence({ ...q, evidence: [] });
  assert.equal(assembled.evidence.length, 4);
  assert.doesNotThrow(() =>
    validateExtraction(
      assembled,
      { kind: "external_practice" },
      [paper],
      [answers],
    ),
  );
  assert.deepEqual(withExtractionEvidence(assembled), assembled);
  const invented = withExtractionEvidence({
    ...q,
    evidence: [],
    sourceMatch: {
      ...q.sourceMatch!,
      answerEvidence: { ...ae, quote: "(a) Invented answer: 999." },
    },
  });
  assert.throws(
    () =>
      validateExtraction(
        invented,
        { kind: "external_practice" },
        [paper],
        [answers],
      ),
    /원문과 다른 인용/,
  );
  const composite = {
    ...q,
    sourceMatch: {
      ...q.sourceMatch!,
      questionReference: "Problem 2. (a)",
      answerReference: "Problem 2. (a)",
    },
  };
  assert.throws(
    () =>
      validateExtraction(
        composite,
        { kind: "external_practice" },
        [paper],
        [answers],
      ),
    /番号|번호/,
  );
});

test("document identity context keeps both ends per source within its source limit", () => {
  const rows = Array.from({ length: 6 }, (_, source) =>
    Array.from(
      { length: 3 },
      (_, n) =>
        ({ segmentId: `${source}-${n}`, sourceId: `${source}` }) as Material,
    ),
  ).flat();
  assert.deepEqual(
    documentEdges(rows).map((m) => m.segmentId),
    ["0-0", "0-2", "1-0", "1-2", "2-0", "2-2", "3-0", "3-2", "4-0", "4-2"],
  );
  assert.deepEqual(documentEdges([rows[0]!]), [rows[0]]);
});

test("re-extraction reuses a unique printed stem without merging ambiguous repeated subparts", async (t) => {
  const f = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "study-pdf-repeat-")),
    token: "test",
    autoWorker: false,
  });
  t.after(() => f.app.close());
  const g = f.catalog.goal({ title: "Reimport" });
  const scope = f.catalog.scope(g.id, {
    title: "Scope",
    concepts: [{ name: "Values", area: "General" }],
  });
  const source = f.catalog.source(g.id, {
    title: "Paper",
    rights: "user_provided",
    rightsBasis: "authored test",
  });
  const text =
    "Section A. Shared context. 1. Compute 2+2. Answer: 4.\nSection B. Value is 4. (a) Compute a value. Answer: 4.\nSection C. Value is 5. (a) Compute a value. Answer: 5.";
  f.sources.commit(source.id, await f.sources.prepare(source.id, { text }));
  const e = { segmentId: f.catalog.segments(source.id)[0]!.id, quote: text };
  const q = {
    goalId: g.id,
    scopeId: scope.id,
    type: "short",
    stem: "1. Compute 2+2.",
    passage: "Section A. Shared context.",
    modelAnswer: "4",
    rubric: [{ id: "value", description: "Result", points: 1 }],
    origin: "external_practice",
    conceptIds: [scope.concepts[0]!.id],
    evidence: [e],
    sourceMatch: {
      questionReference: "1.",
      answerReference: "1.",
      questionEvidence: e,
      answerEvidence: e,
      edition: null,
      editionEvidence: [],
    },
  };
  const first = f.catalog.createQuestion(q);
  const repeated = f.catalog.createQuestion({
    ...q,
    passage: "Shared context.",
    modelAnswer: "Do not replace the saved answer",
  });
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.modelAnswer, "4");
  const subpart = {
    ...q,
    stem: "(a) Compute a value.",
    sourceMatch: {
      ...q.sourceMatch,
      questionReference: "(a)",
      answerReference: "(a)",
    },
  };
  const second = f.catalog.createQuestion({
    ...subpart,
    passage: "Section B. Value is 4.",
  });
  const third = f.catalog.createQuestion({
    ...subpart,
    passage: "Section C. Value is 5.",
    modelAnswer: "5",
  });
  assert.notEqual(second.id, third.id);
});

async function pdf(pages: string[]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages)
    doc
      .addPage()
      .drawText(text, { font, x: 30, y: 760, size: 12, lineHeight: 20 });
  return Buffer.from(await doc.save()).toString("base64");
}

test("real PDF ingestion exposes back-matter edition evidence without extracting context-only questions", async (t) => {
  let verified = 0;
  let retried = false;
  const agent: AgentPort = {
    async ask(role, raw: any, schema) {
      if (role === "extract_existing_questions") {
        assert.equal(raw.segments.length, 1);
        for (const m of [
          ...raw.segments,
          ...raw.adjacentSegments,
          ...raw.sourceContext,
          ...raw.answerSegments,
        ]) {
          assert.equal(m.locator.boxes, undefined);
          assert.equal(typeof m.locator.pdfPage, "number");
          assert.equal(typeof m.locator.charStart, "number");
        }
        const paperFooter = [
          ...raw.segments,
          ...raw.adjacentSegments,
          ...raw.sourceContext,
        ].find(
          (m: any) =>
            raw.sourceContextIds.includes(m.segmentId) &&
            m.text.includes("Session 2030"),
        );
        const answerFooter = raw.answerSegments.find((m: any) =>
          m.text.includes("Session 2030"),
        );
        assert.equal(paperFooter.locator.pdfPage, 5);
        assert.equal(answerFooter.locator.pdfPage, 5);
        const body = raw.segments.find((m: any) =>
          m.text.includes("1. Which value is central?"),
        );
        if (!body) return schema.parse({ questions: [], unresolved: [] });
        const continuation = raw.adjacentSegments.find((m: any) =>
          m.text.includes("Shared continuation"),
        );
        assert.equal(continuation.locator.pdfPage, 3);
        if (!retried) {
          retried = true;
          throw new Fault(
            422,
            "AGENT_OUTPUT_INVALID",
            "Invalid short-answer points",
          );
        }
        assert.match(raw.previousFailure, /Invalid short-answer points/);
        const answer = raw.answerSegments.find((m: any) =>
          m.text.includes("1. Answer: a"),
        );
        const qe = { segmentId: body.segmentId, quote: body.text };
        const ae = { segmentId: answer.segmentId, quote: answer.text };
        const editions = [paperFooter, answerFooter].map((m) => ({
          segmentId: m.segmentId,
          quote: "Session 2030",
        }));
        const q = {
          goalId: raw.goal.id,
          scopeId: raw.scope.id,
          type: "single",
          origin: "external_practice",
          conceptIds: [raw.scope.concepts[0].id],
          stem: "Which value is central?",
          passage: "Shared continuation",
          choices: [
            { id: "a", text: "Middle" },
            { id: "b", text: "Maximum" },
          ],
          answer: ["a"],
          evidence: [
            qe,
            ae,
            ...editions,
            { segmentId: continuation.segmentId, quote: "Shared continuation" },
          ],
          sourceMatch: {
            questionReference: "1.",
            answerReference: "1.",
            questionEvidence: qe,
            answerEvidence: ae,
            edition: "Session 2030",
            editionEvidence: editions,
          },
        };
        // A footer is supplied as context, but must not become an extra batch.
        const fakeQe = {
          segmentId: paperFooter.segmentId,
          quote: "99. Which value is central? a. Middle b. Maximum",
        };
        const fakeAe = {
          segmentId: answerFooter.segmentId,
          quote: "99. Answer: a",
        };
        const contextOnly = {
          ...q,
          evidence: [fakeQe, fakeAe, ...editions],
          sourceMatch: {
            ...q.sourceMatch,
            questionReference: "99.",
            answerReference: "99.",
            questionEvidence: fakeQe,
            answerEvidence: fakeAe,
          },
        };
        return schema.parse({ questions: [q, contextOnly], unresolved: [] });
      }
      assert.equal(role, "verify_question");
      verified++;
      assert.equal(raw.question.sourceMatch.questionReference, "1.");
      assert.equal(
        raw.materials.filter((m: any) => m.text.includes("Session 2030"))
          .length,
        2,
      );
      return schema.parse({
        usable: true,
        evidenceValid: true,
        answerValid: true,
        rubricCheck: null,
        reason: "Both PDF editions and printed answer match",
        sourceCheck: cleanSourceCheck(),
      });
    },
    async status() {
      return {};
    },
    async login() {
      return {};
    },
    async models() {
      return [];
    },
    async close() {},
  };
  const f = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "study-pdf-edges-")),
    token: "test",
    autoWorker: false,
    agent,
  });
  t.after(() => f.app.close());
  const goal = f.catalog.goal({ title: "PDF source test" });
  f.catalog.scope(goal.id, {
    title: "Central values",
    concepts: [{ name: "Median", area: "Statistics" }],
  });
  const answer = f.catalog.source(goal.id, {
    title: "Answers",
    rights: "user_provided",
    rightsBasis: "authored test",
  });
  const paper = f.catalog.source(goal.id, {
    title: "Paper",
    kind: "external_practice",
    rights: "user_provided",
    rightsBasis: "authored test",
    answerSourceIds: [answer.id],
  });
  for (const [source, pages] of [
    [
      paper,
      [
        "Paper cover",
        "1. Which value is central?\na. Middle\nb. Maximum",
        "Shared continuation",
        "Notes",
        "Session 2030\n99. Which value is central? a. Middle b. Maximum",
      ],
    ],
    [
      answer,
      [
        "Answer cover",
        "1. Answer: a",
        "Notes",
        "Notes",
        "Session 2030\n99. Answer: a",
      ],
    ],
  ] as const) {
    f.sources.commit(
      source.id,
      await f.sources.prepare(source.id, {
        base64: await pdf([...pages]),
        mime: "application/pdf",
      }),
    );
    assert.equal(f.catalog.segments(source.id).length, 5);
    assert.ok(f.catalog.segments(source.id)[0]!.locator.boxes.length > 0);
  }
  const job = f.jobs.enqueue("extract_questions", { sourceId: paper.id });
  await f.jobs.tick();
  const done = f.jobs.get(job.id);
  assert.equal(done.status, "succeeded", JSON.stringify(done.error));
  assert.equal(done.result.usable, 1);
  assert.equal(done.result.count, 1);
  assert.equal(done.result.unresolved.length, 1);
  assert.match(done.result.unresolved[0].reason, /이번 원문 구간/);
  assert.equal(verified, 1);
});

for (const code of ["AGENT_OUTPUT_INVALID", "CODEX_RATE_LIMITED"]) {
  test(`PDF extraction bounds retries and preserves failure: ${code}`, async (t) => {
    let calls = 0;
    const agent: AgentPort = {
      async ask() {
        calls++;
        throw new Fault(422, code, "evaluation failure");
      },
      async status() {
        return {};
      },
      async login() {
        return {};
      },
      async models() {
        return [];
      },
      async close() {},
    };
    const f = await createApp({
      dataDir: mkdtempSync(join(tmpdir(), "study-extract-retry-")),
      token: "test",
      autoWorker: false,
      agent,
    });
    t.after(() => f.app.close());
    const g = f.catalog.goal({ title: "Extraction failure" });
    f.catalog.scope(g.id, {
      title: "Scope",
      concepts: [{ name: "Concept", area: "General" }],
    });
    const s = f.catalog.source(g.id, {
      title: "Paper",
      rights: "user_provided",
      rightsBasis: "authored test",
    });
    f.sources.commit(
      s.id,
      await f.sources.prepare(s.id, {
        text: "1. A question without any generated replacement.",
      }),
    );
    const job = f.jobs.enqueue("extract_questions", { sourceId: s.id });
    await f.jobs.tick();
    assert.equal(f.jobs.get(job.id).status, "failed");
    assert.equal(f.jobs.get(job.id).error.code, code);
    assert.equal(calls, code === "AGENT_OUTPUT_INVALID" ? 2 : 1);
    assert.equal(f.catalog.listQuestions(g.id, {}).total, 0);
  });
}

for (const scenario of ["resume", "repeated_page"] as const) {
  test(`bounded extraction pagination preserves progress: ${scenario}`, async (t) => {
    let calls = 0;
    const seenSizes: number[] = [];
    const agent: AgentPort = {
      async ask(role, input: any, schema) {
        if (role === "verify_question")
          return schema.parse({
            usable: true,
            evidenceValid: true,
            answerValid: true,
            rubricCheck: null,
            reason: "Verified fixture",
            sourceCheck: cleanSourceCheck(),
          });
        calls++;
        seenSizes.push(input.processed.length);
        if (scenario === "resume" && calls === 2)
          throw new Fault(429, "CODEX_USAGE_LIMIT", "fixture limit");
        const indexes =
          scenario === "repeated_page"
            ? [1]
            : input.processed.length
              ? [3]
              : [1, 2];
        const questions = indexes.map((i) => {
          const e = {
            segmentId: input.segments[0].segmentId,
            quote: `${i}. Question ${i}? a. Yes b. No Answer: a.`,
          };
          return {
            goalId: input.goal.id,
            scopeId: input.scope.id,
            type: "single",
            stem: `Question ${i}?`,
            choices: [
              { id: "a", text: "Yes" },
              { id: "b", text: "No" },
            ],
            answer: ["a"],
            conceptIds: [input.scope.concepts[0].id],
            origin: "external_practice",
            evidence: [e],
            sourceMatch: {
              questionReference: `${i}.`,
              answerReference: `${i}.`,
              questionEvidence: e,
              answerEvidence: e,
              edition: null,
              editionEvidence: [],
            },
          };
        });
        return schema.parse({
          questions,
          unresolved: [],
          hasMore: scenario === "repeated_page" || input.processed.length === 0,
        });
      },
      async status() {
        return {};
      },
      async login() {
        return {};
      },
      async models() {
        return [];
      },
      async close() {},
    };
    const f = await createApp({
      dataDir: mkdtempSync(join(tmpdir(), "study-pdf-page-")),
      token: "test",
      autoWorker: false,
      agent,
    });
    t.after(() => f.app.close());
    const g = f.catalog.goal({ title: "Pagination" });
    f.catalog.scope(g.id, {
      title: "Scope",
      concepts: [{ name: "Concept", area: "General" }],
    });
    const src = f.catalog.source(g.id, {
      title: "Paper",
      rights: "user_provided",
      rightsBasis: "authored test",
    });
    f.sources.commit(
      src.id,
      await f.sources.prepare(src.id, {
        text: [1, 2, 3]
          .map((i) => `${i}. Question ${i}? a. Yes b. No Answer: a.`)
          .join("\n"),
      }),
    );
    const j = f.jobs.enqueue("extract_questions", { sourceId: src.id });
    await f.jobs.tick();
    if (scenario === "resume") {
      assert.equal(f.jobs.get(j.id).error.code, "CODEX_USAGE_LIMIT");
      assert.equal(f.catalog.listQuestions(g.id, {}).total, 2);
      f.jobs.resume(j.id);
      await f.jobs.tick();
      assert.deepEqual(seenSizes, [0, 2, 2]);
      assert.equal(f.jobs.get(j.id).result.usable, 3);
    } else {
      assert.deepEqual(seenSizes, [0, 1]);
      assert.equal(f.jobs.get(j.id).result.usable, 1);
      assert.match(f.jobs.get(j.id).result.unresolved[0].reason, /진전되지/);
    }
    assert.equal(f.jobs.get(j.id).status, "succeeded");
  });
}
