import path from "node:path";
import { pathToFileURL } from "node:url";
import { AppError } from "./errors";
import type { PageLayout } from "./layout";
import { Mutex } from "./mutex";

export interface PdfHandle {
  numPages: number;
  getPageText(page: number): Promise<string>;
  renderPagePng(page: number, scale?: number): Promise<Buffer>;
  /** Positioned text items + counts of image/vector-path operations (used for local layout analysis). */
  getLayout(page: number): Promise<PageLayout>;
  destroy(): Promise<void>;
}

export interface PdfTools {
  load(data: Buffer): Promise<PdfHandle>;
}

function assertNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 3))
    throw new AppError(
      "INTERNAL",
      `Node ${process.versions.node} is too old for PDF processing (pdf.js needs Node 22.3 or newer). Run "nvm use 22" (or install Node 22), then restart the server.`,
      500,
    );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PdfJs = any;
let pdfjsPromise: Promise<PdfJs> | null = null;
function pdfjs(): Promise<PdfJs> {
  assertNodeVersion();
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

export const pdfTools: PdfTools = {
  async load(data) {
    const lib = await pdfjs();
    const fontDir = path.join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts") + path.sep;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let doc: any;
    let task;
    try {
      task = lib.getDocument({
        data: new Uint8Array(data), // pdfjs takes ownership of the buffer, so always pass a copy
        useSystemFonts: true,
        isEvalSupported: false,
        standardFontDataUrl: pathToFileURL(fontDir).href,
        verbosity: 0,
      });
      doc = await task.promise;
    } catch (e) {
      const name = (e as Error).name;
      if (name === "PasswordException")
        throw new AppError("INVALID_PDF", "This PDF is password-protected and cannot be processed.", 422, e);
      throw new AppError("PDF_PARSE_FAILED", `The PDF could not be parsed: ${(e as Error).message}`, 422, e);
    }

    // pdf.js page operations are serialised per document (concurrent render/getTextContent can stall on Node 20).
    const lock = new Mutex();

    return {
      numPages: doc.numPages as number,

      getPageText: (n) => lock.runExclusive(() => pageText(n)),
      renderPagePng: (n, scale = 2) => lock.runExclusive(() => pagePng(n, scale)),

      getLayout: (n) => lock.runExclusive(() => pageLayout(n)),

      async destroy() {
        await task.destroy();
      },
    };

    async function pageText(n: number) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let out = "";
      for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
        if (item.str === undefined) continue;
        out += item.str + (item.hasEOL ? "\n" : " ");
      }
      return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    }

    async function pageLayout(n: number): Promise<PageLayout> {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = (content.items as { str?: string; transform?: number[]; width?: number; height?: number }[])
        .filter((i) => i.str !== undefined && i.transform)
        .map((i) => ({ str: i.str as string, x: i.transform![4], y: i.transform![5], w: i.width ?? 0, h: i.height || Math.abs(i.transform![3]) }));
      const ops = await page.getOperatorList();
      const { OPS } = lib;
      const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintJpegXObject]);
      let images = 0;
      let paths = 0;
      for (const fn of ops.fnArray as number[]) {
        if (imageOps.has(fn)) images++;
        else if (fn === OPS.constructPath) paths++;
      }
      return { width: vp.width, height: vp.height, items, images, paths };
    }

    async function pagePng(n: number, scale: number) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale });
      const { createCanvas } = await import("@napi-rs/canvas");
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise;
      return canvas.toBuffer("image/png");
    }
  },
};
