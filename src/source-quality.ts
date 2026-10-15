import { z } from "zod";
import { evidence, type Question } from "./core.js";
import { containsVerbatimQuote } from "./evidence.js";
import type { Material } from "./materials.js";

export const sourceCheckOutput = z
  .object({
    questionUnambiguous: z.boolean(),
    finalAnswerMatches: z.boolean(),
    independentAnswer: z.string().min(1).max(20000),
    issues: z
      .array(
        z
          .object({
            kind: z.enum(["notation_only", "answer_error", "ambiguous"]),
            location: z.enum(["question", "worked_solution", "final_answer"]),
            evidence,
            description: z.string().min(1).max(4000),
            contextResolves: z.boolean(),
            affectsAnswer: z.boolean(),
            affectsGrading: z.boolean(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
export type SourceCheck = z.infer<typeof sourceCheckOutput>;

// This policy applies to any subject/source, not a specific exam or formula.
export const sourceQualityPolicy =
  "Distinguish harmless notation omissions from substantive source errors. " +
  "Independently solve the unchanged question and compare every requested final answer and scoring requirement with the original key. " +
  "A missing differential, repeated variable label, punctuation or formatting in an INTERMEDIATE worked-solution line is notation_only ONLY if surrounding original lines uniquely establish its meaning, the printed final answer is correct, and neither the answer nor grading changes. " +
  "Such an omission alone must NOT make a complete question unresolved/unusable: retain original citations/images, use a clear independently justified explanation, and record the omission instead of silently editing the source. " +
  "An incorrect numeric equality, sign, unit, domain, assumption, choice mapping or final answer is answer_error even when a later line is correct. A missing symbol that admits different answers is ambiguous, never notation_only. " +
  "Do not repair or guess the question, alter the official final answer, or grade a learner on an omitted intermediate step that the question did not request. " +
  "During independent verify_question review of extracted questions, return sourceCheck with questionUnambiguous, finalAnswerMatches (ALL requested original final answers AND the stored answer agree with your independent solution), independentAnswer, and issues. Do not add this review object to extraction question fields. " +
  "Each issue needs an exact text-layer evidence quote locating it in the supplied source, its kind/location, and explicit contextResolves/affectsAnswer/affectsGrading flags. Missing glyphs should be located by surrounding verbatim text, never by an invented quote. " +
  "Record notation issues even when usable=true. Actual errors, uncertainty, unsupported repairs or changed grading require usable=false. For generated questions sourceCheck=null.";

// A permissive overall model verdict cannot bypass the structured audit.
// Semantic correctness still requires the independent model, not string matching.
export function sourceCheckFailure(
  q: Question,
  audit: SourceCheck | null | undefined,
  materials: Material[],
): string | null {
  if (!q.sourceMatch) return null;
  if (!audit) return "원본 표기·정답 구분 검토 결과가 없습니다.";
  if (!audit.questionUnambiguous || !audit.finalAnswerMatches)
    return "원본 문제의 의미 또는 정답이 독립 풀이와 일치하지 않습니다.";
  for (const issue of audit.issues) {
    const material = materials.find(
      (m) => m.segmentId === issue.evidence.segmentId,
    );
    const anchor =
      issue.location === "question"
        ? q.sourceMatch.questionEvidence
        : q.sourceMatch.answerEvidence;
    const anchorMaterial = materials.find(
      (m) => m.segmentId === anchor.segmentId,
    );
    if (
      !material ||
      material.revisionId !== anchorMaterial?.revisionId ||
      !containsVerbatimQuote(material.text, issue.evidence.quote)
    )
      return "원본 오류의 위치·인용 근거를 확인할 수 없습니다.";
    if (
      issue.kind !== "notation_only" ||
      issue.location !== "worked_solution" ||
      !issue.contextResolves ||
      issue.affectsAnswer ||
      issue.affectsGrading
    )
      return `원본 정답 오류 또는 의미 불확실: ${issue.description}`;
  }
  return null;
}

export function sourceNotationNotice(audit: SourceCheck | null | undefined) {
  return audit?.issues.length
    ? "원본 중간 풀이의 표기 누락(정답·채점 영향 없음): " +
        audit.issues.map((issue) => issue.description).join(" ")
    : "";
}
