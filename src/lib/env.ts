import { z } from "zod";
import path from "node:path";
import { AppError } from "./errors";

const schema = z.object({
  GEMINI_API_KEY: z.string().min(10, "GEMINI_API_KEY is missing"),
  GEMINI_MODEL: z.string().min(1).default("gemini-2.5-flash"),
  // Optional cheaper/faster model just for reading chart pages (e.g. a *-flash-lite model with higher free limits).
  GEMINI_VISION_MODEL: z.string().min(1).optional(),
  GEMINI_EMBEDDING_MODEL: z.string().min(1).default("gemini-embedding-001"),
  // "local" runs a small embedding model inside Node (no API quota). "gemini" uses the Gemini embedding API.
  EMBEDDING_PROVIDER: z.enum(["local", "gemini"]).default("local"),
  LOCAL_EMBEDDING_MODEL: z.string().min(1).default("Xenova/bge-small-en-v1.5"),
  // Gemini: 64–3072 (default 768). Local: must match the model (bge-small = 384).
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(64).max(3072).optional(),
  // local = never call Gemini vision; hybrid = vision only for chart/image-heavy pages; vision = every page.
  INGEST_MODE: z.enum(["local", "hybrid", "vision"]).default("hybrid"),
  // Parallel Gemini vision calls. Keep at 1 on free tiers to stay under requests-per-minute limits.
  VISION_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  VISION_MAX_PAGES: z.coerce.number().int().min(0).max(500).default(15),
  QDRANT_URL: z.url("QDRANT_URL must be a full URL, e.g. https://xyz.cloud.qdrant.io:6333"),
  QDRANT_API_KEY: z.string().min(5, "QDRANT_API_KEY is missing"),
  QDRANT_COLLECTION: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, "QDRANT_COLLECTION may only contain letters, digits, _ and -")
    .default("imac_rag_chunks"),
  DATA_DIR: z.string().min(1).default("./data"),
  MAX_UPLOAD_MB: z.coerce.number().positive().max(200).default(50),
  MAX_PDF_PAGES: z.coerce.number().int().positive().max(500).default(60),
});

export type Env = Omit<z.infer<typeof schema>, "DATA_DIR" | "EMBEDDING_DIMENSIONS"> & {
  DATA_DIR: string;
  EMBEDDING_DIMENSIONS: number;
};

export function parseEnv(source: Record<string, string | undefined>): Env {
  const input = Object.fromEntries(
    Object.entries(source).map(([k, v]) => [k, v === "" ? undefined : v]),
  );
  const result = schema.safeParse(input);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`);
    throw new AppError(
      "ENV_INVALID",
      `Invalid environment configuration. Fix .env.local and restart.\n- ${problems.join("\n- ")}`,
      500,
    );
  }
  const env = result.data;
  const dims = env.EMBEDDING_DIMENSIONS ?? (env.EMBEDDING_PROVIDER === "local" ? 384 : 768);
  return { ...env, EMBEDDING_DIMENSIONS: dims, DATA_DIR: path.resolve(env.DATA_DIR) };
}

let cached: Env | null = null;
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Non-throwing variant for the health endpoint / setup banner. Never returns secret values. */
export function envProblems(source: Record<string, string | undefined> = process.env): string[] {
  try {
    parseEnv(source);
    return [];
  } catch (e) {
    return e instanceof AppError ? e.message.split("\n- ").slice(1) : [String(e)];
  }
}
