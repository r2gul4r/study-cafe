import { z } from "zod";
import {
  decode,
  key,
  questionInput,
  requireThat,
  type Question,
} from "./core.js";
import type { Catalog } from "./catalog.js";
import { hasAnswerError } from "./corrections.js";
import { pdfRegionImage, regionBounds } from "./pdf-visuals.js";

export const questionRegionsInput = z
  .object({
    expectedRevisionId: key,
    regions: z
      .array(z.object({ segmentId: key, bounds: regionBounds }).strict())
      .max(8),
  })
  .strict();

// A crop is a new question revision. Original evidence and existing exam snapshots
// stay immutable; usability must be reviewed again against both original and crop.
export async function saveQuestionRegions(
  catalog: Catalog,
  id: string,
  input: unknown,
) {
  const request = questionRegionsInput.parse(input);
  const current = catalog.readQuestion(id);
  requireThat(
    current.revisionId === request.expectedRevisionId,
    "REVISION_CONFLICT",
    "문항 버전이 변경되었습니다. 최신 버전을 확인하세요.",
    409,
  );
  requireThat(
    !current.archived,
    "QUESTION_ARCHIVED",
    "보관한 문항의 표시 영역은 변경할 수 없습니다.",
  );
  requireThat(
    !hasAnswerError(current) && !current.review?.answerCorrection,
    "CORRECTION_QUESTION_CHANGED",
    "정답 오류 정정 중인 문항은 원본 문제 표시를 유지합니다.",
  );
  const q = questionInput.strip().parse(current);
  const originals = q.visualEvidence.filter((v) => v.role === "question");
  requireThat(
    originals.length > 0,
    "PDF_REGION_SOURCE",
    "PDF 문제 원본이 있는 문항만 영역을 지정할 수 있습니다.",
  );
  const regions: Question["learnerRegions"] = [];
  const seen = new Set<string>();
  for (const region of request.regions) {
    const source = originals.find((v) => v.segmentId === region.segmentId);
    requireThat(
      source && !seen.has(source.assetId),
      "PDF_REGION_SOURCE",
      "이 문항의 문제 원본을 중복 없이 선택하세요.",
    );
    seen.add(source.assetId);
    if (
      region.bounds.x === 0 &&
      region.bounds.y === 0 &&
      region.bounds.width === 1 &&
      region.bounds.height === 1
    )
      continue;
    const segment = catalog.store.get("segments", region.segmentId);
    const page = decode<any>(segment.locator).pdfPage;
    const image = await pdfRegionImage(
      catalog.store,
      segment.revision_id,
      page,
      region.bounds,
    );
    regions.push({
      ...region,
      sourceAssetId: source.assetId,
      assetId: image.assetId,
    });
  }
  const replaced = new Set([
    ...originals.map((v) => v.assetId),
    ...q.learnerRegions.map((r) => r.assetId),
  ]);
  const requiredAssetIds = [
    ...new Set([
      ...q.requiredAssetIds.filter((id) => !replaced.has(id)),
      ...originals.map(
        (v) =>
          regions.find((r) => r.sourceAssetId === v.assetId)?.assetId ??
          v.assetId,
      ),
    ]),
  ];
  // createQuestion checks the expected revision inside its transaction, after rendering.
  requireThat(
    !catalog.readQuestion(id).archived,
    "QUESTION_ARCHIVED",
    "보관한 문항의 표시 영역은 변경할 수 없습니다.",
  );
  return catalog.createQuestion(
    { ...q, learnerRegions: regions, requiredAssetIds },
    {
      questionId: id,
      expectedRevisionId: request.expectedRevisionId,
    },
  );
}
