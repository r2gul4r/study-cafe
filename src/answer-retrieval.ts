import type { Material } from "./materials.js";

const normalize = (s: string) => s.normalize("NFKC").toLowerCase();
const terms = (s: string) =>
  new Set(normalize(s).match(/[\p{L}\p{N}]{2,}/gu) ?? []);

// Printed identifiers, not every number in a calculation. These are retrieval
// hints only: number equality never establishes an answer or edition match.
export function printedReferences(text: string): string[] {
  const normalized = normalize(text);
  const found = new Set<string>();
  for (const pattern of [
    /(?:\b(?:question|problem|exercise|item|q)\s*[.:#]?\s*|第\s*)(\d{1,5})(?!\d)/gu,
    /(?:^|[\s|;])(?:제\s*)?(\d{1,5})\s*(?:[.)、:：](?!\d)|번|番|問|题|題)/gu,
    /(?:^|[\s|;])(\d{1,5})\s*[|\t]\s*/gu,
    /(?:^|\s)(\d{1,5})\s+[a-e1-5①②③④⑤](?=\s|$)/gu,
  ]) {
    for (const match of normalized.matchAll(pattern))
      found.add(String(Number(match[1])));
  }
  return [...found];
}

type Hit = {
  material: Material;
  score: number;
  references: string[];
  index: number;
};

// Built once per extraction job from eligible, linked source revisions only.
// Exact stored segments remain the evidence unit; previews are navigation only.
export class AnswerIndex {
  private entries;
  private frequency = new Map<string, number>();
  private groups = new Map<string, Material[]>();
  constructor(readonly pool: Material[]) {
    this.entries = pool.map((material, index) => {
      const tokens = terms(material.text);
      for (const token of tokens)
        this.frequency.set(token, (this.frequency.get(token) ?? 0) + 1);
      const group = this.groups.get(material.revisionId) ?? [];
      group.push(material);
      this.groups.set(material.revisionId, group);
      return {
        material,
        tokens,
        references: printedReferences(material.text),
        index,
      };
    });
    for (const group of this.groups.values())
      group.sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  }

  private rank(query: string, context: string): Hit[] {
    const queryTerms = terms(query),
      contextTerms = terms(context);
    const refs = new Set(printedReferences(query));
    const overlap = (tokens: Set<string>, query: Set<string>) => {
      let sum = 0;
      for (const token of query)
        if (tokens.has(token)) {
          // Rare terms distinguish repeated subpart numbers and section headings.
          sum += Math.log(
            1 + this.pool.length / (this.frequency.get(token) ?? 1),
          );
        }
      return sum / Math.sqrt(Math.max(1, query.size));
    };
    return this.entries
      .map(({ material, tokens, references, index }) => {
        const matches = references.filter((r) => refs.has(r));
        return {
          material,
          index,
          references: matches,
          score:
            matches.length * 8 +
            overlap(tokens, queryTerms) +
            overlap(tokens, contextTerms) * 0.3,
        };
      })
      .sort((a, b) => b.score - a.score || a.index - b.index);
  }

  search(
    query: string,
    options: {
      context?: string;
      segmentIds?: string[];
      maxSegments?: number;
      maxChars?: number;
    } = {},
  ) {
    const {
      context = "",
      segmentIds = [],
      maxSegments = 10,
      maxChars = 56_000,
    } = options;
    const ranked = this.rank(query, context);
    const invalidIds = segmentIds.filter(
      (id) => !this.pool.some((m) => m.segmentId === id),
    );
    const anchors: Material[] = [];
    const anchor = (m?: Material) => {
      if (m && !anchors.includes(m)) anchors.push(m);
    };
    for (const id of segmentIds)
      anchor(this.pool.find((m) => m.segmentId === id));
    // Cover different numbered questions before spending the budget on neighbours.
    for (const ref of printedReferences(query))
      anchor(ranked.find((h) => h.references.includes(ref))?.material);
    if (!anchors.length || anchors.length < 3) {
      for (const hit of ranked.filter(
        (h) => h.score > 0 && h.score >= (ranked[0]?.score ?? 0) * 0.65,
      )) {
        if (anchors.length >= 3) break;
        anchor(hit.material);
      }
    }
    // Unknown layouts still expose candidates across the full document, not only
    // the first pages. The model can query again or explicitly open an index ID.
    if (!anchors.length)
      for (const group of this.groups.values()) {
        for (const position of [
          0,
          Math.floor(group.length / 2),
          group.length - 1,
        ])
          anchor(group[position]);
      }
    const selected: Material[] = [],
      reasons: Record<string, string> = {};
    let chars = 0;
    const add = (m: Material | undefined, reason: string) => {
      if (
        !m ||
        selected.includes(m) ||
        selected.length >= maxSegments ||
        chars + m.text.length > maxChars
      )
        return;
      selected.push(m);
      chars += m.text.length;
      reasons[m.segmentId] = reason;
    };
    // One content anchor always precedes document identity; unrelated source
    // covers can no longer consume every slot. Include front/back only for hits.
    for (const m of anchors.slice(0, 3)) add(m, "match");
    const active = [...new Set(selected.map((m) => m.revisionId))];
    for (const revision of active) {
      const group = this.groups.get(revision)!;
      add(group[0], "document_context");
      add(group.at(-1), "document_context");
    }
    for (const delta of [1, 2, -1])
      for (const m of anchors.slice(0, 3)) {
        const group = this.groups.get(m.revisionId)!;
        const neighbour = group[group.indexOf(m) + delta];
        // Never skip a missing/over-budget intervening continuation segment.
        if (delta === 2 && !selected.includes(group[group.indexOf(m) + 1]!))
          continue;
        add(neighbour, delta < 0 ? "preceding_context" : "continuation");
      }
    for (const m of anchors.slice(3)) add(m, "match");
    // Only navigation snippets are clipped. Every cited segment is whole.
    const candidates = [
      ...new Map(
        [
          ...ranked.slice(0, 32).map((h) => h.material),
          ...[...this.groups.values()].flatMap((g) => [
            g[0]!,
            g[Math.floor(g.length / 2)]!,
            g.at(-1)!,
          ]),
        ].map((m) => [m.segmentId, m]),
      ).values(),
    ]
      .slice(0, 48)
      .map((m) => ({
        segmentId: m.segmentId,
        sourceId: m.sourceId,
        revisionId: m.revisionId,
        ordinal: m.ordinal,
        pdfPage: m.locator.pdfPage,
        references: printedReferences(m.text).slice(0, 30),
        preview: m.text.slice(0, 200),
      }));
    return {
      materials: selected,
      candidates,
      invalidIds,
      diagnostics: {
        version: 1,
        totalSegments: this.pool.length,
        selectedSegments: selected.length,
        selectedChars: chars,
        maxSegments,
        maxChars,
        queryReferences: printedReferences(query),
        reasons,
        indexTruncated: candidates.length < this.pool.length,
      },
    };
  }
}
