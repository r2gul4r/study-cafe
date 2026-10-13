import { EventEmitter } from "node:events";
import { Store } from "./store.js";
import { id, now, decode, requireThat, Fault } from "./core.js";

export class Waiting extends Error {
  constructor(public details: any) {
    super("사용자 선택이 필요합니다.");
  }
}
export type JobContext = {
  jobId: string;
  signal: AbortSignal;
  event: (data: any) => void;
  step: <T, R = T>(
    name: string,
    work: () => Promise<T>,
    commit?: (value: T) => R,
  ) => Promise<R>;
};
export class Jobs extends EventEmitter {
  handlers = new Map<string, (input: any, ctx: JobContext) => Promise<any>>();
  running = false;
  closed = false;
  timer?: NodeJS.Timeout;
  controller?: AbortController;
  activeId?: string;
  constructor(public store: Store) {
    super();
    store.run(
      "UPDATE jobs SET status='queued',generation=generation+1,updated_at=? WHERE status='running'",
      now(),
    );
  }
  enqueue(kind: string, input: any, requestKey?: string) {
    requireThat(this.handlers.has(kind), "JOB_KIND", "알 수 없는 작업");
    if (requestKey) {
      const old = this.store.one(
        "SELECT * FROM jobs WHERE request_key=?",
        requestKey,
      );
      if (old) {
        requireThat(
          old.kind === kind && old.input === JSON.stringify(input),
          "IDEMPOTENCY_CONFLICT",
          "같은 요청 ID의 입력이 다릅니다.",
          409,
        );
        return this.get(old.id);
      }
    }
    const jobId = id();
    this.store.tx(() => {
      this.store.run(
        "INSERT INTO jobs(id,kind,input,status,request_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        jobId,
        kind,
        JSON.stringify(input),
        "queued",
        requestKey ?? null,
        now(),
        now(),
      );
      this.event(jobId, { status: "queued" });
    });
    this.kick();
    return this.get(jobId);
  }
  get(jobId: string) {
    const r = this.store.get("jobs", jobId);
    return {
      id: r.id,
      kind: r.kind,
      input: decode(r.input),
      status: r.status,
      generation: r.generation,
      result: r.result ? decode(r.result) : null,
      error: r.error ? decode(r.error) : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  event(jobId: string, data: any) {
    this.store.event(jobId, data);
    queueMicrotask(() => {
      if (!this.closed) this.emit("event", jobId);
    });
  }
  events(jobId: string, after = 0) {
    this.get(jobId);
    return this.store
      .all(
        "SELECT * FROM job_events WHERE job_id=? AND seq>? ORDER BY seq LIMIT 500",
        jobId,
        after,
      )
      .map((r) => ({
        id: r.seq,
        data: decode(r.data),
        createdAt: r.created_at,
      }));
  }
  cancel(jobId: string, pause = false) {
    const job = this.get(jobId);
    requireThat(
      !["succeeded", "cancelled"].includes(job.status),
      "JOB_STATE",
      "이미 끝난 작업입니다.",
      409,
    );
    this.store.run(
      "UPDATE jobs SET status=?,generation=generation+1,updated_at=? WHERE id=?",
      pause ? "paused" : "cancelled",
      now(),
      jobId,
    );
    if (this.activeId === jobId) this.controller?.abort();
    this.event(jobId, { status: pause ? "paused" : "cancelled" });
    return this.get(jobId);
  }
  resume(jobId: string) {
    const job = this.get(jobId);
    requireThat(
      ["failed", "paused", "waiting_user"].includes(job.status),
      "JOB_STATE",
      "재개할 수 없는 상태입니다.",
      409,
    );
    this.store.run(
      "UPDATE jobs SET status='queued',error=NULL,generation=generation+1,updated_at=? WHERE id=?",
      now(),
      jobId,
    );
    this.event(jobId, { status: "queued" });
    this.kick();
    return this.get(jobId);
  }
  kick() {
    if (!this.closed && !this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.tick();
      }, 10);
  }
  async tick() {
    if (this.closed || this.running) return;
    const row = this.store.one(
      "SELECT * FROM jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1",
    );
    if (!row) return;
    this.running = true;
    this.activeId = row.id;
    this.controller = new AbortController();
    const generation = row.generation + 1;
    this.store.run(
      "UPDATE jobs SET status='running',generation=?,updated_at=? WHERE id=?",
      generation,
      now(),
      row.id,
    );
    this.event(row.id, { status: "running" });
    const fence = () => {
      const j = this.get(row.id);
      requireThat(
        j.status === "running" && j.generation === generation,
        "STALE_JOB",
        "작업이 중단되거나 교체되었습니다.",
        409,
      );
      this.controller!.signal.throwIfAborted();
    };
    const ctx: JobContext = {
      jobId: row.id,
      signal: this.controller.signal,
      event: (data) => {
        fence();
        this.event(row.id, data);
      },
      step: async (name, work, commit) => {
        fence();
        const cached = this.store.one(
          "SELECT data FROM job_steps WHERE job_id=? AND step=?",
          row.id,
          name,
        );
        if (cached) return decode(cached.data);
        const value = await work();
        fence();
        return this.store.tx(() => {
          fence();
          const result = commit ? commit(value) : value;
          this.store.run(
            "INSERT INTO job_steps VALUES(?,?,?)",
            row.id,
            name,
            JSON.stringify(result),
          );
          this.event(row.id, { step: name, status: "completed" });
          return result as any;
        });
      },
    };
    try {
      const handler = this.handlers.get(row.kind);
      requireThat(handler, "JOB_KIND", "작업 구현을 찾지 못했습니다.");
      const result = await handler(decode(row.input), ctx);
      fence();
      this.store.run(
        "UPDATE jobs SET status='succeeded',result=?,updated_at=? WHERE id=?",
        JSON.stringify(result ?? null),
        now(),
        row.id,
      );
      this.event(row.id, { status: "succeeded" });
    } catch (error) {
      const current = this.get(row.id);
      if (current.status === "running" && current.generation === generation) {
        const waiting = error instanceof Waiting;
        const detail = waiting
          ? {
              code: "WAITING_USER",
              message: error.message,
              details: error.details,
            }
          : error instanceof Fault
            ? {
                code: error.code,
                message: error.message,
                details: error.details,
              }
            : {
                code: "WORK_FAILED",
                message: error instanceof Error ? error.message : "작업 실패",
              };
        this.store.run(
          "UPDATE jobs SET status=?,error=?,updated_at=? WHERE id=?",
          waiting ? "waiting_user" : "failed",
          JSON.stringify(detail),
          now(),
          row.id,
        );
        this.event(row.id, {
          status: waiting ? "waiting_user" : "failed",
          error: detail,
        });
      }
    } finally {
      this.running = false;
      this.activeId = undefined;
      this.controller = undefined;
      this.kick();
    }
  }
  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    const interrupted = this.activeId;
    if (interrupted) this.cancel(interrupted, true);
    while (this.running) await new Promise((r) => setTimeout(r, 10));
    if (interrupted) {
      this.store.run(
        "UPDATE jobs SET status='queued',generation=generation+1,updated_at=? WHERE id=? AND status='paused'",
        now(),
        interrupted,
      );
      this.event(interrupted, { status: "queued", reason: "server_shutdown" });
    }
  }
}
