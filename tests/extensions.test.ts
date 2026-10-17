import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { Catalog } from "../src/catalog.js";
import { Exams, publicQuestion } from "../src/exams.js";
import { Learning } from "../src/learning.js";
import { Sources, extract } from "../src/sources.js";
import { reviewQueue } from "../src/reviews.js";
import { runPython, gradePython } from "../src/python.js";
import { backup, restoreBackup } from "../src/backup.js";
import { questionInput, templateInput } from "../src/core.js";
import { nearDuplicate } from "../src/question-similarity.js";
import { jobGuidance } from "../apps/web/src/job-guidance.js";
import {
  imageDeliveryPlan,
  validateDeliveredImages,
} from "../src/image-delivery.js";
import type { Material } from "../src/materials.js";
import { PDFDocument } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { createApp } from "../src/app.js";
import type { AgentPort } from "../src/agent.js";
import { pdfPageImage } from "../src/pdf-visuals.js";

test("Python runs real code and denies host filesystem, environment, subprocesses, and network", async () => {
  assert.equal(
    (await runPython("print(sum(map(int, input().split())))", "2 3", "5", 1000))
      .status,
    "passed",
  );
  for (const code of [
    'from js import Deno\nprint(Deno.readTextFileSync("package.json"))',
    'from js import Deno\nprint(Deno.env.get("SYSTEMROOT"))',
    `from js import Deno\nDeno.Command.new(${JSON.stringify(process.execPath.replaceAll("\\", "/"))}).outputSync()`,
    'from js import fetch\nawait fetch("http://127.0.0.1:4317/health")',
  ]) {
    const r = await runPython(code, "", "", 1000);
    assert.equal(r.status, "runtime_error", r.stderr);
    assert.match(r.stderr, /NotCapable|PermissionDenied/);
  }
  assert.equal(
    (await runPython("while True: pass", "", "", 1000)).status,
    "timeout",
  );
  assert.equal(
    (await runPython('print("x" * 100000)', "", "", 1000)).status,
    "output_limit",
  );
  assert.equal(
    (await runPython("print(4)", "", "5", 1000)).status,
    "wrong_output",
  );
});

test("image budget preserves anchors, different editions and rejects cached but undelivered evidence", () => {
  const ms: Material[] = Array.from({ length: 9 }, (_, i) => ({
    segmentId: `s${i}`,
    sourceId: "src",
    revisionId: i === 8 ? "other" : "rev",
    title: "PDF",
    kind: "reference",
    url: null,
    text: "page",
    locator: { pdfPage: i === 8 ? 1 : i + 1 },
    pageImage: { assetId: `cached${i}`, width: 20, height: 20 },
  }));
  const p = imageDeliveryPlan(ms, ["s0"], ["s7"]);
  assert.equal(p.pageCount, 4);
  assert.ok(p.selected.includes("s0") && p.selected.includes("s7"));
  const extra = imageDeliveryPlan(ms, ["s0"], ["s7"], ["s8"]);
  assert.ok(extra.selected.includes("s8"));
  assert.throws(
    () => imageDeliveryPlan(ms, ["s0"], [], ["foreign"]),
    /이번 요청/,
  );
  assert.throws(
    () =>
      validateDeliveredImages(
        [{ segmentId: "s8", assetId: "cached8" }],
        ms.filter((m) => p.selected.includes(m.segmentId)),
      ),
    /실제 전달/,
  );
});

test("raster-only PDF is OCRed locally with source page and uncertainty preserved", async () => {
  const canvas = createCanvas(1000, 300),
    c = canvas.getContext("2d");
  c.fillStyle = "white";
  c.fillRect(0, 0, 1000, 300);
  c.fillStyle = "black";
  c.font = "40px Arial";
  c.fillText("Python loops repeat actions.", 40, 100);
  const pdf = await PDFDocument.create();
  const png = await pdf.embedPng(canvas.toBuffer("image/png"));
  pdf
    .addPage([1000, 300])
    .drawImage(png, { x: 0, y: 0, width: 1000, height: 300 });
  const bytes = await pdf.save();
  await assert.rejects(extract(bytes, "application/pdf"), /OCR/);
  const result = await extract(bytes, "application/pdf", undefined, {
    ocr: true,
    ocrLanguages: ["eng"],
  });
  assert.match(result.pages[0]!.text, /Python loops repeat actions/i);
  assert.equal(result.pages[0]!.locator.pdfPage, 1);
  assert.equal(result.pages[0]!.locator.ocr.requiresVisualReview, true);
});

