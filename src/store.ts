import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  renameSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { id, hash, now, decode, requireThat } from "./core.js";

export const schemaVersion = 2;

const migration = `
CREATE TABLE goals(id TEXT PRIMARY KEY,data TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE TABLE scopes(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL REFERENCES goals(id),version INTEGER NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(goal_id,version));
CREATE TABLE concepts(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL REFERENCES goals(id),name TEXT NOT NULL,area TEXT NOT NULL);
CREATE TABLE sources(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL REFERENCES goals(id),data TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE source_revisions(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),hash TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(source_id,hash));
CREATE TABLE segments(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES source_revisions(id),ordinal INTEGER NOT NULL,text TEXT NOT NULL,locator TEXT NOT NULL,UNIQUE(revision_id,ordinal));
CREATE TABLE assets(id TEXT PRIMARY KEY,hash TEXT NOT NULL,mime TEXT NOT NULL,bytes INTEGER NOT NULL);
CREATE TABLE questions(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL REFERENCES goals(id),family_id TEXT NOT NULL,current_revision TEXT,archived INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE TABLE question_revisions(id TEXT PRIMARY KEY,question_id TEXT NOT NULL REFERENCES questions(id),version INTEGER NOT NULL,fingerprint TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(question_id,version));
CREATE INDEX question_fingerprint ON question_revisions(fingerprint);
CREATE TABLE question_status(revision_id TEXT PRIMARY KEY REFERENCES question_revisions(id),status TEXT NOT NULL,review TEXT NOT NULL);
CREATE TABLE question_evidence(revision_id TEXT NOT NULL REFERENCES question_revisions(id),segment_id TEXT NOT NULL REFERENCES segments(id),quote TEXT NOT NULL,PRIMARY KEY(revision_id,segment_id,quote));
CREATE VIRTUAL TABLE question_search USING fts5(question_id UNINDEXED,content,tokenize='trigram');
CREATE TABLE templates(id TEXT PRIMARY KEY,data TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE exams(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL REFERENCES goals(id),scope_id TEXT NOT NULL REFERENCES scopes(id),status TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE exam_items(exam_id TEXT NOT NULL REFERENCES exams(id),slot INTEGER NOT NULL,revision_id TEXT NOT NULL REFERENCES question_revisions(id),data TEXT NOT NULL,PRIMARY KEY(exam_id,slot),UNIQUE(exam_id,revision_id));
CREATE TABLE attempts(id TEXT PRIMARY KEY,exam_id TEXT NOT NULL REFERENCES exams(id),status TEXT NOT NULL,started_at TEXT NOT NULL,deadline TEXT,submitted_at TEXT,submit_key TEXT,remaining_ms INTEGER);
CREATE TABLE answers(attempt_id TEXT NOT NULL REFERENCES attempts(id),slot INTEGER NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(attempt_id,slot));
CREATE TABLE assessments(id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL REFERENCES attempts(id),slot INTEGER NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(attempt_id,slot,version));
CREATE TABLE review_events(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL REFERENCES goals(id),question_id TEXT NOT NULL REFERENCES questions(id),family_id TEXT NOT NULL,attempt_id TEXT NOT NULL REFERENCES attempts(id),slot INTEGER NOT NULL,data TEXT NOT NULL,occurred_at TEXT NOT NULL,UNIQUE(attempt_id,slot));
CREATE TABLE review_states(question_id TEXT PRIMARY KEY REFERENCES questions(id),goal_id TEXT NOT NULL REFERENCES goals(id),due TEXT NOT NULL,data TEXT NOT NULL);
CREATE TABLE notes(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL REFERENCES goals(id),data TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,input TEXT NOT NULL,status TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,result TEXT,error TEXT,request_key TEXT UNIQUE,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE job_steps(job_id TEXT NOT NULL REFERENCES jobs(id),step TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(job_id,step));
CREATE TABLE job_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL REFERENCES jobs(id),data TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE agent_runs(id TEXT PRIMARY KEY,job_id TEXT,data TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
`;
export class Store {
  db: DatabaseSync;
  private depth = 0;
  constructor(public dir: string) {
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "assets"), { recursive: true });
    this.db = new DatabaseSync(join(dir, "study-cafe.db"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    const version = this.one("PRAGMA user_version")?.user_version;
    requireThat(
      Number.isInteger(version) && version >= 0 && version <= schemaVersion,
      "SCHEMA_VERSION",
      "지원하지 않는 데이터 버전입니다.",
    );
    if (version === 0)
      this.tx(() => {
        this.db.exec(migration);
        this.db.exec("PRAGMA user_version=1");
      });
    if (version < 2)
      this.tx(() => {
        this.db.exec(`
          CREATE TABLE goal_sessions(
            goal_id TEXT PRIMARY KEY REFERENCES goals(id) ON DELETE CASCADE,
            thread_id TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          PRAGMA user_version=2;
        `);
      });
  }
  run(sql: string, ...params: any[]) {
    return this.db.prepare(sql).run(...params);
  }
  one(sql: string, ...params: any[]): any {
    return this.db.prepare(sql).get(...params);
  }
  all(sql: string, ...params: any[]): any[] {
    return this.db.prepare(sql).all(...params);
  }
  tx<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }
  get(table: string, recordId: string) {
    requireThat(/^[a-z_]+$/.test(table), "TABLE", "잘못된 테이블");
    const row = this.one(`SELECT * FROM ${table} WHERE id=?`, recordId);
    requireThat(row, "NOT_FOUND", "항목을 찾을 수 없습니다.", 404);
    return row;
  }
  event(jobId: string, data: unknown) {
    this.run(
      "INSERT INTO job_events(job_id,data,created_at) VALUES(?,?,?)",
      jobId,
      JSON.stringify(data),
      now(),
    );
  }
  asset(bytes: Uint8Array, mime: string) {
    const digest = hash(bytes);
    const path = join(this.dir, "assets", digest);
    if (!existsSync(path)) {
      const tmp = path + "." + id() + ".tmp";
      writeFileSync(tmp, bytes, { flag: "wx" });
      renameSync(tmp, path);
    }
    const existing = this.one(
      "SELECT * FROM assets WHERE hash=? AND mime=?",
      digest,
      mime,
    );
    if (existing) return existing;
    const assetId = id();
    this.run(
      "INSERT INTO assets VALUES(?,?,?,?)",
      assetId,
      digest,
      mime,
      bytes.length,
    );
    return { id: assetId, hash: digest, mime, bytes: bytes.length };
  }
  assetBytes(assetId: string) {
    const a = this.get("assets", assetId);
    return { asset: a, bytes: readFileSync(join(this.dir, "assets", a.hash)) };
  }
  setting(name: string, fallback: unknown) {
    const r = this.one("SELECT value FROM settings WHERE key=?", name);
    return r ? decode(r.value) : fallback;
  }
  close() {
    this.db.close();
  }
}
