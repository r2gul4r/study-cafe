import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/app.js";
test("static UI is public but APIs, hostile hosts and origins remain protected", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "study-cafe-web-")),
    web = join(dir, "web");
  mkdirSync(join(web, "assets"), { recursive: true });
  writeFileSync(
    join(web, "index.html"),
    "<!doctype html><title>study-cafe</title>",
  );
  writeFileSync(join(web, "assets", "app.js"), "console.log('local');");
  const { app } = await createApp({
    dataDir: join(dir, "data"),
    webDir: web,
    token: "test",
    autoWorker: false,
  });
  t.after(() => app.close());
  const page = await app.inject({ url: "/" });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /study-cafe/);
  assert.match(
    String(page.headers["content-security-policy"]),
    /frame-ancestors 'none'/,
  );
  assert.equal((await app.inject({ url: "/assets/app.js" })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/goals" })).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/not-found" })).statusCode, 401);
  assert.equal(
    (await app.inject({ url: "/", headers: { host: "evil.example" } }))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        url: "/",
        headers: { origin: "https://evil.example" },
      })
    ).statusCode,
    403,
  );
  assert.equal((await app.inject({ url: "/health" })).json().frontend, true);
  assert.equal(
    (await app.inject({ url: "/assets/../../session-token" })).statusCode >=
      400,
    true,
  );
});
test("attempt history is authenticated and isolated by goal", async (t) => {
  const { app, catalog, exams, sources } = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "study-cafe-history-")),
    token: "test",
    autoWorker: false,
  });
  t.after(() => app.close());
  const first = catalog.goal({ title: "First" }),
    second = catalog.goal({ title: "Second" });
  const scope = catalog.scope(first.id, {
    title: "Scope",
    concepts: [{ name: "Concept", area: "Area" }],
  });
  const source = catalog.source(first.id, {
    title: "Authored",
    kind: "user_material",
    rights: "user_provided",
    rightsBasis: "Own test material",
  });
  sources.commit(
    source.id,
    await sources.prepare(source.id, { text: "One plus one equals two." }),
  );
  const question = catalog.createQuestion({
    goalId: first.id,
    scopeId: scope.id,
    stem: "One plus one?",
    type: "single",
    choices: [
      { id: "a", text: "Two" },
      { id: "b", text: "Three" },
    ],
    answer: ["a"],
    origin: "external_practice",
    conceptIds: [scope.concepts[0]!.id!],
    evidence: [
      {
        segmentId: catalog.segments(source.id)[0].id,
        quote: "One plus one equals two.",
      },
    ],
  });
  catalog.review(question.revisionId, "usable", "Checked");
  const tpl = exams.template({
    name: "History",
    total: 1,
    single: 1,
    short: 0,
  });
  const exam = exams.create(first.id, tpl.id);
  exams.finalize(exam.id);
  const attempt = exams.start(exam.id);
  const own = await app.inject({
    url: `/api/attempts?goalId=${first.id}`,
    headers: { authorization: "Bearer test" },
  });
  assert.equal(own.statusCode, 200);
  assert.equal(own.json()[0].id, attempt.id);
  assert.equal("answer" in own.json()[0].exam.items[0], false);
  const response = await app.inject({
    url: `/api/attempts?goalId=${second.id}`,
    headers: { authorization: "Bearer test" },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), []);
  assert.equal(
    (await app.inject({ url: `/api/attempts?goalId=${first.id}` })).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        url: "/api/attempts",
        headers: { authorization: "Bearer test" },
      })
    ).statusCode,
    400,
  );
});
