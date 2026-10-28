import { getEnv } from "./env";
import type { AiClient } from "./ai";
import { createGeminiClient } from "./gemini";
import { createLocalEmbedder } from "./localEmbed";
import { Mutex } from "./mutex";
import { pdfTools } from "./pdf";
import { createQdrantStore } from "./qdrant";
import { LocalStorage } from "./storage";
import type { IngestDeps } from "./ingest";
import type { RagDeps } from "./rag";

interface Services {
  rag: RagDeps;
  ingest: IngestDeps;
  storage: LocalStorage;
  uploadLock: Mutex;
}

const g = globalThis as unknown as { __imacServices?: Services; __imacLock?: Mutex };

/** Lazily wires real Gemini + Qdrant + local disk. Throws ENV_INVALID with a readable message if misconfigured. */
export function getServices(): Services {
  // Cached across requests in production only; in dev a cache would keep pre-hot-reload modules alive (stale code).
  if (g.__imacServices && process.env.NODE_ENV === "production") return g.__imacServices;
  const env = getEnv();
  const storage = new LocalStorage(env.DATA_DIR);
  const gemini = createGeminiClient(env);
  // Vision + answers always use Gemini; embeddings are local by default (no quota).
  const ai: AiClient =
    env.EMBEDDING_PROVIDER === "local"
      ? { ...gemini, embed: createLocalEmbedder(env.LOCAL_EMBEDDING_MODEL, env.DATA_DIR, env.EMBEDDING_DIMENSIONS) }
      : gemini;
  const store = createQdrantStore(env);
  g.__imacLock ??= new Mutex();
  g.__imacServices = {
    storage,
    uploadLock: g.__imacLock,
    rag: { store, ai, storage },
    ingest: {
      store,
      ai,
      storage,
      pdf: pdfTools,
      config: {
        collection: env.QDRANT_COLLECTION,
        visionModel: env.GEMINI_VISION_MODEL ?? env.GEMINI_MODEL,
        embeddingModel: env.EMBEDDING_PROVIDER === "local" ? env.LOCAL_EMBEDDING_MODEL : env.GEMINI_EMBEDDING_MODEL,
        embeddingProvider: env.EMBEDDING_PROVIDER,
        ingestMode: env.INGEST_MODE,
        visionMaxPages: env.VISION_MAX_PAGES,
        visionConcurrency: env.VISION_CONCURRENCY,
        embeddingDimensions: env.EMBEDDING_DIMENSIONS,
        maxUploadBytes: env.MAX_UPLOAD_MB * 1024 * 1024,
        maxPages: env.MAX_PDF_PAGES,
      },
    },
  };
  return g.__imacServices;
}
