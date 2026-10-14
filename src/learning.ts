import { fsrs, createEmptyCard, Rating, type Card } from "ts-fsrs";
import { z } from "zod";
import { Exams } from "./exams.js";
import { id, now, decode, requireThat, dayAt } from "./core.js";

export const gradeOutput = z
  .object({
    status: z.enum(["confirmed", "pending"]),
    criteria: z.array(
      z
        .object({
          id: z.string(),
          score: z.number().nonnegative(),
          evidence: z.string(),
          reason: z.string(),
        })
        .strict(),
    ),
    explanation: z.string(),
    reason: z.enum([
      "concept",
      "interpretation",
      "application",
      "calculation",
      "unanswered",
      "unknown",
    ]),
    passed: z.boolean(),
  })
  .strict();
export class Learning {
  scheduler = fsrs({ enable_fuzz: false });
  constructor(public exams: Exams) {}
  get store() {
    return this.exams.store;
  }
  submit(attemptId: string, requestKey: string, expired = false) {
    const r = this.store.get("attempts", attemptId);
    if (r.status === "submitted") {
      requireThat(
        expired || r.submit_key === requestKey,
        "SUBMIT_CONFLICT",
        "이미 다른 요청으로 제출했습니다.",
        409,
      );
      return this.result(attemptId);
    }
    requireThat(
      ["active", "paused"].includes(r.status),
      "ATTEMPT_STATE",
      "제출 가능한 응시가 아닙니다.",
      409,
    );
    return this.store.tx(() => {
      const items = this.exams.get(r.exam_id, true).items;
      this.store.run(
        "UPDATE attempts SET status='submitted',submitted_at=?,submit_key=? WHERE id=?",
        now(),
        requestKey,
        attemptId,
      );
      for (const q of items) {
        const answer = this.store.one(
          "SELECT data FROM answers WHERE attempt_id=? AND slot=?",
          attemptId,
          q.slot,
        );
        const a = answer
          ? decode(answer.data)
          : {
              value: q.type === "short" ? "" : [],
              uncertain: false,
              hintUsed: false,
              recall: null,
            };
        const blank =
          typeof a.value === "string" ? !a.value.trim() : !a.value.length;
        if (blank)
          this.assess(attemptId, q.slot, {
            status: "confirmed",
            score: 0,
            passed: false,
            explanation: "미응답",
            reason: "unanswered",
            criteria: [],
            actor: "app",
          });
        else if (q.type === "short")
          this.assess(attemptId, q.slot, {
            status: "pending",
            score: null,
            passed: false,
            explanation: "주관식 채점 대기",
            reason: "unknown",
            criteria: [],
            actor: "app",
          });
        else {
          const correct =
            JSON.stringify([...a.value].sort()) ===
            JSON.stringify([...q.answer].sort());
          this.assess(attemptId, q.slot, {
            status: "confirmed",
            score: correct ? q.points : 0,
            passed: correct,
            explanation: q.explanation,
            reason: "unknown",
            criteria: [],
            actor: "app",
          });
        }
      }
      this.rebuild(this.store.get("exams", r.exam_id).goal_id);
      return this.result(attemptId);
    });
  }
  expire() {
    const rows = this.store.all(
      "SELECT id FROM attempts WHERE status='active' AND deadline IS NOT NULL AND deadline<=?",
      now(),
    );
    for (const r of rows) this.submit(r.id, "deadline:" + r.id, true);
    return rows.map((r) => r.id);
  }
  latest(attemptId: string, slot: number) {
    const row = this.store.one(
      "SELECT * FROM assessments WHERE attempt_id=? AND slot=? ORDER BY version DESC LIMIT 1",
      attemptId,
      slot,
    );
    return row
      ? {
          id: row.id,
          version: row.version,
          status: row.status,
          ...decode(row.data),
        }
      : null;
  }
  assess(attemptId: string, slot: number, data: any, expectedVersion?: number) {
    const attempt = this.store.get("attempts", attemptId);
    requireThat(
      attempt.status === "submitted",
      "NOT_SUBMITTED",
      "제출 후 채점할 수 있습니다.",
      409,
    );
    const item = this.store.one(
      "SELECT data FROM exam_items WHERE exam_id=? AND slot=?",
      attempt.exam_id,
      slot,
    );
    requireThat(item, "SLOT", "없는 문항");
    const q = decode(item.data);
    const old = this.latest(attemptId, slot);
    if (expectedVersion !== undefined)
      requireThat(
        (old?.version ?? 0) === expectedVersion,
        "ASSESSMENT_CONFLICT",
        "채점 결과가 변경되었습니다.",
        409,
      );
    requireThat(
      data.status === "pending" ||
        (Number.isFinite(data.score) &&
          data.score >= 0 &&
          data.score <= q.points),
      "SCORE",
      "점수 범위를 벗어났습니다.",
    );
    if (data.status === "pending")
      data = { ...data, score: null, passed: false };
    const assessmentId = id();
    this.store.run(
      "INSERT INTO assessments VALUES(?,?,?,?,?,?,?)",
      assessmentId,
      attemptId,
      slot,
      (old?.version ?? 0) + 1,
      data.status,
      JSON.stringify({ ...data, supersedes: old?.id ?? null }),
      now(),
    );
    return this.latest(attemptId, slot);
  }
  aiGrade(
    attemptId: string,
    slot: number,
    input: unknown,
    expectedVersion: number,
  ) {
    const data = gradeOutput.parse(input);
    const attempt = this.store.get("attempts", attemptId);
    const q = decode(
      this.store.one(
        "SELECT data FROM exam_items WHERE exam_id=? AND slot=?",
        attempt.exam_id,
        slot,
      )?.data,
    );
    requireThat(q.type === "short", "TYPE", "주관식 평가만 가능합니다.");
    const answer = decode(
      this.store.one(
        "SELECT data FROM answers WHERE attempt_id=? AND slot=?",
        attemptId,
        slot,
      )?.data,
    );
    if (data.status === "confirmed") {
      requireThat(
        data.criteria.length === q.rubric.length &&
          new Set(data.criteria.map((c) => c.id)).size === q.rubric.length,
        "RUBRIC",
        "채점 기준 누락·중복",
      );
      for (const c of data.criteria) {
        const rubric = q.rubric.find((r: any) => r.id === c.id);
        requireThat(
          rubric && c.score <= rubric.points,
          "RUBRIC_SCORE",
          "기준별 배점 초과",
        );
        requireThat(
          !c.evidence || answer.value.includes(c.evidence),
          "GRADE_EVIDENCE",
          "답안에 없는 인용",
        );
        if (c.score > 0)
          requireThat(
            c.evidence,
            "GRADE_EVIDENCE",
            "득점에는 답안 근거가 필요합니다.",
          );
      }
      const required = q.rubric.filter((r: any) => r.required);
      // An empty required set must not make every answer pass vacuously.
      const passCriteria = required.length ? required : q.rubric;
      const meets = passCriteria.every(
        (r: any) =>
          data.criteria.find((c) => c.id === r.id)?.score === r.points,
      );
      requireThat(
        data.passed === meets,
        "GRADE_PASS",
        "필수 기준과 통과 판정이 다릅니다.",
      );
    }
    return this.store.tx(() => {
      const result = this.assess(
        attemptId,
        slot,
        {
          ...data,
          score:
            data.status === "confirmed"
              ? data.criteria.reduce((s, c) => s + c.score, 0)
              : null,
          actor: "codex",
        },
        expectedVersion,
      );
      this.rebuild(this.store.get("exams", attempt.exam_id).goal_id);
      return result;
    });
  }
  manual(
    attemptId: string,
    slot: number,
    input: {
      score: number | null;
      passed: boolean;
      status: "confirmed" | "pending";
      reason: string;
      explanation: string;
      expectedVersion: number;
    },
  ) {
    const r = this.store.get("attempts", attemptId);
    return this.store.tx(() => {
      const previous = this.latest(attemptId, slot);
      const result = this.assess(
        attemptId,
        slot,
        {
          ...input,
          actor: "user",
          criteria: [],
          ...(previous?.correctionRevision
            ? {
                correctionRevision: previous.correctionRevision,
                correctedAnswer: previous.correctedAnswer,
                correctedExplanation: previous.correctedExplanation,
              }
            : {}),
        },
        input.expectedVersion,
      );
      this.rebuild(this.store.get("exams", r.exam_id).goal_id);
      return result;
    });
  }
  regradeQuestion(questionId: string, revisionId: string, reason: string) {
    const correction = this.exams.catalog.readQuestion(questionId, revisionId);
    requireThat(
      this.exams.catalog.readQuestion(questionId).revisionId === revisionId,
      "REVISION_CONFLICT",
      "최신 문항 버전을 확인한 뒤 재채점하세요.",
      409,
    );
    requireThat(
      correction.status === "usable",
      "REVIEW_REQUIRED",
      "정정 문항을 먼저 검토하세요.",
      409,
    );
    return this.store.tx(() => {
      const affected = [];
      const rows = this.store.all(
        "SELECT a.id AS attempt_id,i.slot,i.data FROM attempts a JOIN exam_items i ON i.exam_id=a.exam_id WHERE a.status='submitted'",
      );
      for (const row of rows) {
        const original = decode(row.data);
        if (original.id !== questionId) continue;
        if (original.revisionId === revisionId) continue;
        const previous = this.latest(row.attempt_id, row.slot);
        if (previous?.correctionRevision === revisionId) continue;
        const compatible =
          original.type === correction.type &&
          original.points === correction.points &&
          original.stem === correction.stem &&
          original.passage === correction.passage &&
          JSON.stringify(
            [...original.choices].sort((a: any, b: any) =>
              a.id.localeCompare(b.id),
            ),
          ) ===
            JSON.stringify(
              [...correction.choices].sort((a: any, b: any) =>
                a.id.localeCompare(b.id),
              ),
            );
        const answer = decode(
          this.store.one(
            "SELECT data FROM answers WHERE attempt_id=? AND slot=?",
            row.attempt_id,
            row.slot,
          )?.data ?? "null",
        );
        let assessment: any = {
          status: "pending",
          score: null,
          passed: false,
          actor: "correction",
          reason: "unknown",
          explanation: reason,
          criteria: [],
          correctionRevision: revisionId,
        };
        if (compatible && correction.type !== "short") {
          const correct =
            answer &&
            JSON.stringify([...answer.value].sort()) ===
              JSON.stringify([...correction.answer].sort());
          assessment = {
            ...assessment,
            status: "confirmed",
            score: correct ? correction.points : 0,
            passed: !!correct,
            correctedAnswer: correction.answer,
            correctedExplanation: correction.explanation,
          };
        } else
          assessment.explanation =
            reason + " (문항 내용 또는 주관식 기준 변경: 사용자 재검토 필요)";
        this.assess(row.attempt_id, row.slot, assessment, previous.version);
        affected.push({
          attemptId: row.attempt_id,
          slot: row.slot,
          status: assessment.status,
        });
      }
      this.rebuild(correction.goalId);
      return { questionId, revisionId, affected };
    });
  }
  result(attemptId: string) {
    const a = this.store.get("attempts", attemptId);
    requireThat(
      a.status === "submitted",
      "NOT_SUBMITTED",
      "아직 제출하지 않았습니다.",
      409,
    );
    const exam = this.exams.get(a.exam_id, true);
    const items = exam.items.map((q: any) => {
      const assessment = this.latest(attemptId, q.slot);
      return {
        ...q,
        // Read the exact revision that authored the displayed explanation. Never
        // rewrite prose or mutate the frozen, shuffled exam choices.
        explanationChoiceOrder: this.exams.catalog
          .readQuestion(
            q.id,
            assessment?.correctedAnswer
              ? assessment.correctionRevision
              : q.revisionId,
          )
          .choices.map((choice: any) => choice.id),
        answerGiven: decode(
          this.store.one(
            "SELECT data FROM answers WHERE attempt_id=? AND slot=?",
            attemptId,
            q.slot,
          )?.data ?? "null",
        ),
        assessment,
      };
    });
    const confirmed = items.filter(
      (i: any) => i.assessment?.status === "confirmed",
    );
    const earned = confirmed.reduce(
        (s: number, i: any) => s + i.assessment.score,
        0,
      ),
      possible = confirmed.reduce((s: number, i: any) => s + i.points, 0),
      total = items.reduce((s: number, i: any) => s + i.points, 0),
      pending = items.length - confirmed.length;
    return {
      attemptId,
      goalId: exam.goalId,
      earned,
      confirmedPossible: possible,
      totalPossible: total,
      pending,
      finalScore: pending ? null : earned,
      items,
    };
  }
  rebuild(goalId: string) {
    const zone = this.exams.catalog.readGoal(goalId).timezone;
    const attempts = this.store.all(
      "SELECT a.* FROM attempts a JOIN exams e ON a.exam_id=e.id WHERE e.goal_id=? AND a.status='submitted' ORDER BY a.submitted_at,a.id",
      goalId,
    );
    this.store.run("DELETE FROM review_events WHERE goal_id=?", goalId);
    this.store.run("DELETE FROM review_states WHERE goal_id=?", goalId);
    const states = new Map<string, Card>(),
      seen = new Set<string>();
    for (const attempt of attempts) {
      for (const item of this.result(attempt.id).items) {
        const assessment = item.assessment;
        if (!assessment || assessment.status !== "confirmed") continue;
        const answer = item.answerGiven ?? {
          hintUsed: false,
          uncertain: false,
          recall: null,
        };
        const day = dayAt(attempt.submitted_at, zone),
          familyDay = item.familyId + ":" + day;
        let excluded: string | null = null;
        if (answer.hintUsed) excluded = "hint_used";
        else if (seen.has(familyDay)) excluded = "same_family_same_day";
        let rating = assessment.passed
          ? answer.recall === "easy"
            ? Rating.Easy
            : answer.recall === "hard" || answer.uncertain
              ? Rating.Hard
              : Rating.Good
          : Rating.Again;
        if (!excluded) {
          seen.add(familyDay);
          const card =
            states.get(item.id) ??
            createEmptyCard<Card>(new Date(attempt.submitted_at));
          states.set(
            item.id,
            this.scheduler.next(card, new Date(attempt.submitted_at), rating)
              .card,
          );
        }
        const data = {
          assessmentId: assessment.id,
          passed: assessment.passed,
          uncertain: answer.uncertain,
          conceptIds: item.conceptIds,
          variant: !!item.parentId,
          rating,
          excluded,
          affectsSchedule: !excluded,
          day,
          algorithm: "ts-fsrs@5.4.2",
          mappingVersion: 1,
        };
        this.store.run(
          "INSERT INTO review_events VALUES(?,?,?,?,?,?,?,?)",
          id(),
          goalId,
          item.id,
          item.familyId,
          attempt.id,
          item.slot,
          JSON.stringify(data),
          attempt.submitted_at,
        );
      }
    }
    for (const [questionId, card] of states)
      this.store.run(
        "INSERT INTO review_states VALUES(?,?,?,?)",
        questionId,
        goalId,
        card.due.toISOString(),
        JSON.stringify(card),
      );
  }
  progress(goalId: string) {
    const scope = this.exams.catalog.latestScope(goalId);
    const events = this.store
      .all(
        "SELECT data,occurred_at,attempt_id,slot FROM review_events WHERE goal_id=? ORDER BY occurred_at,attempt_id,slot",
        goalId,
      )
      .map((r) => ({
        ...decode(r.data),
        at: r.occurred_at,
        attemptId: r.attempt_id,
        slot: r.slot,
      }));
    return (scope?.concepts ?? []).map((c: any) => {
      const all = events.filter((e) => e.conceptIds.includes(c.id)),
        valid = all.filter((e) => !e.excluded),
        latest = valid.at(-1),
        latestAttempt = valid.filter((e) => e.attemptId === latest?.attemptId),
        last = latestAttempt.find((e) => !e.passed || e.uncertain) ?? latest,
        lastWeak = valid.findLast((e) => !e.passed || e.uncertain),
        freshSuccesses = valid.filter(
          (e) =>
            e.passed && !e.uncertain && (!lastWeak || e.day > lastWeak.day),
        ),
        days = new Set(freshSuccesses.map((e) => e.day));
      const status = !all.length
        ? "unseen"
        : last && (!last.passed || last.uncertain)
          ? "review_needed"
          : days.size >= 2 && freshSuccesses.some((e) => e.variant)
            ? "confirmed_multiple_times"
            : "learning";
      return {
        ...c,
        status,
        attempts: all.length,
        independentSuccessDays: days.size,
        lastEvidence: last ?? null,
      };
    });
  }
  wrong(goalId: string) {
    const rows = this.store.all(
      "SELECT a.id FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE e.goal_id=? AND a.status='submitted' ORDER BY a.submitted_at DESC",
      goalId,
    );
    return rows.flatMap((r) =>
      this.result(r.id)
        .items.filter(
          (i: any) =>
            i.assessment.status === "confirmed" &&
            (!i.assessment.passed || i.answerGiven?.uncertain),
        )
        .map((i: any) => ({ attemptId: r.id, ...i })),
    );
  }
}
