import { dayAt, decode, now } from "./core.js";
import type { Catalog } from "./catalog.js";

// Daily completion is a presentation/selection rule, not a second FSRS update.
export function reviewQueue(catalog: Catalog, goalId: string, at = now()) {
  const s = catalog.store;
  const zone = catalog.readGoal(goalId).timezone;
  const today = dayAt(at, zone);
  const latest = new Map<
    string,
    { passed: boolean; uncertain: boolean; excluded: string | null }
  >();
  for (const row of s.all(
    "SELECT family_id,data,occurred_at FROM review_events WHERE goal_id=? AND occurred_at<=? ORDER BY occurred_at,attempt_id,slot",
    goalId,
    at,
  )) {
    if (dayAt(row.occurred_at, zone) !== today) continue;
    latest.set(row.family_id, decode(row.data));
  }
  return s
    .all("SELECT * FROM review_states WHERE goal_id=? ORDER BY due", goalId)
    .map((r) => {
      const q = catalog.readQuestion(r.question_id);
      const event = latest.get(q.familyId);
      const completedToday =
        !!event?.passed && !event.uncertain && event.excluded !== "hint_used";
      return {
        questionId: r.question_id as string,
        familyId: q.familyId as string,
        due: r.due as string,
        scheduledDue: r.due <= at,
        completedToday,
        overdue: r.due <= at && !completedToday,
        state: decode(r.data),
      };
    });
}
