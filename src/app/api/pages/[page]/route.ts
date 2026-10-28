import { AppError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { pdfTools } from "@/lib/pdf";
import { getServices } from "@/lib/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PNG of one page of the ACTIVE document (cached on disk, re-rendered from the stored PDF if needed). */
export async function GET(_req: Request, ctx: { params: Promise<{ page: string }> }) {
  try {
    const { page } = await ctx.params;
    const n = Number(page);
    const { storage } = getServices();
    const manifest = await storage.readManifest();
    if (!manifest) throw new AppError("NO_DOCUMENT", "No active document.", 404);
    if (!Number.isInteger(n) || n < 1 || n > manifest.pageCount) throw new AppError("INVALID_UPLOAD", "Page out of range.", 400);

    let png = await storage.readPage(manifest.docId, n);
    if (!png) {
      const handle = await pdfTools.load(await storage.readPdf(manifest.docId));
      try {
        png = await handle.renderPagePng(n, 2);
      } finally {
        await handle.destroy();
      }
      await storage.savePage(manifest.docId, n, png);
    }
    return new Response(new Uint8Array(png), {
      headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600", ETag: `"${manifest.docId}-${n}"` },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
