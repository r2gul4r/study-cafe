import { z } from "zod";
import { Store } from "./store.js";
import type { SourceCheck } from "./source-quality.js";
import {
  sameCorrectionQuestion,
  hasAnswerError,
  correctionToken,
  type Correction,
  type CorrectionCheck,
} from "./corrections.js";
import { validateVisualEvidence } from "./pdf-visuals.js";
import {
  id,
  now,
  decode,
  requireThat,
  goalInput,
  scopeInput,
  questionInput,
  canonicalQuestion,
  type Question,
} from "./core.js";

export class Catalog {
  constructor(public store: Store) {}
  goal(input: unknown) {
    const data = goalInput.parse(input);
    const recordId = id();
    this.store.run(
      "INSERT INTO goals(id,data,created_at) VALUES(?,?,?)",
      recordId,
      JSON.stringify(data),
      now(),
    );
    return this.readGoal(recordId);
  }
  readGoal(recordId: string) {
    const r = this.store.get("goals", recordId);
    return {
      id: r.id,
      ...decode(r.data),
      archived: !!r.archived,
      createdAt: r.created_at,
      scope: this.latestScope(recordId),
    };
  }
  latestScope(goalId: string) {
    const r = this.store.one(
      "SELECT * FROM scopes WHERE goal_id=? ORDER BY version DESC LIMIT 1",
      goalId,
    );
    return r ? { id: r.id, version: r.version, ...decode(r.data) } : null;
  }
  updateGoal(goalId: string, input: unknown) {
    const goal = this.store.get("goals", goalId);
    const data = goalInput.parse({
      ...decode<any>(goal.data),
      ...z.record(z.string(), z.unknown()).parse(input),
    });
    this.store.run(
      "UPDATE goals SET data=? WHERE id=?",
      JSON.stringify(data),
      goalId,
    );
    return this.readGoal(goalId);
  }
  scope(goalId: string, input: unknown) {
    const goal = this.store.get("goals", goalId);
    requireThat(!goal.archived, "ARCHIVED", "보관된 목표입니다.");
    const data = scopeInput.parse(input);
    requireThat(
      new Set(data.concepts.map((c) => c.id ?? c.area + "\0" + c.name)).size ===
        data.concepts.length,
      "DUPLICATE_CONCEPT",
      "개념이 중복됩니다.",
    );
    return this.store.tx(() => {
      data.concepts = data.concepts.map((c) => {
        const conceptId = c.id ?? id();
        const old = this.store.one(
          "SELECT * FROM concepts WHERE id=?",
          conceptId,
        );
        if (old)
          requireThat(
            old.goal_id === goalId &&
              old.name === c.name &&
              old.area === c.area,
            "CONCEPT_SCOPE",
            "기존 개념과 일치하지 않습니다.",
          );
        else
          this.store.run(
            "INSERT INTO concepts VALUES(?,?,?,?)",
            conceptId,
            goalId,
            c.name,
            c.area,
          );
        return { ...c, id: conceptId };
      });
      const format = data.examFormat;
      if (format?.sections.length) {
        requireThat(
          format.sections.reduce((n, s) => n + s.count, 0) === format.total &&
            format.sections.reduce((n, s) => n + s.minutes, 0) ===
              format.minutes,
          "EXAM_FORMAT",
          "공식 섹션의 문항 수·시간 합계가 전체와 다릅니다.",
        );
        const ids = new Set(data.concepts.map((c) => c.id));
        requireThat(
          format.sections.every((s) => s.conceptIds.every((id) => ids.has(id))),
          "SECTION_SCOPE",
          "섹션에 현재 범위에 없는 개념이 있습니다.",
        );
      }
      const scopeId = id(),
        version = (this.latestScope(goalId)?.version ?? 0) + 1;
      this.store.run(
        "INSERT INTO scopes VALUES(?,?,?,?,?)",
        scopeId,
        goalId,
        version,
        JSON.stringify(data),
        now(),
      );
      return { id: scopeId, version, ...data };
    });
  }
  source(goalId: string, input: unknown) {
    this.store.get("goals", goalId);
    const data = sourceInput.parse(input);
    if (data.rights !== "link_only")
      requireThat(
        data.rightsBasis,
        "RIGHTS_BASIS",
        "자료 이용 근거가 필요합니다.",
      );
    const existing = data.url
      ? this.store
          .all("SELECT * FROM sources WHERE goal_id=?", goalId)
          .find((r) => decode(r.data).url === data.url)
      : null;
    if (existing) return this.readSource(existing.id);
    const sourceId = id();
    this.store.run(
      "INSERT INTO sources VALUES(?,?,?,?,?)",
      sourceId,
      goalId,
      JSON.stringify(data),
      "discovered",
      now(),
    );
    return this.readSource(sourceId);
  }
  readSource(sourceId: string) {
    const r = this.store.get("sources", sourceId);
    return {
      id: r.id,
      goalId: r.goal_id,
      ...decode(r.data),
      status: r.status,
      revisions: this.store
        .all(
          "SELECT * FROM source_revisions WHERE source_id=? ORDER BY created_at",
          sourceId,
        )
        .map((v) => ({
          id: v.id,
          ...decode(v.data),
          hash: v.hash,
          createdAt: v.created_at,
        })),
    };
  }
  segments(sourceId: string) {
    this.store.get("sources", sourceId);
    return this.store
      .all(
        "SELECT s.* FROM segments s JOIN source_revisions r ON r.id=s.revision_id WHERE r.source_id=? ORDER BY r.created_at,s.ordinal",
        sourceId,
      )
      .map((r) => ({ ...r, locator: decode(r.locator) }));
  }
  validateQuestion(q: Question) {
    const scope = this.store.get("scopes", q.scopeId);
    requireThat(scope.goal_id === q.goalId, "SCOPE", "목표 범위가 다릅니다.");
    const ids = new Set(decode(scope.data).concepts.map((c: any) => c.id));
    requireThat(
      q.conceptIds.every((c) => ids.has(c)),
      "CONCEPT",
      "범위에 없는 개념입니다.",
    );
    if (q.parentId) {
      const p = this.store.get("questions", q.parentId);
      requireThat(p.goal_id === q.goalId, "PARENT", "원본 목표가 다릅니다.");
      if (q.familyId)
        requireThat(
          q.familyId === p.family_id,
          "FAMILY",
          "원본 문제 계열이 다릅니다.",
        );
      q.familyId = p.family_id;
    }
    for (const e of q.evidence) {
      const r = this.store.one(
        "SELECT s.text,src.goal_id,src.data FROM segments s JOIN source_revisions r ON r.id=s.revision_id JOIN sources src ON src.id=r.source_id WHERE s.id=?",
        e.segmentId,
      );
      requireThat(
        r && r.goal_id === q.goalId,
        "EVIDENCE",
        "다른 목표이거나 없는 근거입니다.",
      );
      requireThat(
        r.text.includes(e.quote),
        "EVIDENCE_QUOTE",
        "인용문이 원문에 없습니다.",
      );
    }
    for (const a of q.requiredAssetIds) this.store.get("assets", a);
    validateVisualEvidence(this.store, q);
    requireThat(
      q.evidence.length > 0,
      "EVIDENCE_REQUIRED",
      "정답 검토용 자료 근거가 필요합니다.",
    );
    if (q.origin === "past_exam")
      requireThat(
        q.evidence.some((e) => {
          const s = this.store.one(
            "SELECT src.data FROM segments seg JOIN source_revisions r ON r.id=seg.revision_id JOIN sources src ON src.id=r.source_id WHERE seg.id=?",
            e.segmentId,
          );
          return s && decode(s.data).kind === "past_exam";
        }),
        "PAST_EXAM",
        "실제 기출로 분류된 출처가 필요합니다.",
      );
  }
  createQuestion(
    input: unknown,
    options: {
      questionId?: string;
      transaction?: boolean;
      expectedRevisionId?: string;
      correction?: Correction;
    } = {},
  ) {
    const q = questionInput.parse(input);
    const previous = options.questionId
      ? this.readQuestion(options.questionId)
      : null;
    requireThat(
      !previous ||
        !hasAnswerError(previous) ||
        !!options.correction ||
        !!previous.review?.answerCorrection,
      "CORRECTION_REQUIRED",
      "원본 정답 오류가 있는 문항은 원본 정답 정정 기능을 이용하세요.",
    );
    const inherited: Correction | undefined =
      options.correction ?? previous?.review?.answerCorrection;
    if (inherited) {
      const original = this.readQuestion(
        options.questionId!,
        inherited.originalRevisionId,
      );
      requireThat(
        sameCorrectionQuestion(original, q),
        "CORRECTION_QUESTION_CHANGED",
        "원본 정답 정정에서는 문제·보기·배점·출처를 변경할 수 없습니다.",
      );
    }
    this.validateQuestion(q);
    const fingerprint = canonicalQuestion(q);
    let duplicate = this.store.one(
      "SELECT q.id FROM questions q JOIN question_revisions r ON r.id=q.current_revision WHERE q.goal_id=? AND json_extract(r.data,'$.scopeId')=? AND r.fingerprint=? AND q.archived=0",
      q.goalId,
      q.scopeId,
      fingerprint,
    );
    if (
      !duplicate &&
      !options.questionId &&
      q.sourceMatch &&
      ["past_exam", "official_practice", "external_practice"].includes(q.origin)
    ) {
      // Re-extraction may include/omit a section heading in the shared passage.
      // A unique literal stem on the same stored source segment still denotes
      // the same printed question. Ambiguous repeated stems keep the existing
      // full-content fingerprint path; never merge by '(a)' alone.
      const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
      const stem = normalize(q.stem);
      const segmentId = q.sourceMatch.questionEvidence.segmentId;
      const original = normalize(this.store.get("segments", segmentId).text);
      const position = original.indexOf(stem);
      if (position >= 0 && original.indexOf(stem, position + 1) < 0) {
        duplicate = this.store
          .all(
            "SELECT q.id,r.data FROM questions q JOIN question_revisions r ON r.id=q.current_revision WHERE q.goal_id=? AND q.archived=0 AND json_extract(r.data,'$.scopeId')=? AND json_extract(r.data,'$.sourceMatch.questionEvidence.segmentId')=?",
            q.goalId,
            q.scopeId,
            segmentId,
          )
          .find((row) => {
            const old = decode<Question>(row.data);
            return (
              old.type === q.type &&
              old.origin === q.origin &&
              JSON.stringify([...(old.requiredAssetIds ?? [])].sort()) ===
                JSON.stringify([...q.requiredAssetIds].sort()) &&
              normalize(old.stem) === stem &&
              old.sourceMatch?.questionReference ===
                q.sourceMatch!.questionReference
            );
          });
      }
    }
    if (duplicate && !options.questionId) {
      const existing = this.readQuestion(duplicate.id);
      for (const e of q.evidence)
        this.store.run(
          "INSERT OR IGNORE INTO question_evidence VALUES(?,?,?)",
          existing.revisionId,
          e.segmentId,
          e.quote,
        );
      return { ...this.readQuestion(duplicate.id), duplicate: true };
    }
    const save = () => {
      const questionId = options.questionId ?? id();
      let version = 1;
      if (options.questionId) {
        const old = this.store.get("questions", questionId);
        requireThat(
          !options.expectedRevisionId ||
            old.current_revision === options.expectedRevisionId,
          "REVISION_CONFLICT",
          "다른 곳에서 문항이 수정되었습니다. 입력한 내용을 보존한 뒤 최신 버전을 확인하세요.",
          409,
        );
        requireThat(
          old.goal_id === q.goalId,
          "GOAL",
          "문제의 목표를 변경할 수 없습니다.",
        );
        q.familyId = old.family_id;
        version =
          this.store.one(
            "SELECT MAX(version) n FROM question_revisions WHERE question_id=?",
            questionId,
          ).n + 1;
      } else
        this.store.run(
          "INSERT INTO questions(id,goal_id,family_id,created_at) VALUES(?,?,?,?)",
          questionId,
          q.goalId,
          q.familyId ?? questionId,
          now(),
        );
      const revisionId = id();
      q.familyId = this.store.get("questions", questionId).family_id;
      this.store.run(
        "INSERT INTO question_revisions VALUES(?,?,?,?,?,?)",
        revisionId,
        questionId,
        version,
        fingerprint,
        JSON.stringify(q),
        now(),
      );
      this.store.run(
        "UPDATE questions SET current_revision=? WHERE id=?",
        revisionId,
        questionId,
      );
      this.store.run(
        "INSERT INTO question_status VALUES(?,?,?)",
        revisionId,
        "needs_review",
        JSON.stringify({
          reason: "검토 대기",
          ...(inherited
            ? {
                answerCorrection: {
                  originalRevisionId: inherited.originalRevisionId,
                  reason: inherited.reason,
                  originalAudit: inherited.originalAudit,
                  evidence: inherited.evidence,
                  createdAt: now(),
                },
              }
            : {}),
        }),
      );
      for (const e of q.evidence)
        this.store.run(
          "INSERT INTO question_evidence VALUES(?,?,?)",
          revisionId,
          e.segmentId,
          e.quote,
        );
      this.store.run(
        "DELETE FROM question_search WHERE question_id=?",
        questionId,
      );
      this.store.run(
        "INSERT INTO question_search VALUES(?,?)",
        questionId,
        q.stem + " " + q.choices.map((c) => c.text).join(" "),
      );
      return this.readQuestion(questionId);
    };
    return options.transaction === false ? save() : this.store.tx(save);
  }
  readQuestion(questionId: string, revisionId?: string) {
    const r = this.store.get("questions", questionId);
    const rev = this.store.get(
      "question_revisions",
      revisionId ?? r.current_revision,
    );
    requireThat(
      rev.question_id === questionId,
      "REVISION",
      "문제 버전이 다릅니다.",
    );
    const state = this.store.one(
      "SELECT * FROM question_status WHERE revision_id=?",
      rev.id,
    );
    const review = decode(state.review);
    return {
      id: questionId,
      revisionId: rev.id,
      version: rev.version,
      ...decode(rev.data),
      evidence: this.store.all(
        "SELECT segment_id AS segmentId,quote FROM question_evidence WHERE revision_id=?",
        rev.id,
      ),
      status: state.status,
      review,
      ...(review.answerCorrection
        ? {
            correctionReviewToken: correctionToken({
              revisionId: rev.id,
              review,
            }),
          }
        : {}),
      archived: !!r.archived,
    };
  }
  questionRevisions(questionId: string) {
    this.store.get("questions", questionId);
    return this.store
      .all(
        "SELECT id,created_at FROM question_revisions WHERE question_id=? ORDER BY version DESC",
        questionId,
      )
      .map((revision) => ({
        ...this.readQuestion(questionId, revision.id),
        createdAt: revision.created_at,
      }));
  }
  questionEvidence(questionId: string, revisionId?: string) {
    const question = this.readQuestion(questionId, revisionId);
    return question.evidence.map((e: { segmentId: string; quote: string }) => {
      const row = this.store.one(
        "SELECT seg.text,seg.locator,src.goal_id,src.id source_id,src.data source_data,r.id revision_id,r.data revision_data,r.created_at FROM segments seg JOIN source_revisions r ON r.id=seg.revision_id JOIN sources src ON src.id=r.source_id WHERE seg.id=?",
        e.segmentId,
      );
      requireThat(
        row && row.goal_id === question.goalId,
        "EVIDENCE",
        "목표에 속한 원문 근거가 아닙니다.",
      );
      const source = decode(row.source_data),
        revision = decode(row.revision_data);
      const match = question.sourceMatch;
      const same = (v: any) =>
        v?.segmentId === e.segmentId && v.quote === e.quote;
      return {
        ...e,
        sourceId: row.source_id,
        sourceRevisionId: row.revision_id,
        title: source.title,
        kind: source.kind,
        url: revision.url ?? null,
        acquiredAt: row.created_at,
        locator: decode(row.locator),
        text: row.text,
        role: same(match?.questionEvidence)
          ? "question"
          : same(match?.answerEvidence) ||
              match?.answerContinuationEvidence?.some(same)
            ? "answer"
            : match?.editionEvidence.some(same)
              ? "edition"
              : "support",
      };
    });
  }
  review(
    revisionId: string,
    status: "usable" | "needs_review" | "retired",
    reason: string,
    actor = "user",
    sourceCheck?: SourceCheck | null,
    correctionCheck?: CorrectionCheck | null,
    visualCheck?: {
      faithful: boolean;
      complete: boolean;
      noAnswerLeak: boolean;
      reason: string;
    } | null,
  ) {
    const rev = this.store.get("question_revisions", revisionId);
    const q = this.readQuestion(rev.question_id, revisionId);
    const correction: Correction | undefined = q.review?.answerCorrection;
    if (
      actor === "codex" &&
      q.review.actor === "user" &&
      (correction?.confirmedAt || q.status === "retired")
    )
      return q;
    if (actor === "user" && status === "usable")
      requireThat(
        !correction && !hasAnswerError(q),
        "CORRECTION_CONFIRM_REQUIRED",
        "원본 정답 오류는 정정안을 저장하고 독립 검토한 뒤 정정 확정 버튼으로 확정하세요.",
      );
    // A new verdict or manual state change must not erase a known source error.
    if (!correction && hasAnswerError(q)) {
      sourceCheck = q.review.sourceCheck;
      if (status === "usable") status = "needs_review";
    }
    const correctionPassed =
      status === "usable" &&
      !!correctionCheck?.correctedAnswerValid &&
      !!correctionCheck.allIssuesAddressed;
    if (correction && actor === "codex") status = "needs_review";
    requireThat(reason.trim(), "REASON", "검토 근거가 필요합니다.");
    if (status === "usable")
      this.validateQuestion(questionInput.parse(decode(rev.data)));
    this.store.run(
      "UPDATE question_status SET status=?,review=? WHERE revision_id=?",
      status,
      JSON.stringify({
        actor,
        reason,
        at: now(),
        ...(sourceCheck ? { sourceCheck, sourcePolicyVersion: 1 } : {}),
        ...(visualCheck ? { visualCheck } : {}),
        ...(correction
          ? {
              answerCorrection: {
                ...correction,
                confirmedAt: undefined,
                verification: undefined,
                ...(actor === "codex"
                  ? {
                      verification: {
                        ...(correctionCheck ?? {
                          correctedAnswerValid: false,
                          allIssuesAddressed: false,
                          reason: "정정 검토 결과 없음",
                        }),
                        passed: correctionPassed,
                        at: now(),
                      },
                    }
                  : {}),
              },
            }
          : {}),
      }),
      revisionId,
    );
    return this.readQuestion(rev.question_id, revisionId);
  }
  listQuestions(
    goalId: string,
    filters: {
      q?: string;
      origin?: string;
      type?: string;
      status?: string;
      conceptId?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) {
    let rows = this.store
      .all(
        "SELECT id FROM questions WHERE goal_id=? AND archived=0 ORDER BY created_at,id",
        goalId,
      )
      .map((r) => this.readQuestion(r.id));
    if (filters.q) {
      const needle = filters.q.normalize("NFKC").toLocaleLowerCase();
      rows = rows.filter((q) =>
        (q.stem + " " + q.choices.map((c: any) => c.text).join(" "))
          .normalize("NFKC")
          .toLocaleLowerCase()
          .includes(needle),
      );
    }
    rows = rows.filter(
      (q) =>
        (!filters.origin || q.origin === filters.origin) &&
        (!filters.type || q.type === filters.type) &&
        (!filters.status || q.status === filters.status) &&
        (!filters.conceptId || q.conceptIds.includes(filters.conceptId)),
    );
    return {
      total: rows.length,
      items: rows.slice(
        filters.offset ?? 0,
        (filters.offset ?? 0) + (filters.limit ?? 50),
      ),
    };
  }
}
export const sourceInput = z
  .object({
    title: z.string().min(1).max(300),
    url: z.url().nullable().default(null),
    publisher: z.string().max(300).default(""),
    kind: z
      .enum([
        "past_exam",
        "official_practice",
        "external_practice",
        "reference",
        "user_material",
      ])
      .default("reference"),
    rights: z
      .enum(["link_only", "allowed", "user_provided"])
      .default("link_only"),
    rightsBasis: z.string().max(5000).default(""),
    examEvidence: z.string().max(5000).nullable().default(null),
    answerSourceIds: z.array(z.string()).max(20).default([]),
  })
  .strict();