for (const [language, phrase, font] of [
  ["kor", "파이썬 반복문 학습", "Malgun Gothic"],
  ["jpn", "日本語の学習問題", "Yu Gothic"],
] as const)
  test(`local ${language} OCR model recognizes a raster page`, async () => {
    const canvas = createCanvas(1200, 250),
      ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 1200, 250);
    ctx.fillStyle = "black";
    ctx.font = `60px "${font}"`;
    ctx.fillText(phrase, 40, 120);
    const pdf = await PDFDocument.create();
    const png = await pdf.embedPng(canvas.toBuffer("image/png"));
    pdf
      .addPage([1200, 250])
      .drawImage(png, { x: 0, y: 0, width: 1200, height: 250 });
    const result = await extract(
      await pdf.save(),
      "application/pdf",
      undefined,
      { ocr: true, ocrLanguages: [language] },
    );
    assert.ok(
      result.pages[0]!.text.replace(/\s/g, "").includes(
        phrase.replace(/\s/g, ""),
      ),
      result.pages[0]!.text,
    );
  });

test("region suggestions reject foreign pages, can resume, and never change the question", async (t) => {
  let foreign = true,
    segmentId = "",
    calls = 0;
  const agent: AgentPort = {
    async ask(_role, _input, schema) {
      calls++;
      return schema.parse({
        regions: [
          {
            segmentId: foreign ? "foreign" : segmentId,
            bounds: { x: 0, y: 0, width: 1, height: 1 },
            reason: "Keep the complete prompt",
          },
        ],
      });
    },
    async status() {
      return { authenticated: true };
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
    dataDir: mkdtempSync(join(tmpdir(), "study-regions-")),
    agent,
    autoWorker: false,
  });
  t.after(() => f.app.close());
  const goal = f.catalog.goal({ title: "regions" });
  const scope = f.catalog.scope(goal.id, {
    title: "scope",
    concepts: [{ name: "shape", area: "math" }],
  });
  const source = f.catalog.source(goal.id, {
    title: "page",
    kind: "user_material",
    rights: "user_provided",
    rightsBasis: "fixture",
  });
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText("A square has four sides.");
  f.sources.commit(
    source.id,
    await f.sources.prepare(source.id, {
      base64: Buffer.from(await pdf.save()).toString("base64"),
      mime: "application/pdf",
    }),
  );
  const segment = f.catalog.segments(source.id)[0];
  segmentId = segment.id;
  const asset = await pdfPageImage(f.store, segment.revision_id, 1);
  const q = f.catalog.createQuestion({
    goalId: goal.id,
    scopeId: scope.id,
    type: "single",
    stem: "How many sides?",
    choices: [
      { id: "a", text: "four" },
      { id: "b", text: "three" },
    ],
    answer: ["a"],
    origin: "ai_generated",
    conceptIds: [scope.concepts[0]!.id],
    evidence: [{ segmentId, quote: segment.text }],
    requiredAssetIds: [asset.assetId],
    visualEvidence: [{ segmentId, assetId: asset.assetId, role: "question" }],
  });
  async function settled(id: string) {
    for (let i = 0; i < 100; i++) {
      const job = f.jobs.get(id);
      if (!["queued", "running"].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("Job did not settle");
  }
  const job = f.jobs.enqueue("suggest_regions", {
    questionId: q.id,
    revisionId: q.revisionId,
  });
  assert.equal((await settled(job.id)).status, "failed");
  foreign = false;
  f.jobs.resume(job.id);
  assert.equal((await settled(job.id)).status, "succeeded");
  assert.equal(calls, 2);
  assert.equal(f.catalog.readQuestion(q.id).revisionId, q.revisionId);
  const changed = f.catalog.createQuestion(
    { ...questionInput.strip().parse(q), stem: "Count the square's sides." },
    { questionId: q.id, expectedRevisionId: q.revisionId },
  );
  const stale = f.jobs.enqueue("suggest_regions", {
    questionId: q.id,
    revisionId: q.revisionId,
  });
  assert.equal((await settled(stale.id)).status, "failed");
  assert.equal(calls, 2);
  assert.notEqual(changed.revisionId, q.revisionId);
});

test("same-day successful review completes daily review but next day restores the original FSRS due", async (t) => {
  const s = new Store(mkdtempSync(join(tmpdir(), "study-extension-")));
  t.after(() => s.close());
  const c = new Catalog(s),
    e = new Exams(c),
    l = new Learning(e),
    sources = new Sources(c);
  const g = c.goal({ title: "review", timezone: "Asia/Seoul" });
  const scope = c.scope(g.id, {
    title: "scope",
    concepts: [{ name: "loop", area: "code" }],
  });
  const source = c.source(g.id, {
    title: "source",
    kind: "user_material",
    rights: "user_provided",
    rightsBasis: "authored",
  });
  sources.commit(
    source.id,
    await sources.prepare(source.id, { text: "Loops repeat." }),
  );
  const seg = c.segments(source.id)[0];
  const q = c.createQuestion({
    goalId: g.id,
    scopeId: scope.id,
    type: "single",
    stem: "What repeats?",
    choices: [
      { id: "a", text: "Loops" },
      { id: "b", text: "Nothing" },
    ],
    answer: ["a"],
    origin: "ai_generated",
    conceptIds: [scope.concepts[0]!.id],
    evidence: [{ segmentId: seg.id, quote: "Loops repeat." }],
  });
  c.review(q.revisionId, "usable", "fixture");
  const template = e.template({
    name: "one",
    total: 1,
    single: 1,
    multiple: 0,
    short: 0,
  });
  const attempt = (value: string, date: string) => {
    const exam = e.create(g.id, template.id);
    e.finalize(exam.id);
    const a = e.start(exam.id);
    e.saveAnswer(a.id, 1, {
      value: [value],
      version: 0,
      flagged: false,
      uncertain: false,
      hintUsed: false,
      recall: null,
    });
    l.submit(a.id, a.id);
    s.run("UPDATE attempts SET submitted_at=? WHERE id=?", date, a.id);
    l.rebuild(g.id);
    return a.id;
  };
  attempt("b", "2026-10-16T14:50:00.000Z");
  const before = s.one(
    "SELECT due FROM review_states WHERE question_id=?",
    q.id,
  ).due;
  attempt("a", "2026-10-16T14:55:00.000Z");
  assert.equal(
    reviewQueue(c, g.id, "2026-10-16T14:59:00.000Z")[0]!.completedToday,
    true,
  );
  assert.equal(
    reviewQueue(c, g.id, "2026-10-16T14:59:00.000Z")[0]!.overdue,
    false,
  );
  assert.equal(
    s.one("SELECT due FROM review_states WHERE question_id=?", q.id).due,
    before,
  );
  assert.equal(
    reviewQueue(c, g.id, "2026-10-16T15:01:00.000Z")[0]!.overdue,
    true,
  );
  attempt("a", "2026-10-16T15:05:00.000Z");
  assert.notEqual(
    s.one("SELECT due FROM review_states WHERE question_id=?", q.id).due,
    before,
  );
  s.run("UPDATE goals SET archived=1 WHERE id=?", g.id);
  assert.throws(() => e.createReview(g.id), /보관/);
});

test("learner snapshots remove hidden Python tests", () => {
  const visible = publicQuestion({
    answer: [],
    modelAnswer: "secret",
    python: {
      language: "python",
      tests: [
        { name: "sample", hidden: false },
        { name: "secret", hidden: true },
      ],
    },
  });
  assert.equal(visible.python.tests.length, 1);
  assert.equal(visible.python.testCount, 2);
  assert.equal("modelAnswer" in visible, false);
});

async function prepared() {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "study-extension-fixture-")),
  );
  const catalog = new Catalog(store),
    sources = new Sources(catalog),
    exams = new Exams(catalog),
    learning = new Learning(exams);
  const goal = catalog.goal({ title: "extension fixture" });
  const scope = catalog.scope(goal.id, {
    title: "scope",
    concepts: [{ name: "arithmetic", area: "Python" }],
  });
  const source = catalog.source(goal.id, {
    title: "authored",
    kind: "user_material",
    rights: "user_provided",
    rightsBasis: "fixture",
  });
  sources.commit(
    source.id,
    await sources.prepare(source.id, {
      text: "An integer may be added to one. Use print for output.",
    }),
  );
  const seg = catalog.segments(source.id)[0];
  const input = {
    goalId: goal.id,
    scopeId: scope.id,
    origin: "ai_generated",
    conceptIds: [scope.concepts[0]!.id],
    evidence: [{ segmentId: seg.id, quote: seg.text }],
  };
  return { store, catalog, sources, exams, learning, goal, scope, input };
}

