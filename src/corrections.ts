import { z } from "zod";
import {
  evidence,
  key,
  questionInput,
  requireThat,
  hash,
  now,
} from "./core.js";
import type { Catalog } from "./catalog.js";
import type { SourceCheck } from "./source-quality.js";

export const correctionCheckOutput = z
  .object({
    correctedAnswerValid: z.boolean(),
    allIssuesAddressed: z.boolean(),
    reason: z.string().min(1).max(5000),
  })
  .strict();
export type CorrectionCheck = z.infer<typeof correctionCheckOutput>;
export const correctionInput = z
  .object({
    expectedRevisionId: key,
    reason: z.string().trim().min(1).max(5000),
    evidence: z.array(evidence).min(1).max(10),
    answer: z.array(key).max(10),
    modelAnswer: z.string().max(20000).nullable(),
    rubric: questionInput.shape.rubric,
    explanation: z.string().trim().min(1).max(30000),
  })
  .strict();
export type Correction = {
  originalRevisionId: string;
  reason: string;
  evidence: z.infer<typeof evidence>[];
  originalAudit: SourceCheck;
  createdAt: string;
  verification?: CorrectionCheck & { passed: boolean; at: string };
  confirmedAt?: string;
};
const editable = new Set(["answer", "modelAnswer", "rubric", "explanation"]);
export function sameCorrectionQuestion(original: unknown, candidate: unknown) {
  const a = questionInput.strip().parse(original),
    b = questionInput.strip().parse(candidate);
  return Object.keys(a)
    .filter((k) => !editable.has(k))
    .every(
      (k) => JSON.stringify((a as any)[k]) === JSON.stringify((b as any)[k]),
    );
}
export const hasAnswerError = (q: any) =>
  q.sourceMatch &&
  q.review?.sourceCheck?.issues.some((i: any) => i.kind === "answer_error");
export const correctionToken = (q: any) =>
  hash(JSON.stringify([q.revisionId, q.review]));

export function saveCorrection(
  catalog: Catalog,
  questionId: string,
  input: unknown,
) {
  const data = correctionInput.parse(input);
  return catalog.store.tx(() => {
    const q = catalog.readQuestion(questionId);
    requireThat(
      q.revisionId === data.expectedRevisionId,
      "REVISION_CONFLICT",
      "문항 버전이 변경되었습니다. 정정 내용을 보존하고 최신 버전을 확인하세요.",
      409,
    );
    requireThat(
      !q.archived && q.sourceMatch,
      "CORRECTION_SOURCE",
      "원본 근거가 있는 활성 문항만 정정할 수 있습니다.",
    );
    const previous: Correction | undefined = q.review?.answerCorrection;
    const root = previous
      ? catalog.readQuestion(questionId, previous.originalRevisionId)
      : q;
    const originalAudit: SourceCheck | undefined =
      previous?.originalAudit ?? root.review.sourceCheck;
    requireThat(
      originalAudit &&
        originalAudit.issues.some((i) => i.kind === "answer_error"),
      "CORRECTION_ISSUE",
      "먼저 AI 검토에서 원본의 실제 정답 오류를 확인하세요.",
    );
    requireThat(
      originalAudit.questionUnambiguous &&
        !originalAudit.issues.some(
          (i) => i.kind === "ambiguous" || i.location === "question",
        ),
      "CORRECTION_AMBIGUOUS",
      "문제의 의미나 조건이 불명확하면 정답만 정정할 수 없습니다.",
    );
    for (const e of data.evidence) {
      const segment = catalog.store.get("segments", e.segmentId);
      requireThat(
        root.evidence.some((v: any) => v.segmentId === e.segmentId) &&
          segment.text.includes(e.quote),
        "CORRECTION_EVIDENCE",
        "정정 근거는 원본 문항이 인용한 구간의 정확한 인용이어야 합니다.",
      );
    }
    requireThat(
      originalAudit.issues
        .filter((i) => i.kind === "answer_error")
        .every((i) =>
          data.evidence.some(
            (e) =>
              e.segmentId === i.evidence.segmentId &&
              e.quote.includes(i.evidence.quote),
          ),
        ),
      "CORRECTION_COVERAGE",
      "확인된 원본 정답 오류의 근거를 모두 포함하세요.",
    );
    const candidate = {
      ...questionInput.strip().parse(q),
      answer: data.answer,
      modelAnswer: data.modelAnswer,
      rubric: data.rubric,
      explanation: data.explanation,
    };
    requireThat(
      [...editable].some(
        (k) =>
          JSON.stringify((q as any)[k]) !==
          JSON.stringify((candidate as any)[k]),
      ),
      "CORRECTION_UNCHANGED",
      "정답·채점 기준·해설 중 정정할 내용을 변경하세요.",
    );
    return catalog.createQuestion(candidate, {
      questionId,
      expectedRevisionId: q.revisionId,
      correction: {
        originalRevisionId: root.revisionId,
        originalAudit,
        reason: data.reason,
        evidence: data.evidence,
        createdAt: now(),
      },
    });
  });
}

export function confirmCorrection(
  catalog: Catalog,
  questionId: string,
  input: { revisionId: string; reviewToken: string; reason: string },
) {
  return catalog.store.tx(() => {
    const q = catalog.readQuestion(questionId);
    requireThat(
      !q.archived && q.status === "needs_review",
      "CORRECTION_STATE",
      "검토 대기 중인 활성 정정안만 확정할 수 있습니다.",
    );
    requireThat(
      q.revisionId === input.revisionId &&
        correctionToken(q) === input.reviewToken,
      "REVISION_CONFLICT",
      "문항 또는 검토 결과가 변경되었습니다. 다시 확인하세요.",
      409,
    );
    const correction: Correction | undefined = q.review.answerCorrection;
    requireThat(
      correction?.verification?.passed,
      "CORRECTION_NOT_VERIFIED",
      "정정안의 AI 검토를 통과한 뒤 확정하세요.",
    );
    requireThat(input.reason.trim(), "REASON", "확정 근거가 필요합니다.");
    catalog.validateQuestion(questionInput.strip().parse(q));
    catalog.store.run(
      "UPDATE question_status SET status=?,review=? WHERE revision_id=?",
      "usable",
      JSON.stringify({
        ...q.review,
        actor: "user",
        reason: input.reason.trim(),
        at: now(),
        answerCorrection: { ...correction, confirmedAt: now() },
      }),
      q.revisionId,
    );
    return catalog.readQuestion(questionId);
  });
}

export const correctionPolicy =
  "This is a USER-SAVED CORRECTION DRAFT, not an official corrected answer key. Keep the original PDF/text and original question immutable. " +
  "Independently solve the unchanged question. sourceCheck must STILL report original answer errors and finalAnswerMatches must describe agreement with the ORIGINAL key, not pretend the original was correct. " +
  "Return correctionCheck: correctedAnswerValid confirms the candidate answer/rubric/explanation are independently correct, allIssuesAddressed confirms EVERY original issue is explicitly explained and resolved by this draft with exact cited source evidence, and reason explains the decision. " +
  "Original answer_error issues may coexist with usable=true only in this correction mode, when they are fully covered by correction.evidence and the candidate resolves them. Do not relax question ambiguity, source identity, visual faithfulness, answer-leak or rubric requirements. " +
  "A user's correction reason is a proposal, never evidence that the correction is true. Incorrect, incomplete or unrelated corrections require usable=false. Do not approve a draft merely because it differs from the original. Final confirmation is a separate user action.";
