import crypto from "node:crypto";
import type { AiClient, PageAnalysis } from "./ai";
import { buildPageChunks, embeddingText, pointIdFor } from "./chunking";
import { collectEndnotes, linkFootnotes } from "./footnotes";
import { analyzeLayout } from "./layout";
import { AppError, toAppError } from "./errors";
import type { PdfTools } from "./pdf";
import type { LocalStorage } from "./storage";
import type { ChunkPayload, DocumentManifest, IngestProgress, SourceType } from "./types";
import type { VectorStore } from "./vectorstore";

export interface IngestDeps {
  store: VectorStore;
  ai: AiClient;
  storage: LocalStorage;
  pdf: PdfTools;
  config: {
    collection: string;
    visionModel: string;
    embeddingModel: string;
    embeddingProvider: "local" | "gemini";
    embeddingDimensions: number;
    ingestMode: "local" | "hybrid" | "vision";
    visionMaxPages: number;
    maxUploadBytes: number;
    maxPages: number;
    pageConcurrency?: number; // local parsing
    visionConcurrency?: number;
  };
}

type Progress = (p: IngestProgress) => void;

export function validatePdfBuffer(buf: Buffer, maxBytes: number) {
  if (buf.length === 0) throw new AppError("INVALID_UPLOAD", "The uploaded file is empty.", 400);
  if (buf.length > maxBytes)
    throw new AppError("INVALID_UPLOAD", `File is too large (max ${Math.round(maxBytes / 1048576)} MB).`, 413);
  if (buf.subarray(0, 1024).indexOf("%PDF-") === -1)
    throw new AppError("INVALID_PDF", "That file is not a PDF (missing %PDF header).", 415);
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed: unknown = null;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (failed === null) {
        const i = next++;
        if (i >= items.length) return;
        try {
          out[i] = await fn(items[i], i);
        } catch (e) {
          failed = e;
          return;
        }
      }
    }),
  );
  if (failed !== null) throw failed;
  return out;
}

/**
 * Validates + indexes a new PDF and, only if everything succeeded, makes it the single active document.
 * The previously active document (vectors, PDF, page images, manifest) is untouched until the very last step.
 */