test("Python grading uses frozen tests, hides private output, preserves manual assessment and backup", async (t) => {
  const f = await prepared();
  t.after(() => f.store.close());
  const q = f.catalog.createQuestion({
    ...f.input,
    type: "short",
    stem: "Read an integer and print its successor. Equal test weights.",
    modelAnswer: "print(int(input()) + 1)",
    rubric: [{ id: "tests", description: "Both tests pass", points: 2 }],
    points: 2,
    python: {
      language: "python",
      tests: [
        { name: "example", stdin: "2", stdout: "3" },
        { name: "negative", stdin: "-1", stdout: "0", hidden: true },
      ],
    },
  });
  f.catalog.review(q.revisionId, "usable", "authored fixture");
  const template = f.exams.template({
    name: "code",
    total: 1,
    single: 0,
    short: 1,
    python: 1,
  });
  const exam = f.exams.create(f.goal.id, template.id);
  f.exams.finalize(exam.id);
  assert.equal(f.exams.get(exam.id).items[0].python.tests.length, 1);
  const a = f.exams.start(exam.id);
  f.exams.saveAnswer(a.id, 1, {
    value: "print(3)",
    version: 0,
    flagged: false,
    uncertain: false,
    hintUsed: false,
    recall: null,
  });
  f.learning.submit(a.id, a.id);
  const runs = await gradePython("print(3)", q.python);
  f.learning.pythonGrade(a.id, 1, runs, 1);
  let result = f.learning.result(a.id);
  assert.equal(result.earned, 1);
  assert.equal(result.pending, 0);
  assert.equal(result.items[0].assessment.execution[1].stdout, undefined);
  f.learning.manual(a.id, 1, {
    score: 2,
    passed: true,
    status: "confirmed",
    reason: "human",
    explanation: "manual",
    expectedVersion: 2,
  });
  assert.throws(() => f.learning.pythonGrade(a.id, 1, runs, 2), /덮어쓰지/);
  const saved = backup(f.store),
    dir = mkdtempSync(join(tmpdir(), "study-extension-restore-"));
  restoreBackup(join(f.store.dir, "backups", saved.id), dir);
  const restored = new Store(dir);
  t.after(() => restored.close());
  result = new Learning(new Exams(new Catalog(restored))).result(a.id);
  assert.equal(result.earned, 2);
  assert.equal(result.items[0].python.tests.length, 2);
  assert.equal(
    restored.all("SELECT * FROM assets").length,
    f.store.all("SELECT * FROM assets").length,
  );
});

