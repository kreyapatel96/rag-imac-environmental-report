import { AppError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { streamIngest } from "@/lib/ingest-stream";
import { getServices } from "@/lib/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

/** Re-analyses the stored PDF (e.g. to re-run Gemini vision after a rate limit). Replacement is as safe as a normal upload. */
export async function POST() {
  try {
    const services = getServices();
    if (services.uploadLock.isLocked) throw new AppError("BUSY", "Another document is being processed. Wait for it to finish.", 409);
    const manifest = await services.storage.readManifest();
    if (!manifest) throw new AppError("NO_DOCUMENT", "No active document to re-analyse.", 409);
    return streamIngest(services, await services.storage.readPdf(manifest.docId), manifest.filename);
  } catch (e) {
    return errorResponse(e);
  }
}
