import { DatabaseSync } from "node:sqlite";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "./store.js";
import { id, hash, requireThat, now } from "./core.js";

export function backup(store: Store) {
  const backupId = id(),
    dir = join(store.dir, "backups", backupId);
  mkdirSync(join(dir, "assets"), { recursive: true });
  const dbPath = join(dir, "study-cafe.db");
  store.db.prepare("VACUUM INTO ?").run(dbPath);
  const snapshot = new DatabaseSync(dbPath, { readOnly: true });
  let assets: any[];
  try {
    assets = snapshot.prepare("SELECT DISTINCT hash FROM assets").all();
  } finally {
    snapshot.close();
  }
  for (const asset of assets) {
    requireThat(
      /^[a-f0-9]{64}$/.test(asset.hash),
      "ASSET_HASH",
      "파일 해시 오류",
    );
    const from = join(store.dir, "assets", asset.hash);
    requireThat(
      hash(readFileSync(from)) === asset.hash,
      "ASSET_CORRUPT",
      "첨부 파일이 손상되었습니다.",
    );
    cpSync(from, join(dir, "assets", asset.hash), {
      errorOnExist: true,
      force: false,
    });
  }
  const manifest = {
    id: backupId,
    schemaVersion: 1,
    createdAt: now(),
    databaseHash: hash(readFileSync(dbPath)),
    assets: assets.map((a) => a.hash),
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}
export function verifyBackup(dir: string) {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  requireThat(
    manifest.schemaVersion === 1 && Array.isArray(manifest.assets),
    "BACKUP_SCHEMA",
    "지원하지 않는 백업입니다.",
  );
  requireThat(
    hash(readFileSync(join(dir, "study-cafe.db"))) === manifest.databaseHash,
    "BACKUP_HASH",
    "백업 DB 해시가 다릅니다.",
  );
  for (const asset of manifest.assets) {
    requireThat(
      typeof asset === "string" && /^[a-f0-9]{64}$/.test(asset),
      "ASSET_PATH",
      "잘못된 백업 첨부 경로",
    );
    requireThat(
      hash(readFileSync(join(dir, "assets", asset))) === asset,
      "BACKUP_HASH",
      "백업 첨부 해시가 다릅니다.",
    );
  }
  const db = new DatabaseSync(join(dir, "study-cafe.db"), { readOnly: true });
  try {
    requireThat(
      (db.prepare("PRAGMA integrity_check").get() as any).integrity_check ===
        "ok",
      "BACKUP_INTEGRITY",
      "백업 DB 무결성 오류",
    );
    requireThat(
      db.prepare("PRAGMA foreign_key_check").all().length === 0,
      "BACKUP_FOREIGN_KEYS",
      "백업 참조 오류",
    );
    requireThat(
      (db.prepare("PRAGMA user_version").get() as any).user_version === 1,
      "BACKUP_SCHEMA",
      "DB 스키마 오류",
    );
    const expected = db
      .prepare("SELECT DISTINCT hash FROM assets")
      .all()
      .map((r: any) => r.hash);
    requireThat(
      expected.length === new Set(manifest.assets).size &&
        expected.every((a) => manifest.assets.includes(a)),
      "BACKUP_MANIFEST",
      "첨부 목록이 DB와 다릅니다.",
    );
  } finally {
    db.close();
  }
  return manifest;
}
export function restoreBackup(backupDir: string, targetDir: string) {
  requireThat(
    resolve(backupDir) !== resolve(targetDir),
    "RESTORE_PATH",
    "백업과 복원 대상은 달라야 합니다.",
  );
  const manifest = verifyBackup(backupDir);
  mkdirSync(targetDir, { recursive: true });
  const unlock = lockData(targetDir);
  let previous: any = null;
  try {
    if (existsSync(join(targetDir, "study-cafe.db"))) {
      const old = new Store(targetDir);
      try {
        previous = backup(old);
      } finally {
        old.close();
      }
    }
    mkdirSync(join(targetDir, "assets"), { recursive: true });
    for (const asset of manifest.assets)
      cpSync(
        join(backupDir, "assets", asset),
        join(targetDir, "assets", asset),
      );
    const staged = join(targetDir, "restore-" + id() + ".db");
    cpSync(join(backupDir, "study-cafe.db"), staged);
    for (const suffix of ["-wal", "-shm"]) {
      const path = join(targetDir, "study-cafe.db" + suffix);
      if (existsSync(path)) unlinkSync(path);
    }
    renameSync(staged, join(targetDir, "study-cafe.db"));
    return { restored: manifest.id, previousBackup: previous?.id ?? null };
  } finally {
    unlock();
  }
}

// Read-only preflight. Restoring remains a separate CLI action with the server stopped.
export function backupRestorePlan(store: Store, backupId: string) {
  requireThat(/^[a-f0-9-]{36}$/.test(backupId), "BACKUP_ID", "잘못된 백업 ID");
  const directory = join(store.dir, "backups", backupId);
  requireThat(
    existsSync(join(directory, "manifest.json")),
    "BACKUP_NOT_FOUND",
    "백업을 찾을 수 없습니다.",
    404,
  );
  const manifest = verifyBackup(directory);
  requireThat(
    manifest.id === backupId,
    "BACKUP_ID",
    "백업 폴더와 명세의 ID가 다릅니다.",
  );
  const db = new DatabaseSync(join(directory, "study-cafe.db"), {
    readOnly: true,
  });
  try {
    const count = (table: string) =>
      Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
    return {
      id: backupId,
      createdAt: manifest.createdAt,
      verifiedAt: now(),
      directory: resolve(directory),
      currentDataDirectory: resolve(store.dir),
      counts: {
        goals: count("goals"),
        sources: count("sources"),
        questions: count("questions"),
        questionRevisions: count("question_revisions"),
        exams: count("exams"),
        attempts: count("attempts"),
        assets: count("assets"),
      },
      includesCredentials: false,
      requiresStoppedServer: true,
      mergesRecords: false,
    };
  } finally {
    db.close();
  }
}
export function lockData(dir: string) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "server.lock");
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    let live = false;
    try {
      process.kill(saved.pid, 0);
      live = true;
    } catch (e: any) {
      if (e.code !== "ESRCH") live = true;
    }
    requireThat(
      !live,
      "DATA_IN_USE",
      "데이터 디렉터리를 사용하는 서버를 먼저 종료하세요.",
      409,
    );
    unlinkSync(path);
  }
  const token = id();
  writeFileSync(path, JSON.stringify({ pid: process.pid, token }), {
    flag: "wx",
  });
  return () => {
    if (
      existsSync(path) &&
      JSON.parse(readFileSync(path, "utf8")).token === token
    )
      unlinkSync(path);
  };
}
