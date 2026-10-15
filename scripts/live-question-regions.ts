// Opt-in two-call check against a copy of the saved public MIT PDF fixture.
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CodexAgent, type AgentPort } from "../src/agent.js";
import { createApp } from "../src/app.js";
import { saveQuestionRegions } from "../src/question-regions.js";
import { hash } from "../src/core.js";

if (!process.argv.includes("--live")) {
  console.log(
    "No calls. Use --live --fixture=<completed live-pdf-extraction directory>. Existing ChatGPT login only; maximum two calls.",
  );
  process.exit(0);
}
const fixture = resolve(
  process.argv.find((a) => a.startsWith("--fixture="))?.slice(10) ?? "",
);
const resume = process.argv.find((a) => a.startsWith("--resume="))?.slice(9);
assert.ok(
  resume || existsSync(join(fixture, "pdf-report.json")),
  "Use the completed isolated public PDF fixture, never a live study room.",
);
const dataDir = resume
  ? resolve(resume)
  : mkdtempSync(join(tmpdir(), "study-cafe-live-regions-"));
if (!resume) {
  assert.equal(
    JSON.parse(readFileSync(join(fixture, "pdf-report.json"), "utf8")).marker,
    "study-cafe-live-pdf-v1",
  );
  assert.ok(
    !existsSync(join(fixture, "server.lock")),
    "Stop the fixture server before copying its database.",
  );
  cpSync(join(fixture, "study-cafe.db"), join(dataDir, "study-cafe.db"));
  cpSync(join(fixture, "assets"), join(dataDir, "assets"), { recursive: true });
}
const report: any = resume
  ? JSON.parse(readFileSync(join(dataDir, "regions-report.json"), "utf8"))
  : {
      marker: "study-cafe-live-regions-v1",
      startedAt: new Date().toISOString(),
      dataDir,
      calls: [],
      cases: [],
      codeHashes: Object.fromEntries(
        ["pdf-visuals", "question-regions", "workflows"].map((name) => [
          name,
          hash(readFileSync(new URL(`../src/${name}.ts`, import.meta.url))),
        ]),
      ),
    };
assert.equal(report.marker, "study-cafe-live-regions-v1");
if (report.passed) {
  console.log(
    "This saved evaluation is already complete. No new calls were made.",
  );
  process.exit(0);
}
report.sessions ??= [];
report.sessions.push({
  startedAt: new Date().toISOString(),
  codeHashes: Object.fromEntries(
    ["pdf-visuals", "question-regions", "workflows", "catalog"].map((name) => [
      name,
      hash(readFileSync(new URL(`../src/${name}.ts`, import.meta.url))),
    ]),
  ),
});
const save = () =>
  writeFileSync(
    join(dataDir, "regions-report.json"),
    JSON.stringify(report, null, 2),
  );
const real = new CodexAgent({
  cwd: join(dataDir, "agent-work"),
  timeoutMs: 180000,
});
let stopped = false;
const agent: AgentPort = {
  async ask(role, input: any, schema, options) {
    assert.ok(
      !stopped && report.calls.length < 2,
      "Live budget exhausted or provider stopped",
    );
    const call: any = {
      role,
      startedAt: new Date().toISOString(),
      imageCount: options?.images?.length ?? 0,
    };
    report.calls.push(call);
    save();
    console.log(`Call ${report.calls.length}/2: ${role}`);
    const start = Date.now();
    try {
      const result: any = await real.ask(role, input, schema, options);
      call.result = result;
      return result;
    } catch (e) {
      stopped = true;
      call.error = String(e);
      throw e;
    } finally {
      call.elapsedMs = Date.now() - start;
      save();
    }
  },
  status: () => real.status(),
  login: () => real.login(),
  models: () => real.models(),
  close: () => real.close(),
};
const f = await createApp({
  dataDir,
  token: "region-evaluation",
  autoWorker: false,
  agent,
});
console.log(`Isolated fixture: ${dataDir}`);
try {
  const originalId = "8b7186be-9dcd-4742-bcad-4fbb6bed5cc3";
  const original = f.catalog.readQuestion(
    originalId,
    report.originalRevisionId ??
      f.catalog.questionRevisions(originalId).at(-1)!.revisionId,
  );
  report.originalRevisionId = original.revisionId;
  const source = original.visualEvidence.find(
    (v: any) => v.role === "question",
  );
  assert.ok(source);
  assert.equal(original.status, "usable");
  for (const scenario of [
    {
      name: "complete_graph",
      bounds: { x: 0.1, y: 0.085, width: 0.75, height: 0.27 },
      complete: true,
    },
    {
      name: "graph_cut_off",
      bounds: { x: 0.1, y: 0.085, width: 0.75, height: 0.07 },
      complete: false,
    },
  ]) {
    const previous = report.cases.find(
      (c: any) => c.name === scenario.name && c.jobStatus === "succeeded",
    );
    if (previous) {
      const call = report.calls[report.cases.indexOf(previous)];
      assert.equal(call.result.visualCheck?.complete, scenario.complete);
      assert.equal(
        previous.status,
        scenario.complete ? "usable" : "needs_review",
      );
      continue;
    }
    const current = f.catalog.readQuestion(original.id);
    const q = await saveQuestionRegions(f.catalog, original.id, {
      expectedRevisionId: current.revisionId,
      regions: [{ segmentId: source.segmentId, bounds: scenario.bounds }],
    });
    const asset = f.store.assetBytes(q.requiredAssetIds[0]);
    writeFileSync(join(dataDir, `${scenario.name}.png`), asset.bytes);
    const job = f.jobs.enqueue("verify_question", { questionId: q.id });
    await f.jobs.tick();
    const done = f.jobs.get(job.id),
      reviewed = f.catalog.readQuestion(q.id);
    report.cases.push({
      ...scenario,
      jobId: job.id,
      revisionId: q.revisionId,
      status: reviewed.status,
      jobStatus: done.status,
      error: done.error,
      review: reviewed.review,
    });
    save();
    console.log(`${scenario.name}: ${done.status}, ${reviewed.status}`);
    assert.equal(done.status, "succeeded", JSON.stringify(done.error));
    assert.equal(reviewed.review.visualCheck?.complete, scenario.complete);
    assert.equal(
      reviewed.status,
      scenario.complete ? "usable" : "needs_review",
    );
    assert.deepEqual(
      f.catalog.readQuestion(original.id, original.revisionId),
      original,
    );
  }
  report.passed = true;
} finally {
  report.finishedAt = new Date().toISOString();
  save();
  await f.app.close();
}
