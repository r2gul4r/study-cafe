import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { revisionInput } from "../apps/web/src/question-input.js";
import { reviewChoices } from "../apps/web/src/review-choices.js";

test("review restores the exact explanation revision's order without changing shuffled snapshots, answer IDs or scores", async (t) => {
  const f = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "study-choice-order-")),
    token: "test",
    autoWorker: false,
  });
  t.after(() => f.app.close());
  const goal = f.catalog.goal({ title: "Choice order" });
  const scope = f.catalog.scope(goal.id, {
    title: "Math",
    concepts: [{ name: "Addition", area: "Math" }],
  });
  const source = f.catalog.source(goal.id, {
    title: "Own notes",
    kind: "user_material",
    rights: "user_provided",
    rightsBasis: "Own",
  });
  f.sources.commit(
    source.id,
    await f.sources.prepare(source.id, { text: "One plus one equals two." }),
  );
  const original = f.catalog.createQuestion({
    goalId: goal.id,
    scopeId: scope.id,
    type: "single",
    stem: "1 + 1?",
    choices: [
      { id: "one", text: "1" },
      { id: "two", text: "2" },
      { id: "three", text: "3" },
    ],
    answer: ["two"],
    explanation: "정답은 B입니다. 코드 변수 B와 식 A + B는 치환하지 않습니다.",
    origin: "external_practice",
    conceptIds: [scope.concepts[0]!.id!],
    evidence: [
      {
        segmentId: f.catalog.segments(source.id)[0].id,
        quote: "One plus one equals two.",
      },
    ],
  });
  f.catalog.review(original.revisionId, "usable", "Checked");
  const template = f.exams.template({
    name: "Shuffle",
    total: 1,
    single: 1,
    short: 0,
    shuffleChoices: true,
  });
  const exam = f.exams.create(goal.id, template.id, "choice-order-test");
  f.exams.finalize(exam.id);
  const snapshot = f.store.one(
    "SELECT data FROM exam_items WHERE exam_id=?",
    exam.id,
  ).data;
  const frozen = f.exams.get(exam.id, true).items[0];
  assert.notDeepEqual(
    frozen.choices,
    original.choices,
    "Fixture must actually shuffle",
  );
  const attempt = f.exams.start(exam.id);
  assert.equal("explanationChoiceOrder" in attempt.exam.items[0], false);
  assert.equal("explanation" in attempt.exam.items[0], false);
  f.exams.saveAnswer(attempt.id, 1, {
    value: ["two"],
    version: 0,
    flagged: false,
    uncertain: true,
    hintUsed: false,
    recall: null,
  });
  f.learning.submit(attempt.id, "submit");
  const first = f.learning.result(attempt.id).items[0];
  assert.deepEqual(
    reviewChoices(first.choices, first.explanationChoiceOrder),
    original.choices,
  );
  assert.equal(first.explanation, original.explanation);
  assert.equal(first.assessment.passed, true);
  assert.deepEqual(f.learning.wrong(goal.id)[0].explanationChoiceOrder, [
    "one",
    "two",
    "three",
  ]);

  const { expectedRevisionId, ...input } = revisionInput(original);
  const revised = f.catalog.createQuestion(
    {
      ...input,
      choices: [original.choices[1], original.choices[2], original.choices[0]],
      explanation: "정답은 A입니다. 2가 첫 번째 보기입니다.",
    },
    { questionId: original.id, expectedRevisionId },
  );
  f.catalog.review(revised.revisionId, "usable", "Checked correction");
  // Merely editing the question bank must not relabel historical explanations.
  assert.deepEqual(
    f.learning.result(attempt.id).items[0].explanationChoiceOrder,
    ["one", "two", "three"],
  );
  f.learning.regradeQuestion(
    original.id,
    revised.revisionId,
    "Correct explanation order",
  );
  const corrected = f.learning.result(attempt.id).items[0];
  assert.deepEqual(
    reviewChoices(corrected.choices, corrected.explanationChoiceOrder),
    revised.choices,
  );
  assert.equal(corrected.assessment.correctedExplanation, revised.explanation);
  assert.equal(corrected.assessment.passed, true);
  assert.deepEqual(corrected.answerGiven.value, ["two"]);
  assert.equal(
    f.store.one("SELECT data FROM exam_items WHERE exam_id=?", exam.id).data,
    snapshot,
  );
});

test("review choice mapping keeps multi-answer IDs and falls back safely for missing or invalid legacy metadata", () => {
  const choices = [
    { id: "c", text: "Three" },
    { id: "a", text: "One" },
    { id: "b", text: "Two" },
  ];
  assert.deepEqual(
    reviewChoices(choices, ["a", "b", "c"])
      .filter((c) => ["a", "c"].includes(c.id))
      .map((c) => c.text),
    ["One", "Three"],
  );
  for (const order of [undefined, [], ["a", "a", "b"], ["a", "b", "missing"]])
    assert.equal(reviewChoices(choices, order), choices);
});