export async function ingestDocument(
  deps: IngestDeps,
  input: { buffer: Buffer; filename: string },
  onProgress: Progress = () => {},
): Promise<DocumentManifest> {
  const { store, ai, storage, pdf, config } = deps;
  const { buffer, filename } = input;

  onProgress({ stage: "validating", message: "Validating PDF…", percent: 2 });
  validatePdfBuffer(buffer, config.maxUploadBytes);

  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const docId = `${Date.now().toString(36)}-${sha256.slice(0, 10)}`;
  const previous = await storage.readManifest();

  let handle: Awaited<ReturnType<PdfTools["load"]>> | null = null;
  try {
    handle = await pdf.load(buffer);
    if (handle.numPages < 1) throw new AppError("INVALID_PDF", "The PDF has no pages.", 422);
    if (handle.numPages > config.maxPages)
      throw new AppError("INVALID_PDF", `The PDF has ${handle.numPages} pages; the limit is ${config.maxPages}.`, 422);
    const pageCount = handle.numPages;

    onProgress({ stage: "saving", message: "Saving PDF to local storage…", percent: 5, pageCount });
    await storage.stagePdf(docId, buffer);

    // ---- 1. local pass over every page: text layer, geometry, layout analysis, page image (no API calls) ----
    const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
    let localDone = 0;
    const locals = await mapPool(pages, 4, async (n) => {
      const [png, text, layout] = await Promise.all([handle!.renderPagePng(n, 2), handle!.getPageText(n), handle!.getLayout(n)]);
      await storage.savePage(docId, n, png);
      const local = analyzeLayout(layout);
      localDone++;
      onProgress({
        stage: "analyzing",
        message: `Parsed page ${n} locally (${localDone}/${pageCount})`,
        percent: 5 + Math.round((localDone / pageCount) * 20),
        page: n,
        pageCount,
      });
      return { n, png, text, local };
    });

    // ---- 2. choose pages that need Gemini vision (charts / images), within the budget ----
    const wanted =
      config.ingestMode === "vision"
        ? locals
        : config.ingestMode === "local"
          ? []
          : locals
              .filter((p) => p.local.needsVision)
              .sort((a, b) => b.local.visualScore - a.local.visualScore)
              .slice(0, config.visionMaxPages);
    const visionPlanned = new Set(wanted.map((p) => p.n));
    const visionResults = new Map<number, PageAnalysis>();
    const visionFailedPages: number[] = [];
    const warnings: string[] = [];
    let visionDone = 0;
    let rateLimited: string | null = null; // once Gemini is rate limited, stop hammering it for the remaining pages
    await mapPool(wanted, config.visionConcurrency ?? 1, async (p) => {
      if (rateLimited) {
        visionFailedPages.push(p.n);
        visionDone++;
        return;
      }
      onProgress({
        stage: "analyzing",
        message: `Reading chart/image page ${p.n} with Gemini vision… (${visionDone}/${wanted.length} done)`,
        percent: 25 + Math.round((visionDone / Math.max(1, wanted.length)) * 40),
        page: p.n,
        pageCount,
      });
      try {
        visionResults.set(p.n, await ai.analyzePage({ pageNumber: p.n, imagePng: p.png, textLayer: p.text }));
      } catch (e) {
        const err = toAppError(e);
        // Bad key / quota problems affect every page: stop instead of silently degrading.
        if (err.code === "GEMINI_AUTH") throw err;
        visionFailedPages.push(p.n);
        if (err.code === "GEMINI_RATE_LIMIT") rateLimited = err.message;
        else warnings.push(`Vision failed for page ${p.n} (${err.code}); local analysis used instead.`);
      }
      visionDone++;
    });
    visionFailedPages.sort((a, b) => a - b);
    if (rateLimited)
      warnings.push(
        `${rateLimited} Pages ${visionFailedPages.join(", ")} were indexed with local layout analysis only; charts on them may be less precise. Re-upload later to re-run vision.`,
      );

    const built: ChunkPayload[] = locals.flatMap((p) => {
      const vision = visionResults.get(p.n);
      if (vision) return buildPageChunks(docId, p.n, vision, p.text, { origin: "vision", includeRawText: true });
      return buildPageChunks(docId, p.n, p.local.analysis, p.text, {
        origin: "layout",
        includeRawText: true, // verbatim page text as a fallback evidence chunk
      });
    });
    // ---- link footnotes across pages (e.g. "…ENERGY STAR. 18" on page 7 → note 18 printed on the Endnotes page) ----
    const chunks = built.length ? linkFootnotes(built, collectEndnotes(locals.map((p) => ({ page: p.n, text: p.text })))) : built;
    if (chunks.length === 0)
      throw new AppError("INVALID_PDF", "No readable content could be extracted from this PDF.", 422);
    if (!rateLimited && config.ingestMode !== "local" && visionPlanned.size > 0 && visionResults.size === 0)
      warnings.push("Gemini vision produced no results for any chart page; the index uses local layout analysis only.");

    // ---- embed ----
    onProgress({ stage: "embedding", message: `Embedding ${chunks.length} chunks…`, percent: 68, pageCount });
    const vectors = await ai.embed(
      chunks.map((c) => embeddingText(c).slice(0, 8000)),
      "document",
    );

    // ---- index (new docId; the old document stays queryable until activation) ----
    onProgress({ stage: "indexing", message: "Writing vectors to Qdrant…", percent: 82, pageCount });
    await store.ensureCollection(config.embeddingDimensions);
    await store.upsert(chunks.map((c, i) => ({ id: pointIdFor(docId, c.chunkId), vector: vectors[i], payload: c })));
    const stored = await store.countDoc(docId);
    if (stored !== chunks.length)
      throw new AppError("QDRANT_FAILED", `Qdrant stored ${stored} of ${chunks.length} chunks; aborting.`, 502);

    // ---- activate: promote PDF, then flip the manifest (single atomic switch) ----
    onProgress({ stage: "activating", message: "Activating new document…", percent: 92, pageCount });
    const bySourceType = { chart: 0, table: 0, paragraph: 0, callout: 0, footnote: 0 } as Record<SourceType, number>;
    for (const c of chunks) bySourceType[c.sourceType]++;
    const now = new Date().toISOString();
    const manifest: DocumentManifest = {
      docId,
      filename,
      sizeBytes: buffer.length,
      sha256,
      pageCount,
      uploadedAt: now,
      indexedAt: now,
      collection: config.collection,
      stats: {
        pagesAnalyzed: pageCount,
        visionPages: [...visionResults.keys()].sort((a, b) => a - b),
        localPages: pages.filter((n) => !visionResults.has(n)),
        visionFailedPages,
        warnings,
        ingestMode: config.ingestMode,
        embeddingProvider: config.embeddingProvider,
        chunks: chunks.length,
        facts: chunks.reduce((s, c) => s + c.facts.length, 0),
        footnotes: bySourceType.footnote,
        bySourceType,
        visionModel: config.visionModel,
        embeddingModel: config.embeddingModel,
        embeddingDimensions: config.embeddingDimensions,
      },
    };
    await storage.promotePdf(docId);
    await storage.writeManifest(manifest);
  } catch (err) {
    // Roll back everything belonging to the NEW document; the old one was never touched.
    await store.deleteDoc(docId).catch(() => {});
    await storage.removeDoc(docId).catch(() => {});
    throw toAppError(err);
  } finally {
    await handle?.destroy().catch(() => {});
  }

  // ---- cleanup of the replaced document (best effort: queries are already filtered to the new docId) ----
  onProgress({ stage: "cleanup", message: "Removing the previous document…", percent: 96 });
  const manifest = (await storage.readManifest())!;
  await store.deleteAllExcept(docId).catch(() => {});
  if (previous && previous.docId !== docId) await storage.removeDoc(previous.docId).catch(() => {});
  await storage.removeAllExcept(docId).catch(() => {});
  onProgress({ stage: "done", message: "Document indexed and active.", percent: 100 });
  return manifest;
}