test("sections lock other answers, reject repeat advance, preserve pause and catch up after restart", async (t) => {
  const f = await prepared();
  t.after(() => f.store.close());
  for (let i = 0; i < 3; i++) {
    const q = f.catalog.createQuestion({
      ...f.input,
      type: "single",
      stem: `section question ${i}`,
      choices: [
        { id: "a", text: "one" },
        { id: "b", text: "two" },
      ],
      answer: ["a"],
    });
    f.catalog.review(q.revisionId, "usable", "fixture");
  }
  const sections = Array.from({ length: 3 }, (_, i) => ({
    title: `section${i}`,
    count: 1,
    minutes: 1,
  }));
  assert.throws(
    () =>
      templateInput.parse({
        name: "invalid",
        total: 3,
        single: 3,
        short: 0,
        minutes: 4,
        sections,
      }),
    /섹션/,
  );
  const template = f.exams.template({
    name: "sections",
    total: 3,
    single: 3,
    short: 0,
    minutes: 3,
    sections,
  });
  const exam = f.exams.create(f.goal.id, template.id);
  f.exams.finalize(exam.id);
  const a = f.exams.start(exam.id);
  const answer = {
    value: ["a"],
    version: 0,
    flagged: false,
    uncertain: false,
    hintUsed: false,
    recall: null,
  };
  assert.throws(() => f.exams.saveAnswer(a.id, 2, answer), /섹션/);
  f.exams.saveAnswer(a.id, 1, answer);
  f.exams.pause(a.id);
  assert.equal(f.exams.attempt(a.id).section!.deadline, null);
  f.exams.pause(a.id, true);
  assert.ok(f.exams.attempt(a.id).section!.deadline);
  assert.equal(f.exams.sections.next(a.id, 0), true);
  assert.throws(() => f.exams.sections.next(a.id, 0), /바뀌었습니다/);
  assert.throws(
    () => f.exams.saveAnswer(a.id, 1, { ...answer, version: 1 }),
    /섹션/,
  );
  const reopened = new Store(f.store.dir);
  t.after(() => reopened.close());
  assert.equal(
    new Exams(new Catalog(reopened)).attempt(a.id).section!.index,
    1,
  );
  f.store.run(
    "UPDATE attempt_sections SET deadline=? WHERE attempt_id=?",
    new Date(Date.now() - 125000).toISOString(),
    a.id,
  );
  assert.deepEqual(f.learning.expire(), [a.id]);
  assert.equal(f.exams.attempt(a.id).status, "submitted");
  assert.equal(f.learning.result(a.id).items[1].assessment.score, 0);
});

