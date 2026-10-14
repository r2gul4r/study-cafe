import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/app.js";
import { id, now } from "../src/core.js";

test("note links use original assessment snapshots, remain after correction, and exclude foreign evidence", async (t) => {
  const f = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "study-notes-")),
    token: "test",
    autoWorker: false,
  });
  t.after(() => f.app.close());
  const setup = async (title: string) => {
    const goal = f.catalog.goal({ title });
    const scope = f.catalog.scope(goal.id, {
      title,
      concepts: [{ name: "Repeat", area: "Python" }],
    });
    const source = f.catalog.source(goal.id, {
      title,
      kind: "user_material",
      rights: "user_provided",
      rightsBasis: "Own",
    });
    f.sources.commit(
      source.id,
      await f.sources.prepare(source.id, { text: "Loops repeat." }),
    );
    const segmentId = f.catalog.segments(source.id)[0].id;
    const q = f.catalog.createQuestion({
      goalId: goal.id,
      scopeId: scope.id,
      type: "single",
      stem: title,
      choices: [
        { id: "a", text: "Yes" },
        { id: "b", text: "No" },
      ],
      answer: ["a"],
      origin: "external_practice",
      conceptIds: [scope.concepts[0]!.id!],
      evidence: [{ segmentId, quote: "Loops repeat." }],
    });
    f.catalog.review(q.revisionId, "usable", "test");
    const template = f.exams.template({
      name: title,
      total: 1,
      single: 1,
      short: 0,
    });
    const exam = f.exams.create(goal.id, template.id);
    f.exams.finalize(exam.id);
    const attempt = f.exams.start(exam.id);
    f.exams.saveAnswer(attempt.id, 1, {
      value: ["b"],
      version: 0,
      flagged: false,
      uncertain: false,
      hintUsed: false,
      recall: null,
    });
    const result = f.learning.submit(attempt.id, id());
    return {
      goal,
      scope,
      q,
      attempt,
      assessment: result.items[0].assessment,
      segmentId,
    };
  };
  const own = await setup("Saved exam"),
    foreign = await setup("Other goal");
  const noteId = id();
  const raw = JSON.stringify({
    concepts: [
      {
        conceptId: own.scope.concepts[0]!.id,
        summary: own.q.id,
        attemptIds: [own.attempt.id, foreign.attempt.id],
        reasonIsInferred: true,
      },
    ],
    assessmentIds: [
      own.assessment.id,
      foreign.assessment.id,
      own.assessment.id,
      "missing",
    ],
  });
  f.store.run(
    "INSERT INTO notes VALUES(?,?,?,?)",
    noteId,
    own.goal.id,
    raw,
    now(),
  );
  f.learning.manual(own.attempt.id, 1, {
    status: "confirmed",
    score: 1,
    passed: true,
    reason: "Correction",
    explanation: "Corrected",
    expectedVersion: own.assessment.version,
  });
  assert.equal(f.learning.wrong(own.goal.id).length, 0);
  const response = await f.app.inject({
    method: "GET",
    url: `/api/goals/${own.goal.id}/notes`,
    headers: { authorization: "Bearer test" },
  });
  assert.equal(response.statusCode, 200);
  const concept = response.json()[0].concepts[0];
  assert.equal(concept.summary, own.q.id);
  assert.equal(concept.references.length, 1);
  assert.equal(concept.references[0].questionId, own.q.id);
  assert.equal(concept.references[0].attemptId, own.attempt.id);
  assert.equal(concept.references[0].slot, 1);
  assert.equal(concept.references[0].examTitle, "Saved exam");
  assert.deepEqual(concept.references[0].segmentIds, [own.segmentId]);
  assert.equal(f.store.get("notes", noteId).data, raw);
  const denied = await f.app.inject({
    method: "GET",
    url: `/api/goals/${own.goal.id}/notes`,
  });
  assert.equal(denied.statusCode, 401);
});
