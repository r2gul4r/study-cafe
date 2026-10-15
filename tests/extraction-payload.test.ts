import test from "node:test";
import assert from "node:assert/strict";
import { extractionPayload } from "../src/extraction-payload.js";
import type { Material } from "../src/materials.js";

const m = (id: string, text = id): Material => ({
  segmentId: id,
  sourceId: "source",
  revisionId: "revision",
  title: id,
  kind: "reference",
  url: null,
  text,
  locator: { pdfPage: 1 },
  pageImage: { assetId: `image-${id}`, width: 100, height: 100 },
});
test("deduplicated extraction transmits exact segments once and preserves every role and image anchor", () => {
  const a = m("a", "Exact original header\n".repeat(100)),
    b = m("b"),
    c = m("c"),
    answer = m("answer");
  const p = extractionPayload([a], [b], [a, b, c], [b, answer], a);
  const all = [
    ...p.segments,
    ...p.adjacentSegments,
    ...p.sourceContext,
    ...p.answerSegments,
  ];
  assert.deepEqual(all, [a, b, c, answer]);
  assert.equal(p.sourceHeaderId, a.segmentId);
  assert.deepEqual(p.sourceContextIds, [a.segmentId, b.segmentId, c.segmentId]);
  assert.deepEqual(p.answerSegmentIds, [b.segmentId, answer.segmentId]);
  assert.equal(
    p.materialDelivery.duplicateTextCharsRemoved,
    a.text.length * 2 + b.text.length * 2,
  );
  for (const id of [...p.sourceContextIds, ...p.answerSegmentIds])
    assert.ok(all.some((m) => m.segmentId === id));
});
test("equal wording from different immutable source segments is never collapsed", () => {
  const a = m("a", "1. Answer: B"),
    b = { ...m("b", a.text), revisionId: "other" };
  const p = extractionPayload([a], [], [], [b], a);
  assert.deepEqual(p.segments, [a]);
  assert.deepEqual(p.answerSegments, [b]);
  assert.equal(p.materialDelivery.fullSegments, 2);
});