test("linked passage questions are not split across locked sections", async (t) => {
  const f = await prepared();
  t.after(() => f.store.close());
  for (let i = 0; i < 2; i++) {
    const q = f.catalog.createQuestion({
      ...f.input,
      type: "single",
      stem: `Grouped question ${i}`,
      groupId: "passage",
      passage: "Shared passage.",
      choices: [
        { id: "a", text: "one" },
        { id: "b", text: "two" },
      ],
      answer: ["a"],
    });
    f.catalog.review(q.revisionId, "usable", "fixture");
  }
  const input = {
    name: "sections",
    total: 2,
    single: 2,
    short: 0,
    minutes: 2,
    sections: [
      { title: "first", count: 1, minutes: 1 },
      { title: "second", count: 1, minutes: 1 },
    ],
  };
  const split = f.exams.create(f.goal.id, f.exams.template(input).id);
  assert.equal(split.items.length, 0);
  const together = f.exams.create(
    f.goal.id,
    f.exams.template({
      ...input,
      sections: [{ title: "one", count: 2, minutes: 2 }],
    }).id,
  );
  assert.equal(together.items.length, 2);
});

test("official sections preserve concept links and reject invalid scope updates atomically", async (t) => {
  const f = await prepared();
  t.after(() => f.store.close());
  const input = {
    title: "official",
    concepts: f.scope.concepts,
    examFormat: {
      total: 2,
      minutes: 3,
      evidenceUrl: "https://example.com/official",
      sections: [
        {
          title: "part",
          count: 2,
          minutes: 3,
          conceptIds: [f.scope.concepts[0]!.id],
        },
      ],
    },
  };
  const scope = f.catalog.scope(f.goal.id, input);
  assert.deepEqual(scope.examFormat, input.examFormat);
  for (const change of [{ count: 1 }, { conceptIds: ["foreign"] }]) {
    assert.throws(
      () =>
        f.catalog.scope(f.goal.id, {
          ...input,
          examFormat: {
            ...input.examFormat,
            sections: [{ ...input.examFormat.sections[0], ...change }],
          },
        }),
      /섹션/,
    );
    assert.equal(f.catalog.latestScope(f.goal.id)!.id, scope.id);
  }
  const wrong = f.exams.template({
    name: "mock",
    mode: "mock",
    total: 2,
    single: 2,
    short: 0,
    minutes: 3,
  });
  assert.throws(() => f.exams.create(f.goal.id, wrong.id), /공식 섹션/);
});

test("generation similarity catches number-only copies without collapsing short distinct prompts", () => {
  const a =
    "A learner has a collection of 123 items and adds 45 more items to it. Calculate the final number of items in the collection and explain the calculation.";
  assert.equal(
    nearDuplicate(a, a.replace("123", "9").replace("45", "87")),
    true,
  );
  assert.equal(nearDuplicate("2 + 3?", "3 + 4?"), false);
  assert.equal(
    nearDuplicate(
      a,
      "Explain why an empty list produces no iterations in a for loop, and describe what code placed outside that loop does after iteration ends.",
    ),
    false,
  );
});

test("job guidance points missing materials and limits to concrete recovery actions", () => {
  assert.equal(
    jobGuidance({ code: "WAITING_USER", details: { code: "SOURCE_REQUIRED" } })
      .href,
    "/sources",
  );
  assert.equal(jobGuidance({ code: "CODEX_USAGE_LIMIT" }).href, "/settings");
  assert.equal(
    jobGuidance({ code: "EXTRACTION_SOURCE_CHANGED" }).restart,
    true,
  );
  assert.equal(jobGuidance({ code: "PYTHON_RUNTIME" }).restart, false);
});
