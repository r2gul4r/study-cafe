import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { backup } from "../src/backup.js";
import { restoreCommands } from "../apps/web/src/restore-commands.js";

test("restore plan verifies the saved snapshot, reports its contents and never changes the live study room", async (t) => {
  const f = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "study-backup-plan-")),
    token: "test",
    autoWorker: false,
  });
  t.after(() => f.app.close());
  f.catalog.goal({ title: "Backed up goal" });
  const asset = f.store.asset(Buffer.from("authored asset"), "text/plain");
  const saved = backup(f.store);
  f.catalog.goal({ title: "Newer live goal" });
  const headers = { authorization: "Bearer test" },
    url = `/api/backups/${saved.id}/restore-plan`;
  assert.equal((await f.app.inject({ method: "GET", url })).statusCode, 401);
  const response = await f.app.inject({ method: "GET", url, headers });
  assert.equal(response.statusCode, 200);
  const plan = response.json();
  assert.equal(plan.counts.goals, 1);
  assert.equal(plan.counts.assets, 1);
  assert.equal(plan.requiresStoppedServer, true);
  assert.equal(plan.mergesRecords, false);
  assert.equal(plan.includesCredentials, false);
  assert.ok(plan.directory.endsWith(saved.id));
  assert.equal(f.store.one("SELECT count(*) AS n FROM goals").n, 2);
  assert.equal(
    (
      await f.app.inject({
        method: "GET",
        url: "/api/backups/not-an-id/restore-plan",
        headers,
      })
    ).statusCode,
    400,
  );
  writeFileSync(
    join(f.store.dir, "backups", saved.id, "assets", asset.hash),
    "corrupted",
  );
  const invalid = await f.app.inject({ method: "GET", url, headers });
  assert.equal(invalid.json().error.code, "BACKUP_HASH");
  assert.equal(f.store.one("SELECT count(*) AS n FROM goals").n, 2);
});

test("PowerShell restore guidance quotes spaces, apostrophes and substitutions and stops on restore failure", () => {
  const text = restoreCommands(
    " C:\\My Backup\\O'Neil;$(calc) ",
    "C:\\new folder\\data",
  );
  assert.match(
    text,
    /^pnpm restore 'C:\\My Backup\\O''Neil;\$\(calc\)' 'C:\\new folder\\data'/,
  );
  assert.ok(
    text.indexOf("if ($LASTEXITCODE -ne 0)") <
      text.indexOf("$env:STUDY_CAFE_DATA_DIR"),
  );
  assert.match(
    text,
    /\$env:STUDY_CAFE_DATA_DIR = 'C:\\new folder\\data'\npnpm start$/,
  );
});
