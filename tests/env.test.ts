import { describe, expect, it } from "vitest";
import { envProblems, parseEnv } from "../src/lib/env";

const valid = { GEMINI_API_KEY: "AIza-test-key-123", QDRANT_URL: "https://x.cloud.qdrant.io:6333", QDRANT_API_KEY: "qdrant-key" };

describe("env validation", () => {
  it("applies defaults for a minimal valid config", () => {
    const e = parseEnv(valid);
    expect(e.QDRANT_COLLECTION).toBe("imac_rag_chunks");
    expect(e.EMBEDDING_PROVIDER).toBe("local");
    expect(e.EMBEDDING_DIMENSIONS).toBe(384);
    expect(e.INGEST_MODE).toBe("hybrid");
    expect(parseEnv({ ...valid, EMBEDDING_PROVIDER: "gemini" }).EMBEDDING_DIMENSIONS).toBe(768);
    expect(e.MAX_UPLOAD_MB).toBe(50);
  });
  it("lists every missing/invalid variable without echoing secrets", () => {
    const p = envProblems({ GEMINI_API_KEY: "", QDRANT_URL: "not a url", QDRANT_API_KEY: "" });
    expect(p.join("\n")).toMatch(/GEMINI_API_KEY/);
    expect(p.join("\n")).toMatch(/QDRANT_URL/);
    expect(p.join("\n")).toMatch(/QDRANT_API_KEY/);
    expect(envProblems(valid)).toEqual([]);
  });
  it("rejects bad collection names", () => {
    expect(() => parseEnv({ ...valid, QDRANT_COLLECTION: "a b/c" })).toThrow(/QDRANT_COLLECTION/);
  });
});
