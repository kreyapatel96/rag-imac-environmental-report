import { AppError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { streamIngest } from "@/lib/ingest-stream";
import { getServices } from "@/lib/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function POST(req: Request) {
  try {
    const services = getServices();
    if (services.uploadLock.isLocked) throw new AppError("BUSY", "Another document is being processed. Wait for it to finish.", 409);
    const form = await req.formData().catch(() => null);
    const f = form?.get("file");
    if (!(f instanceof File)) throw new AppError("INVALID_UPLOAD", 'Send multipart form data with a "file" field.', 400);
    if (f.size > services.ingest.config.maxUploadBytes)
      throw new AppError("INVALID_UPLOAD", `File is too large (max ${services.ingest.config.maxUploadBytes / 1048576} MB).`, 413);
    const filename = f.name.replace(/[^\w.\- ()]/g, "_").slice(0, 200) || "document.pdf";
    return streamIngest(services, Buffer.from(await f.arrayBuffer()), filename);
  } catch (e) {
    return errorResponse(e);
  }
}
