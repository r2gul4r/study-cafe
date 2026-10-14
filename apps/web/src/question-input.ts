import type { Question } from "./types.js";

// Explicitly keep provenance and grouping, excluding read-only response fields.
export function revisionInput(q: Question) {
  return {
    expectedRevisionId: q.revisionId,
    goalId: q.goalId,
    scopeId: q.scopeId,
    familyId: q.familyId,
    parentId: q.parentId ?? null,
    groupId: q.groupId ?? null,
    pastExamEvidence: q.pastExamEvidence ?? null,
    type: q.type,
    stem: q.stem,
    passage: q.passage,
    choices: q.choices,
    answer: q.answer ?? [],
    modelAnswer: q.modelAnswer ?? null,
    rubric: q.rubric ?? [],
    explanation: q.explanation ?? "",
    origin: q.origin,
    conceptIds: q.conceptIds,
    difficulty: q.difficulty,
    evidence: q.evidence ?? [],
    sourceMatch: q.sourceMatch ?? null,
    requiredAssetIds: q.requiredAssetIds,
    points: q.points,
  };
}
