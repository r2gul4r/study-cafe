import { decode, now, requireThat, type Template } from "./core.js";
import type { Store } from "./store.js";
export class ExamSections {
  constructor(private store: Store) {}
  private template(attemptId: string): Template {
    const attempt = this.store.get("attempts", attemptId);
    return decode(this.store.get("exams", attempt.exam_id).data).template;
  }
  start(attemptId: string, template: Template, started: string) {
    if (!template.sections?.length) return;
    this.store.run(
      "INSERT INTO attempt_sections VALUES(?,?,?,NULL)",
      attemptId,
      0,
      new Date(
        Date.parse(started) + template.sections[0]!.minutes * 60000,
      ).toISOString(),
    );
  }
  get(attemptId: string) {
    const row = this.store.one(
      "SELECT * FROM attempt_sections WHERE attempt_id=?",
      attemptId,
    );
    if (!row) return null;
    const sections = this.template(attemptId).sections;
    const start = sections
      .slice(0, row.section_index)
      .reduce((n, s) => n + s.count, 1);
    return {
      index: row.section_index as number,
      title: sections[row.section_index]!.title,
      firstSlot: start,
      lastSlot: start + sections[row.section_index]!.count - 1,
      count: sections.length,
      deadline: row.deadline as string | null,
      remainingMs: row.remaining_ms as number | null,
    };
  }
  assertSlot(attemptId: string, slot: number) {
    const current = this.get(attemptId);
    requireThat(
      !current ||
        (slot >= current.firstSlot &&
          slot <= current.lastSlot &&
          (!current.deadline || current.deadline > now())),
      "SECTION_LOCKED",
      "현재 진행 중인 섹션의 문항만 풀 수 있습니다.",
      409,
    );
  }
  next(attemptId: string, expectedIndex: number, expired = false) {
    const attempt = this.store.get("attempts", attemptId);
    const current = this.get(attemptId);
    requireThat(
      attempt.status === "active" && current && current.index === expectedIndex,
      "SECTION_CONFLICT",
      "섹션 상태가 바뀌었습니다. 화면을 새로고침하세요.",
      409,
    );
    if (current.index + 1 === current.count) return false;
    const next = this.template(attemptId).sections[current.index + 1]!;
    const start = expired ? current.deadline! : now();
    this.store.run(
      "UPDATE attempt_sections SET section_index=?,deadline=?,remaining_ms=NULL WHERE attempt_id=?",
      current.index + 1,
      new Date(Date.parse(start) + next.minutes * 60000).toISOString(),
      attemptId,
    );
    return true;
  }
  pause(attemptId: string, resume: boolean) {
    const current = this.get(attemptId);
    if (!current) return;
    this.store.run(
      "UPDATE attempt_sections SET deadline=?,remaining_ms=? WHERE attempt_id=?",
      resume ? new Date(Date.now() + current.remainingMs!).toISOString() : null,
      resume ? null : Math.max(0, Date.parse(current.deadline!) - Date.now()),
      attemptId,
    );
  }
}
