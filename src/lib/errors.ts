export type ErrorCode =
  | "ENV_INVALID"
  | "NO_DOCUMENT"
  | "INVALID_UPLOAD"
  | "INVALID_PDF"
  | "PDF_PARSE_FAILED"
  | "GEMINI_AUTH"
  | "GEMINI_RATE_LIMIT"
  | "GEMINI_FAILED"
  | "QDRANT_AUTH"
  | "QDRANT_UNREACHABLE"
  | "QDRANT_FAILED"
  | "BUSY"
  | "INTERNAL";

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status = 500,
    public cause?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AppError("INTERNAL", message, 500, err);
}

/** Pulls an HTTP-ish status out of the different SDK error shapes. */
export function errorStatus(err: unknown): number | undefined {
  const e = err as { status?: number; code?: number; response?: { status?: number } } | null;
  const s = e?.status ?? e?.response?.status ?? (typeof e?.code === "number" ? e.code : undefined);
  return typeof s === "number" ? s : undefined;
}

export function isTransient(err: unknown): boolean {
  const s = errorStatus(err);
  if (s !== undefined) return s === 429 || s === 408 || s >= 500;
  const msg = err instanceof Error ? err.message : "";
  return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|UND_ERR|network|timeout/i.test(msg);
}

/** Daily/monthly quota exhaustion will not recover within a retry window. */
export function isQuotaExhausted(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : "";
  return /PerDay|per day|daily|limit:\s*0\b|billing/i.test(msg);
}

/** Seconds the API asked us to wait ("retryDelay":"23s" / "retry in 23.5s"), if present. */
export function retryDelayMs(err: unknown): number | undefined {
  const msg = err instanceof Error ? err.message : "";
  const m = msg.match(/retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s/i) ?? msg.match(/retry (?:in|after) (\d+(?:\.\d+)?)\s*s/i);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : undefined;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number; rateLimitAttempts?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseMs ?? 800;
  const rlAttempts = opts.rateLimitAttempts ?? 0;
  let last: unknown;
  let rl = 0;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const limited = errorStatus(err) === 429;
      if (limited && rlAttempts > 0 && !isQuotaExhausted(err)) {
        // Requests-per-minute limit: wait as long as the API says (min 20s, max 90s), up to rlAttempts times.
        if (rl++ >= rlAttempts) break;
        const wait = Math.min(90_000, Math.max(20_000, retryDelayMs(err) ?? 0)) + Math.random() * 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (i >= attempts - 1 || !isTransient(err) || limited) break;
      await new Promise((r) => setTimeout(r, base * 2 ** i + Math.random() * 250));
    }
  }
  throw last;
}
