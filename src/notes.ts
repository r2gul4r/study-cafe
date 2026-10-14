import { decode } from "./core.js";
import type { Store } from "./store.js";

// Resolve historical evidence, not today's wrong-answer list. Never mutate notes.
export function readNotes(store: Store, goalId: string) {
  return store
    .all("SELECT * FROM notes WHERE goal_id=? ORDER BY created_at DESC", goalId)
    .map((row) => {
      const note = decode(row.data);
      const evidence = (note.assessmentIds ?? []).flatMap(
        (assessmentId: string) => {
          const record = store.one(
            `SELECT a.attempt_id, a.slot, i.data AS question,
        e.data AS exam, t.submitted_at FROM assessments a
        JOIN attempts t ON t.id=a.attempt_id JOIN exams e ON e.id=t.exam_id
        JOIN exam_items i ON i.exam_id=e.id AND i.slot=a.slot
        WHERE a.id=? AND e.goal_id=?`,
            assessmentId,
            goalId,
          );
          if (!record) return [];
          const q = decode(record.question);
          return [
            {
              questionId: q.id,
              attemptId: record.attempt_id,
              slot: record.slot,
              examTitle: decode(record.exam).template?.name ?? "학습 기록",
              submittedAt: record.submitted_at,
              conceptIds: q.conceptIds,
              segmentIds: (q.evidence ?? []).map((e: any) => e.segmentId),
            },
          ];
        },
      );
      return {
        id: row.id,
        ...note,
        createdAt: row.created_at,
        concepts: (note.concepts ?? []).map((concept: any) => ({
          ...concept,
          references: evidence.filter(
            (ref: any, index: number, all: any[]) =>
              concept.attemptIds?.includes(ref.attemptId) &&
              ref.conceptIds?.includes(concept.conceptId) &&
              all.findIndex(
                (other) =>
                  other.attemptId === ref.attemptId && other.slot === ref.slot,
              ) === index,
          ),
        })),
      };
    });
}
