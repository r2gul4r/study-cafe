import type { Material } from "./materials.js";

// One full copy per immutable segment. Roles are explicit references into these
// arrays, not clipped quotations; validators still receive all original material.
export function extractionPayload(
  batch: Material[],
  adjacent: Material[],
  context: Material[],
  answers: Material[],
  header: Material,
) {
  const seen = new Set<string>();
  const unique = (items: Material[]) =>
    items.filter((m) => {
      if (seen.has(m.segmentId)) return false;
      seen.add(m.segmentId);
      return true;
    });
  const segments = unique(batch),
    adjacentSegments = unique(adjacent);
  const sourceContext = unique([...context, header]);
  const answerSegments = unique(answers);
  const before = [...batch, ...adjacent, header, ...context, ...answers];
  const after = [
    ...segments,
    ...adjacentSegments,
    ...sourceContext,
    ...answerSegments,
  ];
  return {
    segments,
    adjacentSegments,
    sourceContext,
    answerSegments,
    sourceHeaderId: header.segmentId,
    sourceContextIds: [
      ...new Set([...context, header].map((m) => m.segmentId)),
    ],
    answerSegmentIds: [...new Set(answers.map((m) => m.segmentId))],
    materialDelivery: {
      version: 1,
      fullSegments: after.length,
      uniqueTextChars: after.reduce((n, m) => n + m.text.length, 0),
      duplicateTextCharsRemoved:
        before.reduce((n, m) => n + m.text.length, 0) -
        after.reduce((n, m) => n + m.text.length, 0),
    },
  };
}
