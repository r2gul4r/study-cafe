import { lookup } from "node:dns/promises";
import { Agent, request } from "undici";
import ipaddr from "ipaddr.js";
import { load } from "cheerio";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createRequire } from "node:module";
import { PdfOcr, type OcrLanguage } from "./ocr.js";
import { dirname, join } from "node:path";
import { Catalog } from "./catalog.js";
import { decode, requireThat, id, hash, now, Fault } from "./core.js";

export function publicAddress(address: string) {
  try {
    let ip = ipaddr.parse(address);
    if (ip.kind() === "ipv6" && (ip as ipaddr.IPv6).isIPv4MappedAddress())
      ip = (ip as ipaddr.IPv6).toIPv4Address();
    return ip.range() === "unicast";
  } catch {
    return false;
  }
}
export async function fetchPublic(
  urlString: string,
  signal?: AbortSignal,
  maxBytes = 20 * 1024 * 1024,
): Promise<{ bytes: Buffer; mime: string; url: string }> {
  let url = new URL(urlString);
  const combined = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(30_000),
  ]);
  for (let redirect = 0; redirect < 6; redirect++) {
    requireThat(
      ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        (!url.port || ["80", "443"].includes(url.port)),
      "URL",
      "허용하지 않는 URL입니다.",
    );
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await lookup(host, { all: true });
    requireThat(
      addresses.length && addresses.every((a) => publicAddress(a.address)),
      "PRIVATE_ADDRESS",
      "내부 주소 자료는 다운로드할 수 없습니다.",
    );
    const pinned = addresses[0]!;
    const dispatcher = new Agent({
      connect: {
        lookup: ((_h: any, options: any, cb: any) =>
          options?.all
            ? cb(null, [pinned])
            : cb(null, pinned.address, pinned.family)) as any,
      },
    });
    try {
      const response = await request(url, {
        dispatcher,
        signal: combined,
        headers: {
          "user-agent": "study-cafe/0.1 (personal study source importer)",
          accept: "application/pdf,text/html,text/plain",
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const next = response.headers.location;
        response.body.destroy();
        requireThat(
          typeof next === "string",
          "REDIRECT",
          "리다이렉트 대상이 없습니다.",
        );
        url = new URL(next, url);
        continue;
      }
      requireThat(
        response.statusCode >= 200 && response.statusCode < 300,
        "HTTP_STATUS",
        `자료 요청 실패 (${response.statusCode})`,
        422,
      );
      if (Number(response.headers["content-length"]) > maxBytes) {
        response.body.destroy();
        throw new Fault(413, "TOO_LARGE", "자료 용량 제한을 초과했습니다.");
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        const data = Buffer.from(chunk);
        bytes += data.length;
        if (bytes > maxBytes) {
          response.body.destroy();
          throw new Fault(413, "TOO_LARGE", "자료 용량 제한을 초과했습니다.");
        }
        chunks.push(data);
      }
      return {
        bytes: Buffer.concat(chunks),
        mime: String(
          response.headers["content-type"] ?? "application/octet-stream",
        ).split(";")[0]!,
        url: url.href,
      };
    } finally {
      await dispatcher.destroy();
    }
  }
  throw new Fault(422, "REDIRECT_LIMIT", "리다이렉트 횟수를 초과했습니다.");
}
export type Extraction = {
  pages: { text: string; locator: any }[];
  links: string[];
  title?: string;
};
export async function extract(
  bytes: Uint8Array,
  mime: string,
  baseUrl?: string,
  options: {
    ocr?: boolean;
    ocrLanguages?: OcrLanguage[];
    signal?: AbortSignal;
  } = {},
): Promise<Extraction> {
  requireThat(
    bytes.length <= 20 * 1024 * 1024,
    "TOO_LARGE",
    "최대 20MB입니다.",
    413,
  );
  if (mime === "application/pdf") {
    requireThat(
      Buffer.from(bytes).subarray(0, 5).toString() === "%PDF-",
      "PDF",
      "PDF 형식이 아닙니다.",
    );
    const pdfRoot = dirname(
      createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
    );
    const task = getDocument({
      data: Uint8Array.from(bytes),
      disableFontFace: true,
      useSystemFonts: false,
      standardFontDataUrl:
        join(pdfRoot, "standard_fonts").replaceAll("\\", "/") + "/",
      cMapUrl: join(pdfRoot, "cmaps").replaceAll("\\", "/") + "/",
      cMapPacked: true,
    });
    const ocr = new PdfOcr(options.ocrLanguages);
    let scannedPages = 0;
    try {
      const doc = await task.promise;
      requireThat(
        doc.numPages <= 300,
        "PAGE_LIMIT",
        "PDF는 최대 300페이지입니다.",
      );
      const pages = [];
      let total = 0;
      for (let i = 1; i <= doc.numPages; i++) {
        options.signal?.throwIfAborted();
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const parts = content.items.filter(
          (x: any) => typeof x.str === "string",
        ) as any[];
        let text = parts
          .map((x) => x.str + (x.hasEOL ? "\n" : " "))
          .join("")
          .trim();
        let ocrResult;
        if (!text && options.ocr) {
          requireThat(
            ++scannedPages <= 20,
            "OCR_PAGE_LIMIT",
            "스캔 페이지는 한 번에 최대 20쪽입니다. PDF를 나눠 가져오세요.",
            422,
          );
          ocrResult = await ocr.recognize(doc, page, options.signal);
          text = ocrResult.text;
        }
        total += text.length;
        requireThat(
          total <= 2_000_000,
          "TEXT_LIMIT",
          "추출 텍스트가 너무 큽니다.",
        );
        if (text)
          pages.push({
            text,
            locator: {
              pdfPage: i,
              ...(ocrResult
                ? {
                    ocr: {
                      confidence: ocrResult.confidence,
                      engine: ocrResult.engine,
                      languages: ocrResult.languages,
                      requiresVisualReview: true,
                    },
                  }
                : {}),
              boxes: parts.map((x) => ({
                text: x.str,
                transform: x.transform,
                width: x.width,
                height: x.height,
              })),
            },
          });
      }
      requireThat(
        pages.length,
        "OCR_REQUIRED",
        "추출 가능한 텍스트가 없습니다. 스캔 PDF OCR을 선택하고 언어를 확인해 다시 가져오세요.",
        422,
      );
      return { pages, links: [] };
    } finally {
      await ocr.close();
      await task.destroy();
    }
  }
  requireThat(
    ["text/html", "text/plain", "text/markdown"].includes(mime),
    "UNSUPPORTED_MEDIA",
    "웹 본문·텍스트·텍스트 PDF만 지원합니다.",
    415,
  );
  const raw = Buffer.from(bytes).toString("utf8");
  if (mime !== "text/html")
    return { pages: [{ text: raw, locator: { kind: "text" } }], links: [] };
  const $ = load(raw);
  const title = $("title").text().trim();
  const links = new Set<string>();
  $("a[href]").each((_i, e) => {
    try {
      const u = new URL($(e).attr("href")!, baseUrl);
      if (["http:", "https:"].includes(u.protocol)) links.add(u.href);
    } catch {}
  });
  $("script,style,nav,header,footer,form,noscript,iframe").remove();
  const root = $("main,article").first();
  const target = root.length ? root : $("body");
  target.find("p,div,li,h1,h2,h3,br,tr").prepend("\n");
  const text = target
    .text()
    .replace(/[\t ]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
  requireThat(text, "EMPTY_SOURCE", "본문을 추출하지 못했습니다.", 422);
  return {
    pages: [{ text, locator: { kind: "html" } }],
    links: [...links].slice(0, 300),
    title,
  };
}
export class Sources {
  constructor(
    public catalog: Catalog,
    public fetcher = fetchPublic,
  ) {}
  async prepare(
    sourceId: string,
    input: {
      text?: string;
      base64?: string;
      mime?: string;
      ocr?: boolean;
      ocrLanguages?: OcrLanguage[];
    },
    signal?: AbortSignal,
  ) {
    const source = this.catalog.readSource(sourceId);
    requireThat(
      source.rights !== "link_only",
      "LINK_ONLY",
      "원문 수집 이용 근거를 먼저 등록하세요.",
      409,
    );
    let file: { bytes: Buffer; mime: string; url?: string };
    if (input.text !== undefined)
      file = { bytes: Buffer.from(input.text), mime: "text/plain" };
    else if (input.base64)
      file = {
        bytes: Buffer.from(input.base64, "base64"),
        mime: input.mime ?? "application/pdf",
      };
    else {
      requireThat(source.url, "SOURCE_URL", "다운로드 URL이 없습니다.");
      file = await this.fetcher(source.url, signal);
    }
    const extracted = await extract(file.bytes, file.mime, file.url, {
      ...input,
      signal,
    });
    signal?.throwIfAborted();
    return {
      file: {
        base64: file.bytes.toString("base64"),
        mime: file.mime,
        url: file.url ?? source.url,
      },
      extracted,
    };
  }
  commit(sourceId: string, prepared: Awaited<ReturnType<Sources["prepare"]>>) {
    const s = this.catalog.store;
    return s.tx(() => {
      const bytes = Buffer.from(prepared.file.base64, "base64");
      const fingerprint = hash(bytes);
      const old = s.one(
        "SELECT id FROM source_revisions WHERE source_id=? AND hash=?",
        sourceId,
        fingerprint,
      );
      if (old) return { revisionId: old.id, duplicate: true };
      const a = s.asset(bytes, prepared.file.mime),
        revisionId = id();
      s.run(
        "INSERT INTO source_revisions VALUES(?,?,?,?,?)",
        revisionId,
        sourceId,
        fingerprint,
        JSON.stringify({
          assetId: a.id,
          url: prepared.file.url,
          links: prepared.extracted.links,
          title: prepared.extracted.title,
        }),
        now(),
      );
      let ordinal = 0;
      for (const page of prepared.extracted.pages) {
        for (let offset = 0; offset < page.text.length; offset += 8000) {
          s.run(
            "INSERT INTO segments VALUES(?,?,?,?,?)",
            id(),
            revisionId,
            ordinal++,
            page.text.slice(offset, offset + 8000),
            JSON.stringify({
              ...page.locator,
              charStart: offset,
              charEnd: Math.min(offset + 8000, page.text.length),
            }),
          );
        }
      }
      s.run("UPDATE sources SET status=? WHERE id=?", "extracted", sourceId);
      return { revisionId, segments: ordinal, assetId: a.id };
    });
  }
}
