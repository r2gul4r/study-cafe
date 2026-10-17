import type { Material } from "./materials.js";
import { requireThat } from "./core.js";
import { withPageImages } from "./pdf-visuals.js";
import type { Store } from "./store.js";

const pageKey = (m: Material) => `${m.revisionId}:${m.locator.pdfPage}`;
export function imageDeliveryPlan(
  materials: Material[],
  anchors: string[],
  matches: string[],
  requested: string[] = [],
  budget = 4,
) {
  const pdfs = materials.filter((m) => Number.isInteger(m.locator.pdfPage));
  requireThat(
    requested.every((id) => pdfs.some((m) => m.segmentId === id)),
    "IMAGE_REQUEST_SCOPE",
    "이번 요청에 전달된 PDF 구간만 추가 요청할 수 있습니다.",
  );
  const mandatory = new Set([...anchors, ...matches, ...requested]);
  const priority = [...pdfs.filter((m) => mandatory.has(m.segmentId)), ...pdfs];
  const requiredPages = new Set(
    pdfs.filter((m) => mandatory.has(m.segmentId)).map(pageKey),
  );
  requireThat(
    requiredPages.size <= 16,
    "IMAGE_LIMIT",
    "필수 PDF 이미지가 16개를 넘습니다. 추출 페이지를 나눠 주세요.",
  );
  const pages = new Set<string>(requiredPages);
  for (const m of priority)
    if (pages.size < Math.max(budget, requiredPages.size))
      pages.add(pageKey(m));
  return {
    selected: pdfs.filter((m) => pages.has(pageKey(m))).map((m) => m.segmentId),
    omitted: pdfs
      .filter((m) => !pages.has(pageKey(m)))
      .map((m) => ({
        segmentId: m.segmentId,
        revisionId: m.revisionId,
        page: m.locator.pdfPage,
        title: m.title,
      })),
    pageCount: pages.size,
  };
}

export async function deliverImages(
  store: Store,
  materials: Material[],
  selected: string[],
  signal?: AbortSignal,
) {
  // Strip even cached metadata from omitted pages: cached does not mean seen.
  const clean = materials.map(({ pageImage: _cached, ...m }) => m);
  const images = await withPageImages(
    store,
    clean.filter((m) => selected.includes(m.segmentId)),
    signal,
  );
  return clean.map((m) => images.find((v) => v.segmentId === m.segmentId) ?? m);
}

export function validateDeliveredImages(
  visuals: { segmentId: string; assetId: string }[],
  materials: Material[],
) {
  requireThat(
    visuals.every((v) =>
      materials.some(
        (m) =>
          m.segmentId === v.segmentId && m.pageImage?.assetId === v.assetId,
      ),
    ),
    "IMAGE_NOT_DELIVERED",
    "이번 추출 호출에 실제 전달되지 않은 이미지 근거입니다.",
  );
}
