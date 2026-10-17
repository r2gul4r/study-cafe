import { Store } from "./store.js";
import { Catalog } from "./catalog.js";
import { reviewQueue } from "./reviews.js";
import { ExamSections } from "./exam-sections.js";
import {
  decode,
  id,
  now,
  requireThat,
  templateInput,
  shuffled,
  type Template,
  Fault,
} from "./core.js";

export class Exams {
  constructor(public catalog: Catalog) {}
  get store() {
    return this.catalog.store;
  }
  get sections() {
    return new ExamSections(this.store);
  }
  template(input: unknown) {
    const data = templateInput.parse(input),
      recordId = id();
    this.store.run(
      "INSERT INTO templates VALUES(?,?,?)",
      recordId,
      JSON.stringify(data),
      now(),
    );
    return { id: recordId, ...data };
  }
  createReview(goalId: string) {
    requireThat(
      !this.catalog.readGoal(goalId).archived,
      "ARCHIVED",
      "보관된 목표입니다.",
    );
    const due = reviewQueue(this.catalog, goalId).filter((r) => r.overdue);
    const familyIds = new Set(due.map((r) => r.familyId));
    const scope = this.catalog.latestScope(goalId);
    const bank = this.catalog.listQuestions(goalId, {
      status: "usable",
      limit: 100000,
    }).items;
    const selected = [...familyIds]
      .map((family) =>
        bank.find((q) => q.familyId === family && q.scopeId === scope?.id),
      )
      .filter((q) => !!q)
      .slice(0, 100);
    requireThat(
      selected.length,
      "NO_REVIEWS",
      "현재 범위에서 복습할 수 있는 문항이 없습니다. 문제은행의 검토 상태와 학습 범위를 확인하세요.",
      409,
    );
    const template = this.template({
      name: "오늘 복습",
      total: selected.length,
      single: selected.filter((q) => q.type === "single").length,
      multiple: selected.filter((q) => q.type === "multiple").length,
      short: selected.filter((q) => q.type === "short").length,
      python: selected.filter((q) => !!q.python).length,
      mode: "review",
      policy: "mixed",
    });
    // Keep the actual due concepts/types, rather than allocating a new syllabus.
    const examId = id();
    const slots = selected.map((q, i) => ({
      slot: i + 1,
      type: q.type,
      conceptId: q.conceptIds[0],
      difficulty: "any",
      execution: q.python ? "python" : null,
    }));
    this.store.run(
      "INSERT INTO exams VALUES(?,?,?,?,?,?)",
      examId,
      goalId,
      scope!.id,
      "preparing",
      JSON.stringify({ template, templateId: template.id, seed: id(), slots }),
      now(),
    );
    this.fillExisting(examId);
    return this.finalize(examId);
  }
  create(goalId: string, templateId: string, seed: string = id()) {
    const goal = this.catalog.readGoal(goalId);
    requireThat(!goal.archived, "ARCHIVED", "보관된 목표입니다.");
    const scope = goal.scope;
    requireThat(scope, "SCOPE_REQUIRED", "학습 범위를 먼저 저장하세요.", 409);
    const template: Template = decode(
      this.store.get("templates", templateId).data,
    );
    if (template.mode === "mock") {
      requireThat(
        scope.examFormat &&
          scope.examFormat.total === template.total &&
          scope.examFormat.minutes === template.minutes,
        "EXAM_FORMAT",
        "확인된 공식 시험 구성과 일치하지 않습니다.",
        409,
      );
      requireThat(
        JSON.stringify(template.sections ?? []) ===
          JSON.stringify(scope.examFormat.sections ?? []),
        "EXAM_FORMAT",
        "확인된 공식 섹션 구성과 일치하지 않습니다.",
        409,
      );
    }
    let concepts: any[] = scope.concepts;
    if (template.mode === "review") {
      const due = reviewQueue(this.catalog, goalId)
        .filter((r) => r.overdue)
        .flatMap((r) => this.catalog.readQuestion(r.questionId).conceptIds);
      concepts = concepts.filter((c) => due.includes(c.id));
      requireThat(
        concepts.length,
        "NO_REVIEWS",
        "예정된 복습이 없습니다.",
        409,
      );
    }
    if (template.mode === "weakness") {
      const failures = this.store
        .all("SELECT data FROM review_events WHERE goal_id=?", goalId)
        .map((r) => decode(r.data));
      concepts = concepts.map((c) => ({
        ...c,
        weight:
          c.weight *
          (1 +
            failures.filter((e) => !e.passed && e.conceptIds.includes(c.id))
              .length),
      }));
    }
    const totalWeight = concepts.reduce((s, c) => s + c.weight, 0);
    const counts = new Map<string, number>();
    const types = [
      ...Array(template.single).fill("single"),
      ...Array(template.multiple).fill("multiple"),
      ...Array(template.short).fill("short"),
    ];
    let pythonRemaining = template.python ?? 0;
    const slots = types.map((type, i) => {
      let boundary = 0;
      const section = template.sections?.find((s) => {
        boundary += s.count;
        return i < boundary;
      });
      const eligible = section?.conceptIds.length
        ? concepts.filter((c) => section.conceptIds.includes(c.id))
        : concepts;
      requireThat(
        eligible.length,
        "SECTION_SCOPE",
        "섹션에 해당하는 학습 개념이 없습니다.",
      );
      const concept = [...eligible].sort(
        (a, b) =>
          ((i + 1) * b.weight) / totalWeight -
          (counts.get(b.id) ?? 0) -
          (((i + 1) * a.weight) / totalWeight - (counts.get(a.id) ?? 0)),
      )[0]!;
      counts.set(concept.id, (counts.get(concept.id) ?? 0) + 1);
      return {
        slot: i + 1,
        type,
        execution: type === "short" && pythonRemaining-- > 0 ? "python" : null,
        conceptId: concept.id,
        difficulty: template.difficulty,
      };
    });
    const examId = id();
    this.store.run(
      "INSERT INTO exams VALUES(?,?,?,?,?,?)",
      examId,
      goalId,
      scope.id,
      "preparing",
      JSON.stringify({ template, templateId, seed, slots }),
      now(),
    );
    this.fillExisting(examId);
    return this.get(examId);
  }
  get(examId: string, withSecrets = false) {
    const r = this.store.get("exams", examId);
    const data = decode(r.data);
    return {
      id: r.id,
      goalId: r.goal_id,
      scopeId: r.scope_id,
      status: r.status,
      ...data,
      items: this.store
        .all("SELECT * FROM exam_items WHERE exam_id=? ORDER BY slot", examId)
        .map((i) => ({
          slot: i.slot,
          revisionId: i.revision_id,
          ...(withSecrets ? decode(i.data) : publicQuestion(decode(i.data))),
        })),
    };
  }
  fillExisting(examId: string) {
    const exam = this.get(examId, true);
    requireThat(
      exam.status === "preparing",
      "EXAM_STATE",
      "이미 고정된 시험입니다.",
      409,
    );
    if (exam.template.policy === "ai_only") return;
    const dueFamilies = new Set(
      reviewQueue(this.catalog, exam.goalId)
        .filter((r) => r.overdue)
        .map((r) => r.familyId),
    );
    const pool = this.catalog
      .listQuestions(exam.goalId, { status: "usable", limit: 100000 })
      .items.filter(
        (q) =>
          q.scopeId === exam.scopeId &&
          (exam.template.mode !== "review" || dueFamilies.has(q.familyId)) &&
          (exam.template.policy !== "past_only" || q.origin === "past_exam"),
      );
    const exposure = (q: any) =>
      this.store.one(
        "SELECT COUNT(*) n FROM exam_items WHERE revision_id=?",
        q.revisionId,
      ).n;
    const rank = (q: any) =>
      exam.template.policy === "official_first"
        ? [
            "past_exam",
            "official_practice",
            "external_practice",
            "ai_generated",
            "ai_variant",
          ].indexOf(q.origin)
        : 0;
    const candidates = shuffled(pool, exam.seed).sort(
      (a, b) => rank(a) - rank(b) || exposure(a) - exposure(b),
    );
    this.store.tx(() => {
      let state = this.get(examId, true);
      const families = new Set(state.items.map((q: any) => q.familyId));
      const used = new Set(state.items.map((q: any) => q.id));
      const empty = state.slots.filter(
        (s: any) => !state.items.some((i: any) => i.slot === s.slot),
      );
      const handled = new Set<string>();
      for (const q of candidates) {
        if (used.has(q.id) || handled.has(q.groupId ?? q.id)) continue;
        handled.add(q.groupId ?? q.id);
        const group = q.groupId
          ? candidates.filter((x) => x.groupId === q.groupId)
          : [q];
        if (group.some((x) => used.has(x.id) || families.has(x.familyId)))
          continue;
        const mapped: { q: any; slot: any }[] = [];
        const sections = exam.template.sections?.length
          ? exam.template.sections
          : [{ count: exam.template.total }];
        let firstSlot = 1;
        for (const section of sections) {
          const lastSlot = firstSlot + section.count - 1;
          const available = empty.filter(
            (s: { slot: number }) => s.slot >= firstSlot && s.slot <= lastSlot,
          );
          mapped.length = 0;
          const taken = new Set<number>();
          for (const member of group) {
            const slot = available.find(
              (s: any) => !taken.has(s.slot) && matches(member, s),
            );
            if (!slot) {
              mapped.length = 0;
              break;
            }
            taken.add(slot.slot);
            mapped.push({ q: member, slot });
          }
          if (mapped.length) break;
          firstSlot = lastSlot + 1;
        }
        if (!mapped.length) continue;
        for (const match of mapped) {
          this.place(examId, match.slot.slot, match.q);
          families.add(match.q.familyId);
          used.add(match.q.id);
          empty.splice(
            empty.findIndex((s: any) => s.slot === match.slot.slot),
            1,
          );
        }
      }
    });
  }
  place(examId: string, slotNumber: number, q: any) {
    const e = this.get(examId, true);
    requireThat(
      e.status === "preparing",
      "EXAM_STATE",
      "시험이 고정되었습니다.",
      409,
    );
    const slot = e.slots.find((s: any) => s.slot === slotNumber);
    requireThat(
      slot &&
        matches(q, slot) &&
        q.status === "usable" &&
        q.goalId === e.goalId &&
        q.scopeId === e.scopeId,
      "SLOT",
      "문항이 출제 조건과 다릅니다.",
    );
    requireThat(
      e.template.policy !== "past_only" || q.origin === "past_exam",
      "SOURCE_POLICY",
      "기출만 허용한 시험입니다.",
    );
    requireThat(
      e.template.policy !== "ai_only" ||
        ["ai_generated", "ai_variant"].includes(q.origin),
      "SOURCE_POLICY",
      "AI 문항만 허용한 시험입니다.",
    );
    requireThat(
      !e.items.some(
        (i: any) =>
          i.familyId === q.familyId && (!q.groupId || i.groupId !== q.groupId),
      ),
      "FAMILY_EXPOSURE",
      "같은 문제 계열이 이미 포함되어 있습니다.",
    );
    const snapshot = {
      ...q,
      choices: e.template.shuffleChoices
        ? shuffled(q.choices, e.seed + ":" + slotNumber)
        : q.choices,
    };
    this.store.run(
      "INSERT INTO exam_items VALUES(?,?,?,?)",
      examId,
      slotNumber,
      q.revisionId,
      JSON.stringify(snapshot),
    );
  }
  finalize(examId: string) {
    const exam = this.get(examId, true);
    requireThat(
      exam.status === "preparing",
      "EXAM_STATE",
      "이미 고정된 시험입니다.",
      409,
    );
    const missing = exam.slots.filter(
      (s: any) => !exam.items.some((i: any) => i.slot === s.slot),
    );
    requireThat(
      !missing.length,
      "INSUFFICIENT_QUESTIONS",
      "준비된 문항이 부족합니다.",
      409,
    );
    requireThat(
      exam.items.length === exam.template.total,
      "QUESTION_COUNT",
      "문항 수가 다릅니다.",
    );
    for (const i of exam.items) {
      const current = this.catalog.readQuestion(i.id, i.revisionId);
      requireThat(
        current.status === "usable",
        "REVIEW_REQUIRED",
        "검토 상태가 변경된 문항이 있습니다.",
        409,
      );
    }
    this.store.run("UPDATE exams SET status='ready' WHERE id=?", examId);
    return this.get(examId);
  }
  start(examId: string) {
    const e = this.get(examId);
    requireThat(
      e.status === "ready",
      "EXAM_NOT_READY",
      "시험 준비가 끝나지 않았습니다.",
      409,
    );
    const attemptId = id(),
      started = now();
    const deadline = e.template.minutes
      ? new Date(Date.parse(started) + e.template.minutes * 60000).toISOString()
      : null;
    this.store.run(
      "INSERT INTO attempts(id,exam_id,status,started_at,deadline) VALUES(?,?,?,?,?)",
      attemptId,
      examId,
      "active",
      started,
      deadline,
    );
    this.sections.start(attemptId, e.template, started);
    return this.attempt(attemptId);
  }
  attempt(attemptId: string) {
    const r = this.store.get("attempts", attemptId);
    return {
      id: r.id,
      examId: r.exam_id,
      status: r.status,
      startedAt: r.started_at,
      deadline: r.deadline,
      submittedAt: r.submitted_at,
      remainingMs: r.remaining_ms,
      section: this.sections.get(attemptId),
      exam: this.get(r.exam_id),
      answers: this.store
        .all(
          "SELECT * FROM answers WHERE attempt_id=? ORDER BY slot",
          attemptId,
        )
        .map((a) => ({
          slot: a.slot,
          version: a.version,
          ...decode(a.data),
          savedAt: a.updated_at,
        })),
    };
  }
  saveAnswer(
    attemptId: string,
    slot: number,
    data: {
      value: string | string[];
      version: number;
      flagged: boolean;
      uncertain: boolean;
      hintUsed: boolean;
      recall: "hard" | "good" | "easy" | null;
    },
  ) {
    const a = this.store.get("attempts", attemptId);
    requireThat(
      a.status === "active",
      "ATTEMPT_CLOSED",
      "진행 중인 시험이 아닙니다.",
      409,
    );
    requireThat(
      !a.deadline || Date.parse(a.deadline) > Date.now(),
      "DEADLINE",
      "시험 시간이 만료되었습니다.",
      409,
    );
    const item = this.store.one(
      "SELECT data FROM exam_items WHERE exam_id=? AND slot=?",
      a.exam_id,
      slot,
    );
    requireThat(item, "SLOT", "없는 문항입니다.");
    const q = decode(item.data);
    this.sections.assertSlot(attemptId, slot);
    if (q.type === "short")
      requireThat(
        typeof data.value === "string" && data.value.length <= 20000,
        "ANSWER",
        "주관식 답안은 텍스트여야 합니다.",
      );
    else
      requireThat(
        Array.isArray(data.value) &&
          new Set(data.value).size === data.value.length &&
          data.value.every((x) => q.choices.some((c: any) => c.id === x)) &&
          (q.type !== "single" || data.value.length <= 1),
        "ANSWER",
        "보기 답안이 올바르지 않습니다.",
      );
    return this.store.tx(() => {
      const old = this.store.one(
        "SELECT * FROM answers WHERE attempt_id=? AND slot=?",
        attemptId,
        slot,
      );
      requireThat(
        (old?.version ?? 0) === data.version,
        "ANSWER_CONFLICT",
        "다른 탭에서 변경된 답안입니다.",
        409,
      );
      const { version, ...payload } = data;
      const next = version + 1;
      this.store.run(
        "INSERT INTO answers VALUES(?,?,?,?,?) ON CONFLICT(attempt_id,slot) DO UPDATE SET version=excluded.version,data=excluded.data,updated_at=excluded.updated_at",
        attemptId,
        slot,
        next,
        JSON.stringify(payload),
        now(),
      );
      return { slot, version: next, ...payload };
    });
  }
  pause(attemptId: string, resume = false) {
    const r = this.store.get("attempts", attemptId),
      e = this.get(r.exam_id);
    requireThat(
      e.template.mode !== "mock",
      "MOCK_PAUSE",
      "실전 모드는 일시정지할 수 없습니다.",
      409,
    );
    requireThat(
      r.status === (resume ? "paused" : "active"),
      "ATTEMPT_STATE",
      "응시 상태가 다릅니다.",
      409,
    );
    if (!resume)
      requireThat(
        (!r.deadline || Date.parse(r.deadline) > Date.now()) &&
          (!this.sections.get(attemptId)?.deadline ||
            this.sections.get(attemptId)!.deadline! > now()),
        "DEADLINE",
        "시간이 만료됐습니다.",
        409,
      );
    const remaining = resume
      ? r.remaining_ms
      : r.deadline
        ? Math.max(0, Date.parse(r.deadline) - Date.now())
        : null;
    this.store.run(
      "UPDATE attempts SET status=?,deadline=?,remaining_ms=? WHERE id=?",
      resume ? "active" : "paused",
      resume && remaining !== null
        ? new Date(Date.now() + remaining).toISOString()
        : null,
      resume ? null : remaining,
      attemptId,
    );
    this.sections.pause(attemptId, resume);
    return this.attempt(attemptId);
  }
}
function matches(q: any, s: any) {
  return (
    q.type === s.type &&
    (q.python?.language ?? null) === (s.execution ?? null) &&
    q.conceptIds.includes(s.conceptId) &&
    (s.difficulty === "any" || q.difficulty === s.difficulty)
  );
}
export function publicQuestion(q: any) {
  const {
    answer,
    modelAnswer,
    rubric,
    explanation,
    evidence,
    sourceMatch,
    visualEvidence,
    learnerRegions,
    review,
    correctionReviewToken,
    pastExamEvidence,
    python,
    ...publicData
  } = q;
  return {
    ...publicData,
    ...(python
      ? {
          python: {
            ...python,
            tests: python.tests.filter((t: { hidden: boolean }) => !t.hidden),
            testCount: python.tests.length,
          },
        }
      : {}),
  };
}
