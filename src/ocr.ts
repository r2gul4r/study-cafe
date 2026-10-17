import { createWorker, type Worker } from "tesseract.js";
import { createRequire } from "node:module";
import type {
  PDFDocumentProxy,
  PDFPageProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import { Fault } from "./core.js";
import type { Canvas } from "@napi-rs/canvas";

export type OcrLanguage = "eng" | "jpn" | "kor";
const req = createRequire(import.meta.url);
export class PdfOcr {
  private worker?: Worker;
  constructor(private languages: OcrLanguage[] = ["eng"]) {}
  async recognize(
    doc: PDFDocumentProxy,
    page: PDFPageProxy,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (!this.worker) {
      const code = this.languages[0] ?? "eng";
      const entry: { langPath: string } = req(`@tesseract.js-data/${code}`);
      this.worker = await createWorker(code, 1, {
        langPath: entry.langPath,
        gzip: true,
        cacheMethod: "none",
      });
    }
    const worker = this.worker;
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({
      scale: Math.min(3, 2400 / Math.max(base.width, base.height)),
    });
    // PDF.js' own Node factory supplies the canvas rendering surface; its
    // declaration currently erases the factory methods to Object.
    type Target = {
      canvas: HTMLCanvasElement & Pick<Canvas, "toBuffer">;
      context: CanvasRenderingContext2D;
    };
    const factory = doc.canvasFactory as {
      create(width: number, height: number): Target;
      destroy(target: Target): void;
    };
    const target = factory.create(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    try {
      await page.render({
        canvas: target.canvas,
        canvasContext: target.context,
        viewport,
      }).promise;
      const recognition = worker.recognize(target.canvas.toBuffer("image/png"));
      const result = await Promise.race([
        recognition,
        new Promise<never>((_resolve, reject) => {
          const stop = (reason: unknown) => {
            void worker.terminate();
            this.worker = undefined;
            reject(reason);
          };
          timer = setTimeout(
            () =>
              stop(
                new Fault(
                  422,
                  "OCR_TIMEOUT",
                  "OCR 페이지 처리 시간이 초과됐습니다. 페이지를 나눠 다시 가져오세요.",
                ),
              ),
            45000,
          );
          abort = () => stop(signal?.reason);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        }),
      ]);
      return {
        text: result.data.text.trim(),
        confidence: result.data.confidence,
        engine: "tesseract.js@7.0.0",
        languages: this.languages,
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
      factory.destroy(target);
    }
  }
  async close() {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = undefined;
    }
  }
}
