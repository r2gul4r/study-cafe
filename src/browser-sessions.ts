import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requireThat } from "./core.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const lifetime = 30 * 24 * 60 * 60;
type Session = { digest: string; host: string; expires: number };

// Launch grants live only in memory. Browser secrets are stored only as hashes,
// outside the study database/backups, and are invalidated by a root-token change.
export class BrowserSessions {
  private grants = new Map<string, { host: string; expires: number }>();
  private sessions: Session[] = [];
  private file: string;
  private tokenHash: string;
  constructor(
    dataDir: string,
    token: string,
    private clock = Date.now,
  ) {
    this.file = join(dataDir, "browser-sessions.json");
    this.tokenHash = digest(token);
    if (existsSync(this.file)) {
      try {
        const saved = JSON.parse(readFileSync(this.file, "utf8"));
        if (saved.tokenHash === this.tokenHash && Array.isArray(saved.sessions))
          this.sessions = saved.sessions
            .filter(
              (s: Session) =>
                typeof s.digest === "string" &&
                /^[a-f0-9]{64}$/.test(s.digest) &&
                typeof s.host === "string" &&
                Number.isFinite(s.expires) &&
                s.expires > this.clock(),
            )
            .slice(-32);
      } catch {
        /* A damaged credential file requires a new local launch. */
      }
    }
  }
  private save() {
    this.sessions = this.sessions
      .filter((s) => s.expires > this.clock())
      .slice(-32);
    const staged = this.file + ".tmp";
    writeFileSync(
      staged,
      JSON.stringify({ tokenHash: this.tokenHash, sessions: this.sessions }),
      { mode: 0o600 },
    );
    renameSync(staged, this.file);
  }
  name(host: string) {
    return "study_cafe_" + digest(host).slice(0, 16);
  }
  private value(host: string, cookie = "") {
    return (
      cookie
        .split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith(this.name(host) + "="))
        ?.slice(this.name(host).length + 1) ?? ""
    );
  }
  issue(host: string) {
    for (const [key, grant] of this.grants)
      if (grant.expires <= this.clock()) this.grants.delete(key);
    if (this.grants.size >= 16)
      this.grants.delete(this.grants.keys().next().value!);
    const code = randomBytes(32).toString("hex");
    this.grants.set(digest(code), { host, expires: this.clock() + 5 * 60_000 });
    return code;
  }
  exchange(host: string, code: string) {
    const key = digest(code),
      grant = this.grants.get(key);
    requireThat(
      grant && grant.host === host && grant.expires > this.clock(),
      "LAUNCH_EXPIRED",
      "연결 정보가 만료되었어요. 공부방 열기를 다시 실행해 주세요.",
      401,
    );
    this.grants.delete(key);
    return this.connect(host);
  }
  connect(host: string) {
    const value = randomBytes(32).toString("hex");
    this.sessions.push({
      digest: digest(value),
      host,
      expires: this.clock() + lifetime * 1000,
    });
    this.save();
    return `${this.name(host)}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${lifetime}`;
  }
  valid(host: string, cookie?: string) {
    const value = this.value(host, cookie);
    return (
      /^[a-f0-9]{64}$/.test(value) &&
      this.sessions.some(
        (s) =>
          s.host === host &&
          s.digest === digest(value) &&
          s.expires > this.clock(),
      )
    );
  }
  disconnect(host: string, cookie?: string) {
    const value = digest(this.value(host, cookie));
    this.sessions = this.sessions.filter(
      (s) => !(s.host === host && s.digest === value),
    );
    this.save();
    return `${this.name(host)}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0`;
  }
}
