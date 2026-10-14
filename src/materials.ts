import { decode, requireThat, type Question } from "./core.js";
import { containsVerbatimQuote } from "./evidence.js";
import type { Catalog } from "./catalog.js";

export type Material = {
  segmentId: string;
  sourceId: string;
  revisionId: string;
  title: string;
  kind: string;
  url: string | null;
  text: string;
  locator: any;
};

const words = (value: string) => [
  ...new Set(
    value
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]{2,}/gu) ?? [],
  ),
];

// Local lexical retrieval: no embedding provider, subject dictionary or AI call.
// Return whole stored segments so that quoted evidence stays verifiable.
export function selectMaterials(
  pool: Material[],
  query: string,
  { maxSegments = 8, maxChars = 48_000, allowFallback = false } = {},
) {
  const terms = words(query);
  const ranked = pool
    .map((material, index) => {
      const body = material.text.normalize("NFKC").toLowerCase();
      const title = material.title.normalize("NFKC").toLowerCase();
      // Title alone is not evidence that the segment contains relevant content.
      const hits = terms.filter((term) => body.includes(term));
      const score = hits.reduce(
        (sum, term) => sum + 1 + (title.includes(term) ? 0.25 : 0),
        0,
      );
      return { material, index, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  // No lexical hit does not mean no evidence (synonyms and other languages).
  // Use a bounded, source-diverse fallback; the independent verifier still
  // has to establish answer support. Never label this as semantic retrieval.
  if (!ranked.length && allowFallback) {
    const groups = new Map<string, Material[]>();
    for (const material of pool) {
      if (!groups.has(material.sourceId)) groups.set(material.sourceId, []);
      groups.get(material.sourceId)!.push(material);
    }
    for (let depth = 0; ranked.length < pool.length; depth++) {
      for (const group of groups.values())
        if (group[depth])
          ranked.push({
            material: group[depth]!,
            score: 0,
            index: ranked.length,
          });
    }
  }
  const selected: Material[] = [];
  let chars = 0;
  for (const { material } of ranked) {
    if (selected.length >= maxSegments) break;
    if (chars + material.text.length > maxChars) continue;
    selected.push(material);
    chars += material.text.length;
  }
  return selected;
}

export function latestMaterials(catalog: Catalog, goalId: string): Material[] {
  return catalog.store
    .all(
      "SELECT seg.*,src.id source_id,src.data source_data,r.data revision_data FROM segments seg JOIN source_revisions r ON r.id=seg.revision_id JOIN sources src ON src.id=r.source_id WHERE src.goal_id=? AND src.status='extracted' AND json_extract(src.data,'$.rights')!='link_only' AND r.rowid=(SELECT MAX(latest.rowid) FROM source_revisions latest WHERE latest.source_id=src.id) ORDER BY src.rowid,seg.ordinal",
      goalId,
    )
    .map((row) => {
      const source = decode(row.source_data),
        revision = decode(row.revision_data);
      return {
        segmentId: row.id,
        sourceId: row.source_id,
        revisionId: row.revision_id,
        title: source.title,
        kind: source.kind,
        url: revision.url ?? source.url ?? null,
        text: row.text,
        locator: decode(row.locator),
      };
    });
}

export function validateSuppliedEvidence(
  q: Question,
  materials: Pick<Material, "segmentId" | "text">[],
) {
  requireThat(
    q.evidence.length,
    "EVIDENCE_REQUIRED",
    "제공된 자료의 근거가 필요합니다.",
  );
  for (const evidence of q.evidence) {
    const material = materials.find((m) => m.segmentId === evidence.segmentId);
    requireThat(
      material && material.text.includes(evidence.quote),
      "SUPPLIED_EVIDENCE",
      "이번 요청에 제공하지 않은 구간이거나 원문과 다른 인용입니다.",
    );
  }
}

export function validateExtraction(
  q: Question,
  source: any,
  body: Material[],
  answers: Material[],
) {
  validateSuppliedEvidence(q, [...body, ...answers]);
  const expectedOrigin = [
    "past_exam",
    "official_practice",
    "external_practice",
  ].includes(source.kind)
    ? source.kind
    : "external_practice";
  requireThat(
    q.origin === expectedOrigin,
    "SOURCE_ORIGIN",
    "문항 분류가 실제 원문 출처와 다릅니다.",
  );
  const match = q.sourceMatch;
  requireThat(
    match,
    "SOURCE_MATCH_REQUIRED",
    "원문 문항과 정답의 연결 근거가 없습니다.",
  );
  requireThat(
    match.questionReference === match.answerReference,
    "ANSWER_REFERENCE",
    "문항 번호와 정답 번호가 다릅니다.",
  );
  const questionMaterial = body.find(
    (m) => m.segmentId === match.questionEvidence.segmentId,
  );
  const answerMaterial = [...body, ...answers].find(
    (m) => m.segmentId === match.answerEvidence.segmentId,
  );
  requireThat(
    questionMaterial && answerMaterial,
    "SOURCE_MATCH",
    "문제 본문 또는 연결된 정답 자료가 아닙니다.",
  );
  const citations = [
    match.questionEvidence,
    match.answerEvidence,
    ...match.editionEvidence,
  ];
  requireThat(
    citations.every((e) =>
      q.evidence.some(
        (v) => v.segmentId === e.segmentId && v.quote === e.quote,
      ),
    ),
    "SOURCE_MATCH_EVIDENCE",
    "문항·정답·판본 연결의 인용을 근거 목록에도 포함해야 합니다.",
  );
  requireThat(
    containsVerbatimQuote(
      match.questionEvidence.quote,
      match.questionReference,
    ) &&
      containsVerbatimQuote(match.answerEvidence.quote, match.answerReference),
    "ANSWER_REFERENCE",
    "문항/정답 번호가 연결 인용에 없습니다.",
  );
  // Keep wording; only whitespace normalization is allowed for PDF/HTML layout.
  const original = body
    .map((m, index) => {
      const previous = body[index - 1];
      const contiguous =
        previous &&
        previous.revisionId === m.revisionId &&
        previous.locator.pdfPage === m.locator.pdfPage &&
        typeof previous.locator.charEnd === "number" &&
        previous.locator.charEnd === m.locator.charStart;
      return (index && !contiguous ? "\n" : "") + m.text;
    })
    .join("");
  requireThat(
    [
      q.stem,
      ...q.choices.map((c) => c.text),
      ...(q.passage ? [q.passage] : []),
    ].every((text) => containsVerbatimQuote(original, text)),
    "EXTRACTION_WORDING",
    "문제·보기·지문이 원문과 다릅니다.",
  );
  if (questionMaterial.revisionId !== answerMaterial.revisionId) {
    requireThat(
      match.edition &&
        [questionMaterial, answerMaterial].every((m) =>
          match.editionEvidence.some((e) => {
            const cited = [...body, ...answers].find(
              (v) => v.segmentId === e.segmentId,
            );
            return (
              cited?.revisionId === m.revisionId &&
              containsVerbatimQuote(e.quote, match.edition!)
            );
          }),
        ),
      "ANSWER_EDITION",
      "별도 정답표와 문제의 같은 판본·회차를 확인할 원문 근거가 부족합니다.",
    );
  }
}
