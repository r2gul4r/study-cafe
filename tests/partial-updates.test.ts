import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/app.js";

test("source rights edits preserve omitted metadata and allow explicit clears", async (t) => {
  const f = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "study-source-patch-")),
    token: "test",
    autoWorker: false,
  });
  t.after(() => f.app.close());
  const goal = f.catalog.goal({ title: "Partial edits" });
  const answer = f.catalog.source(goal.id, { title: "Answer sheet" });
  const source = f.catalog.source(goal.id, {
    title: "Original source",
    url: "https://example.com/original",
    publisher: "Original publisher",
    kind: "user_material",
    rights: "user_provided",
    rightsBasis: "Authored by user",
    examEvidence: "Original evidence",
    answerSourceIds: [answer.id],
  });
  const patch = (payload: Record<string, unknown>) =>
    f.app.inject({
      method: "PATCH",
      url: `/api/sources/${source.id}`,
      headers: { authorization: "Bearer test" },
      payload,
    });
  const updated = await patch({
    rightsBasis: "Revised permission description",
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.deepEqual(updated.json(), {
    ...source,
    rightsBasis: "Revised permission description",
  });
  const cleared = await patch({
    url: null,
    examEvidence: null,
    answerSourceIds: [],
    publisher: "",
  });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.deepEqual(cleared.json(), {
    ...updated.json(),
    url: null,
    examEvidence: null,
    answerSourceIds: [],
    publisher: "",
  });
  for (const payload of [
    { kind: "invalid" },
    { unknownField: true },
    { rightsBasis: "" },
  ]) {
    const invalid = await patch(payload);
    assert.equal(invalid.statusCode, 400, invalid.body);
    assert.deepEqual(f.catalog.readSource(source.id), cleared.json());
  }
});

test("goal title edits preserve all settings, while explicit null clears remain valid", async (t) => {
  const f = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "study-goal-patch-")),
    token: "test",
    autoWorker: false,
  });
  t.after(() => f.app.close());
  const goal = f.catalog.goal({
    title: "Before",
    description: "Keep this description",
    kind: "exam",
    level: "Advanced",
    targetDate: "2027-01-01",
    minutesPerDay: 45,
    timezone: "Asia/Tokyo",
  });
  const patch = (payload: Record<string, unknown>) =>
    f.app.inject({
      method: "PATCH",
      url: `/api/goals/${goal.id}`,
      headers: { authorization: "Bearer test" },
      payload,
    });
  const updated = await patch({ title: "After" });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.deepEqual(updated.json(), { ...goal, title: "After" });
  const cleared = await patch({
    targetDate: null,
    minutesPerDay: null,
    description: "",
  });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.deepEqual(cleared.json(), {
    ...updated.json(),
    targetDate: null,
    minutesPerDay: null,
    description: "",
  });
  for (const payload of [
    { timezone: "Not/A_Zone" },
    { minutesPerDay: 0 },
    { unknownField: true },
  ]) {
    const invalid = await patch(payload);
    assert.equal(invalid.statusCode, 400, invalid.body);
    assert.deepEqual(f.catalog.readGoal(goal.id), cleared.json());
  }
});
