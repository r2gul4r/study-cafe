import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDataDir } from "../src/local-browser.js";

test("Windows desktop and packaged AppData use the same profile database", (t) => {
  const home = mkdtempSync(join(tmpdir(), "study-path-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const local of [
    "AppData/Local",
    "AppData/Local/Packages/Codex/LocalCache/Local",
  ])
    assert.equal(
      defaultDataDir({ LOCALAPPDATA: join(home, local) }, home, "win32"),
      join(home, ".study-cafe"),
    );
});

test("existing legacy data blocks silently creating an empty default database", (t) => {
  const home = mkdtempSync(join(tmpdir(), "study-path-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const local = join(home, "AppData", "Local");
  mkdirSync(join(local, "study-cafe"), { recursive: true });
  writeFileSync(join(local, "study-cafe", "study-cafe.db"), "legacy");
  assert.throws(
    () => defaultDataDir({ LOCALAPPDATA: local }, home, "win32"),
    /빈 DB는 만들지 않았습니다/,
  );
  mkdirSync(join(home, ".study-cafe"));
  writeFileSync(join(home, ".study-cafe", "study-cafe.db"), "migrated");
  assert.equal(
    defaultDataDir({ LOCALAPPDATA: local }, home, "win32"),
    join(home, ".study-cafe"),
  );
});

test("explicit directories and non-Windows defaults remain supported", () => {
  const custom = join(tmpdir(), "explicit-study");
  assert.equal(
    defaultDataDir({ STUDY_CAFE_DATA_DIR: custom }, tmpdir(), "win32"),
    custom,
  );
  assert.equal(
    defaultDataDir({ STUDY_CAFE_DATA_DIR: " " }, tmpdir(), "win32"),
    join(tmpdir(), ".study-cafe"),
  );
  assert.equal(
    defaultDataDir({}, tmpdir(), "linux"),
    join(tmpdir(), ".local", "share", "study-cafe"),
  );
});
