import { Store } from "./store.js";
import { Jobs } from "./jobs.js";
import { decode, hash, requireThat } from "./core.js";

// Explicit child-first deletion keeps foreign keys enabled and the operation atomic.
export class GoalLifecycle {
  constructor(
    private store: Store,
    private jobs: Jobs,
  ) {}

  private graph(goalId: string) {
    const goal = this.store.get("goals", goalId);
    const ids = (table: string, where: string) =>
      this.store
        .all(`SELECT id FROM ${table} WHERE ${where} ORDER BY id`, goalId)
        .map((r) => r.id as string);
    const sources = ids("sources", "goal_id=?");
    const questions = ids("questions", "goal_id=?");
    const exams = ids("exams", "goal_id=?");
    const attempts = ids(
      "attempts",
      "exam_id IN (SELECT id FROM exams WHERE goal_id=?)",
    );
    const relatedJobs = this.store
      .all("SELECT id,input,status FROM jobs ORDER BY id")
      .filter((job) => {
        const input = decode(job.input);
        return (
          input.goalId === goalId ||
          sources.includes(input.sourceId) ||
          questions.includes(input.questionId) ||
          exams.includes(input.examId) ||
          attempts.includes(input.attemptId)
        );
      });
    return { goal, sources, questions, exams, attempts, relatedJobs };
  }

  preview(goalId: string) {
    const graph = this.graph(goalId);
    const count = (table: string) =>
      this.store.one(
        `SELECT count(*) AS n FROM ${table} WHERE goal_id=?`,
        goalId,
      ).n as number;
    return {
      title: decode(graph.goal.data).title as string,
      counts: {
        sources: graph.sources.length,
        questions: graph.questions.length,
        exams: graph.exams.length,
        attempts: graph.attempts.length,
        notes: count("notes"),
        reviews: count("review_states"),
        jobs: graph.relatedJobs.length,
      },
      blocked: graph.relatedJobs.some(
        (j) =>
          ["queued", "running"].includes(j.status) ||
          j.id === this.jobs.activeId,
      ),
      // A changed set of records requires another preview before deletion.
      confirmation: hash(
        JSON.stringify({
          ...graph,
          notes: count("notes"),
          reviews: count("review_states"),
        }),
      ),
    };
  }

  delete(goalId: string, input: { title: string; confirmation: string }) {
    return this.store.tx(() => {
      const preview = this.preview(goalId);
      requireThat(
        !preview.blocked,
        "GOAL_BUSY",
        "대기·실행 중인 작업을 완료하거나 취소한 뒤 다시 시도해 주세요.",
        409,
      );
      requireThat(
        input.title === preview.title,
        "GOAL_TITLE",
        "삭제할 목표 이름을 정확히 입력해 주세요.",
      );
      requireThat(
        input.confirmation === preview.confirmation,
        "GOAL_CHANGED",
        "목표 기록이 변경됐어요. 삭제 창을 다시 열어 범위를 확인해 주세요.",
        409,
      );
      const graph = this.graph(goalId);
      for (const job of graph.relatedJobs) {
        for (const table of ["agent_runs", "job_steps", "job_events"])
          this.store.run(`DELETE FROM ${table} WHERE job_id=?`, job.id);
        this.store.run("DELETE FROM jobs WHERE id=?", job.id);
      }
      for (const table of ["review_events", "review_states", "notes"])
        this.store.run(`DELETE FROM ${table} WHERE goal_id=?`, goalId);
      for (const table of ["answers", "assessments"])
        this.store.run(
          `DELETE FROM ${table} WHERE attempt_id IN (SELECT id FROM attempts WHERE exam_id IN (SELECT id FROM exams WHERE goal_id=?))`,
          goalId,
        );
      this.store.run(
        "DELETE FROM attempts WHERE exam_id IN (SELECT id FROM exams WHERE goal_id=?)",
        goalId,
      );
      this.store.run(
        "DELETE FROM exam_items WHERE exam_id IN (SELECT id FROM exams WHERE goal_id=?)",
        goalId,
      );
      this.store.run("DELETE FROM exams WHERE goal_id=?", goalId);
      for (const table of ["question_evidence", "question_status"])
        this.store.run(
          `DELETE FROM ${table} WHERE revision_id IN (SELECT id FROM question_revisions WHERE question_id IN (SELECT id FROM questions WHERE goal_id=?))`,
          goalId,
        );
      this.store.run(
        "DELETE FROM question_search WHERE question_id IN (SELECT id FROM questions WHERE goal_id=?)",
        goalId,
      );
      this.store.run(
        "DELETE FROM question_revisions WHERE question_id IN (SELECT id FROM questions WHERE goal_id=?)",
        goalId,
      );
      this.store.run("DELETE FROM questions WHERE goal_id=?", goalId);
      this.store.run(
        "DELETE FROM segments WHERE revision_id IN (SELECT id FROM source_revisions WHERE source_id IN (SELECT id FROM sources WHERE goal_id=?))",
        goalId,
      );
      this.store.run(
        "DELETE FROM source_revisions WHERE source_id IN (SELECT id FROM sources WHERE goal_id=?)",
        goalId,
      );
      for (const table of ["sources", "scopes", "concepts"])
        this.store.run(`DELETE FROM ${table} WHERE goal_id=?`, goalId);
      this.store.run("DELETE FROM goals WHERE id=?", goalId);
      // Attachments are content-addressed and may be shared; templates/backups are global.
      return { deleted: true, counts: preview.counts };
    });
  }
}
