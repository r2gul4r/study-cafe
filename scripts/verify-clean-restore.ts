import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Store } from "../src/store.js";
import { backup, restoreBackup, verifyBackup } from "../src/backup.js";
import { runPython } from "../src/python.js";

const sourceDir = process.argv[2],
  targetDir = process.argv[3];
assert.ok(
  sourceDir && targetDir,
  "Usage: <isolated source data> <empty restore directory>",
);
assert.ok(
  !existsSync(join(resolve(targetDir), "study-cafe.db")),
  "Target must be empty",
);
const original = new Store(resolve(sourceDir));
try {
  const manifest = backup(original);
  const location = join(original.dir, "backups", manifest.id);
  verifyBackup(location);
  restoreBackup(location, resolve(targetDir));
  const restored = new Store(resolve(targetDir));
  try {
    const tables = [
      "goals",
      "scopes",
      "sources",
      "source_revisions",
      "segments",
      "questions",
      "question_revisions",
      "question_status",
      "exam_items",
      "attempts",
      "attempt_sections",
      "answers",
      "assessments",
      "review_events",
      "review_states",
      "goal_sessions",
      "assets",
    ];
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const rows = original.all(`SELECT * FROM ${table} ORDER BY rowid`);
      assert.deepEqual(
        restored.all(`SELECT * FROM ${table} ORDER BY rowid`),
        rows,
        table,
      );
      counts[table] = rows.length;
    }
    for (const row of restored.all("SELECT id FROM assets"))
      assert.ok(restored.assetBytes(row.id).bytes.length);
    assert.equal(
      (await runPython("print(int(input())+1)", "4", "5", 1000)).status,
      "passed",
    );
    const report = {
      verifiedAt: new Date().toISOString(),
      sourceDir: original.dir,
      targetDir: restored.dir,
      backupId: manifest.id,
      counts,
      engine: "fresh installation Python",
      passed: true,
    };
    writeFileSync(
      join(restored.dir, "restore-verification.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    restored.close();
  }
} finally {
  original.close();
}
