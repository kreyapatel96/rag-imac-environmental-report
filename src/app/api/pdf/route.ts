import { AppError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { getServices } from "@/lib/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Streams the stored active PDF (open with #page=N to jump to a page). */
export async function GET() {
  try {
    const { storage } = getServices();
    const manifest = await storage.readManifest();
    if (!manifest) throw new AppError("NO_DOCUMENT", "No active document.", 404);
    const data = await storage.readPdf(manifest.docId);
    return new Response(new Uint8Array(data), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${encodeURIComponent(manifest.filename)}"` },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
