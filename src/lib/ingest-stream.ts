import { toAppError } from "./errors";
import { ingestDocument } from "./ingest";
import { getServices } from "./services";

/**
 * Runs an ingestion under the upload lock and streams newline-delimited JSON events:
 *   {"type":"progress", ...IngestProgress} … then {"type":"done","document":{…}} or {"type":"error",…}
 */
export function streamIngest(services: ReturnType<typeof getServices>, buffer: Buffer, filename: string): Response {
  const { ingest, uploadLock } = services;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          /* client disconnected; processing continues so state stays consistent */
        }
      };
      try {
        const document = await uploadLock.runExclusive(() => ingestDocument(ingest, { buffer, filename }, (p) => send({ type: "progress", ...p })));
        send({ type: "done", document });
      } catch (e) {
        const err = toAppError(e);
        if (err.status >= 500) console.error(`[${err.code}]`, err.message, err.cause ?? "");
        send({ type: "error", code: err.code, message: err.message });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
