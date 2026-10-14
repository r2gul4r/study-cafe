import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { now, id } from "../src/core.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const f = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "study-goals-")),
    token: "test",
    autoWorker: false,
  });
  t.after(() => f.app.close());
  const goal = f.catalog.goal({ title: "Delete this goal" });
  const scope = f.catalog.scope(goal.id, {
    title: "Scope",
    concepts: [{ name: "Addition", area: "Math" }],
  });
  const source = f.catalog.source(goal.id, {
    title: "Source",
    kind: "user_material",
    rights: "user_provided",
    rightsBasis: "Own writing",
  });
  f.sources.commit(
    source.id,
    await f.sources.prepare(source.id, { text: "One plus one is two." }),
  );
  const question = f.catalog.createQuestion({
    goalId: goal.id,
    scopeId: scope.id,
    type: "single",
    stem: "1 + 1?",
    choices: [
      { id: "a", text: "2" },
      { id: "b", text: "3" },
    ],
    answer: ["a"],
    origin: "external_practice",
    conceptIds: [scope.concepts[0]!.id!],
    evidence: [
      {
        segmentId: f.catalog.segments(source.id)[0].id,
        quote: "One plus one is two.",
      },
    ],
  });
  f.catalog.review(question.revisionId, "usable", "Checked");
  const template = f.exams.template({
    name: "One question",
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
  f.learning.submit(attempt.id, "submitted");
  f.store.run(
    "INSERT INTO notes VALUES(?,?,?,?)",
    id(),
    goal.id,
    JSON.stringify({ summary: "Review addition" }),
    now(),
  );
  const headers = { host: "127.0.0.1", authorization: "Bearer test" };
  const request = (
    method: "GET" | "POST" | "DELETE",
    path: string,
    payload?: any,
  ) =>
    f.app.inject({
      method,
      url: `/api/goals/${goal.id}${path}`,
      headers,
      ...(payload ? { payload } : {}),
    });
  const job = (input: any, status = "succeeded") => {
    const jobId = id();
    f.store.run(
      "INSERT INTO jobs(id,kind,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      jobId,
      "test",
      JSON.stringify(input),
      status,
      now(),
      now(),
    );
    f.store.run("INSERT INTO job_steps VALUES(?,?,?)", jobId, "test", "{}");
    f.store.event(jobId, {});
    f.store.run(
      "INSERT INTO agent_runs VALUES(?,?,?,?)",
      id(),
      jobId,
      "{}",
      now(),
    );
    return jobId;
  };
  return {
    ...f,
    goal,
    source,
    question,
    exam,
    attempt,
    template,
    request,
    job,
  };
}

test("archive and restore preserve records; deleting one goal removes its entire graph but keeps other goals and shared files", async (t) => {
  const f = await fixture(t);
  const other = f.catalog.goal({ title: "Keep this goal" });
  const otherSource = f.catalog.source(other.id, {
    title: "Keep source",
    kind: "user_material",
  });
  const asset = f.store.asset(Buffer.from("Shared file"), "text/plain");
  const related = [
    { goalId: f.goal.id },
    { sourceId: f.source.id },
    { questionId: f.question.id },
    { examId: f.exam.id },
    { attemptId: f.attempt.id },
  ].map((input) => f.job(input));
  const otherJob = f.job({ goalId: other.id });
  assert.equal(
    (await f.request("POST", "/archive", { archived: true })).json().archived,
    true,
  );
  assert.equal(f.catalog.readQuestion(f.question.id).id, f.question.id);
  assert.equal(
    (await f.request("POST", "/archive", { archived: false })).json().archived,
    false,
  );
  const preview = (await f.request("GET", "/deletion-preview")).json();
  assert.deepEqual(preview.counts, {
    sources: 1,
    questions: 1,
    exams: 1,
    attempts: 1,
    notes: 1,
    reviews: 1,
    jobs: 5,
  });
  const deleted = await f.request("DELETE", "", {
    title: preview.title,
    confirmation: preview.confirmation,
  });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal((await f.request("GET", "")).statusCode, 404);
  for (const table of [
    "scopes",
    "concepts",
    "source_revisions",
    "segments",
    "questions",
    "question_revisions",
    "question_status",
    "question_evidence",
    "question_search",
    "exams",
    "exam_items",
    "attempts",
    "answers",
    "assessments",
    "notes",
    "review_states",
    "review_events",
  ])
    assert.equal(f.store.one(`SELECT count(*) n FROM ${table}`).n, 0, table);
  for (const jobId of related)
    assert.equal(
      f.store.one("SELECT id FROM jobs WHERE id=?", jobId),
      undefined,
    );
  for (const table of ["job_steps", "job_events", "agent_runs"])
    assert.equal(f.store.one(`SELECT count(*) n FROM ${table}`).n, 1, table);
  assert.equal(f.catalog.readGoal(other.id).title, other.title);
  assert.equal(f.store.get("sources", otherSource.id).goal_id, other.id);
  assert.equal(f.jobs.get(otherJob).status, "succeeded");
  assert.equal(f.store.get("templates", f.template.id).id, f.template.id);
  assert.equal(f.store.assetBytes(asset.id).bytes.toString(), "Shared file");
  assert.deepEqual(f.store.all("PRAGMA foreign_key_check"), []);
});

test("deletion requires name and current preview, blocks queued/running and still-unwinding cancelled jobs", async (t) => {
  const f = await fixture(t);
  let preview = (await f.request("GET", "/deletion-preview")).json();
  assert.equal(
    (
      await f.request("DELETE", "", {
        title: "Wrong",
        confirmation: preview.confirmation,
      })
    ).statusCode,
    400,
  );
  const jobId = f.job({ attemptId: f.attempt.id }, "queued");
  for (const status of ["queued", "running", "cancelled"]) {
    f.store.run("UPDATE jobs SET status=? WHERE id=?", status, jobId);
    f.jobs.activeId = status === "cancelled" ? jobId : undefined;
    const p = (await f.request("GET", "/deletion-preview")).json();
    assert.equal(p.blocked, true);
    const res = await f.request("DELETE", "", {
      title: p.title,
      confirmation: p.confirmation,
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "GOAL_BUSY");
  }
  f.jobs.activeId = undefined;
  assert.equal(
    (
      await f.request("DELETE", "", {
        title: preview.title,
        confirmation: preview.confirmation,
      })
    ).json().error.code,
    "GOAL_CHANGED",
  );
  assert.equal(f.store.get("attempts", f.attempt.id).id, f.attempt.id);
  preview = (await f.request("GET", "/deletion-preview")).json();
  assert.equal(
    (
      await f.request("DELETE", "", {
        title: preview.title,
        confirmation: preview.confirmation,
      })
    ).statusCode,
    200,
  );
});
