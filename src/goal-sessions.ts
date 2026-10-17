import { z } from "zod";
import type { AgentPort, AskOptions } from "./agent.js";
import { Catalog } from "./catalog.js";
import { decode, now, requireThat } from "./core.js";

// Unknown/new roles stay isolated until deliberately added to the manager.
const managedRoles = new Set([
  "plan_goal",
  "research_sources",
  "extract_existing_questions",
  "generate_question",
  "generate_variant",
  "summarize_misconceptions",
]);

export class GoalSessions {
  private lanes = new Map<string, Promise<void>>();

  constructor(
    private catalog: Catalog,
    private agent: AgentPort,
  ) {}

  private goalId(jobId: string): string {
    const s = this.catalog.store;
    const input = z
      .object({
        goalId: z.string().optional(),
        sourceId: z.string().optional(),
        questionId: z.string().optional(),
        examId: z.string().optional(),
        attemptId: z.string().optional(),
      })
      .parse(decode(s.get("jobs", jobId).input));
    const ids: string[] = [];
    if (input.goalId) ids.push(input.goalId);
    for (const [table, recordId] of [
      ["sources", input.sourceId],
      ["questions", input.questionId],
      ["exams", input.examId],
    ] as const) {
      if (recordId) ids.push(z.string().parse(s.get(table, recordId).goal_id));
    }
    if (input.attemptId) {
      const attempt = s.get("attempts", input.attemptId);
      ids.push(z.string().parse(s.get("exams", attempt.exam_id).goal_id));
    }
    requireThat(
      ids.length > 0 && new Set(ids).size === 1,
      "AGENT_GOAL",
      "AI 작업의 목표 연결이 일치하지 않습니다.",
    );
    return ids[0]!;
  }

  // Rebuild from committed records on EVERY turn, including recovery on another PC.
  // Large source bodies and frozen exam/question snapshots remain in task input.
  private context(goalId: string) {
    const s = this.catalog.store;
    const count = (table: string) =>
      Number(
        s.one(`SELECT count(*) AS n FROM ${table} WHERE goal_id=?`, goalId).n,
      );
    return {
      observedAt: now(),
      goal: this.catalog.readGoal(goalId),
      counts: {
        sources: count("sources"),
        questions: count("questions"),
        exams: count("exams"),
        notes: count("notes"),
      },
      sources: s.all(
        "SELECT id,status,json_extract(data,'$.title') AS title FROM sources WHERE goal_id=? ORDER BY created_at DESC,id LIMIT 30",
        goalId,
      ),
      recentNotes: s.all(
        "SELECT id,substr(data,1,6000) AS excerpt,created_at AS createdAt FROM notes WHERE goal_id=? ORDER BY created_at DESC,id LIMIT 5",
        goalId,
      ),
      recentAttempts: s.all(
        `SELECT a.id,a.status,a.submitted_at AS submittedAt,e.id AS examId
         FROM attempts a JOIN exams e ON e.id=a.exam_id
         WHERE e.goal_id=? ORDER BY a.started_at DESC,a.id LIMIT 10`,
        goalId,
      ),
      assessments: s.all(
        `SELECT g.status,count(*) AS count FROM assessments g
         JOIN attempts a ON a.id=g.attempt_id JOIN exams e ON e.id=a.exam_id
         WHERE e.goal_id=? AND g.version=(SELECT max(v.version) FROM assessments v
           WHERE v.attempt_id=g.attempt_id AND v.slot=g.slot) GROUP BY g.status`,
        goalId,
      ),
      bounded: true,
    };
  }

  async ask<T>(
    jobId: string,
    role: string,
    input: unknown,
    schema: z.ZodType<T>,
    options: AskOptions,
  ): Promise<T> {
    // First grading is isolated too: the manager may have authored the answer.
    if (!managedRoles.has(role))
      return this.agent.ask(role, input, schema, {
        ...options,
        session: undefined,
      });

    const goalId = this.goalId(jobId);
    const previous = this.lanes.get(goalId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.lanes.set(goalId, tail);
    await previous;
    try {
      options.signal?.throwIfAborted();
      const s = this.catalog.store;
      const row = s.one(
        "SELECT thread_id FROM goal_sessions WHERE goal_id=?",
        goalId,
      );
      return await this.agent.ask(role, input, schema, {
        ...options,
        session: {
          goalId,
          threadId: row ? z.string().parse(row.thread_id) : undefined,
          context: this.context(goalId),
          onReady: (threadId, action) => {
            // Save before starting inference so a process crash cannot lose the link.
            const time = now();
            s.run(
              `INSERT INTO goal_sessions VALUES(?,?,?,?)
              ON CONFLICT(goal_id) DO UPDATE SET thread_id=excluded.thread_id,updated_at=excluded.updated_at`,
              goalId,
              threadId,
              time,
              time,
            );
            options.onProgress?.({ type: "goal_session", goalId, action });
          },
        },
      });
    } finally {
      release();
      if (this.lanes.get(goalId) === tail) this.lanes.delete(goalId);
    }
  }
}
