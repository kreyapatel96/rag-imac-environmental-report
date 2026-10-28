import { describe, expect, it, vi } from "vitest";
import { isQuotaExhausted, retryDelayMs, withRetry } from "../src/lib/errors";

describe("rate-limit handling", () => {
  it("reads the retry delay and detects daily quota", () => {
    expect(retryDelayMs(new Error('{"error":{"details":[{"retryDelay":"23s"}]}}'))).toBe(23000);
    expect(isQuotaExhausted(new Error("Quota exceeded for metric: generate_content_free_tier_requests, limit: 0"))).toBe(true);
    expect(isQuotaExhausted(new Error("Resource has been exhausted (e.g. check quota)."))).toBe(false);
  });
  it("does not retry 429 unless rateLimitAttempts is set, and never retries daily quota", async () => {
    const e429 = Object.assign(new Error("slow down"), { status: 429 });
    const f = vi.fn().mockRejectedValue(e429);
    await expect(withRetry(f, { attempts: 4 })).rejects.toBe(e429);
    expect(f).toHaveBeenCalledTimes(1);
    const daily = Object.assign(new Error("limit: 0 PerDay"), { status: 429 });
    const g = vi.fn().mockRejectedValue(daily);
    await expect(withRetry(g, { rateLimitAttempts: 3 })).rejects.toBe(daily);
    expect(g).toHaveBeenCalledTimes(1);
  });
});
