import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../src/lib/errors";
import { ingestDocument, type IngestDeps } from "../src/lib/ingest";
import { pdfTools } from "../src/lib/pdf";
import { answerQuestion, lexicalRank } from "../src/lib/rag";
import { LocalStorage } from "../src/lib/storage";
import { FakeCloud, FakeStore, makeFakeAi, type FakeAiOptions } from "./fakes";
import { makePdf } from "./fixtures";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "imac-rag-test-"));
});
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

function deps(answer?: FakeAiOptions["answer"]): IngestDeps {
  return {
    store: new FakeStore(shared),
    ai: makeFakeAi({ answer }),
    storage: new LocalStorage(dir),
    pdf: pdfTools,
    config: { collection: "t", visionModel: "f", embeddingModel: "f", embeddingProvider: "local" as const, ingestMode: "vision" as const, visionMaxPages: 99, embeddingDimensions: 64, maxUploadBytes: 1e7, maxPages: 5 },
  };
}
let shared: FakeCloud;
beforeEach(() => (shared = new FakeCloud()));

describe("RAG end to end (fake Gemini/Qdrant, real PDF parsing + rendering)", () => {
  it("retrieves the energy chunk and computes the percentage deterministically", async () => {
    const buffer = await makePdf([
      "Energy use: 120 kWh\nENERGY STAR requirement: 200 kWh",
      "Stand material: aluminum\nRecycled content: 100%",
    ]);
    const d = deps((_q, chunks) => {
      const iMac = chunks.find((c) => c.label === "Energy use")!;
      const star = chunks.find((c) => c.label === "ENERGY STAR requirement")!;
      return {
        status: "answered", answer: "iMac uses 40% less energy than the ENERGY STAR requirement.",
        evidence: [{ chunkId: iMac.chunkId, quote: "Energy use: 120 kWh" }, { chunkId: star.chunkId, quote: "ENERGY STAR requirement: 200 kWh" }],
        values: [], caveats: [],
        calculations: [{ label: "less than ENERGY STAR", operation: "percent_less", reportedResult: null, inputs: [
          { label: "iMac", value: 120, unit: "kWh", chunkId: iMac.chunkId }, { label: "ENERGY STAR", value: 200, unit: "kWh", chunkId: star.chunkId }] }],
      };
    });
    await ingestDocument(d, { buffer, filename: "r.pdf" });
    const res = await answerQuestion(d, "How much less energy compared with the ENERGY STAR requirement?");
    expect(res.status).toBe("answered");
    expect(res.calculations[0].result).toBe(40);
    expect(res.citations.map((c) => c.chunk.pageNumber)).toEqual([1, 1]);
    expect(res.citations.every((c) => c.chunk.chunkId.startsWith("p1-chart-"))).toBe(true);
    expect(res.citations.every((c) => c.quoteVerified)).toBe(true);
  });

  it("admits it cannot verify when the model invents a value", async () => {
    const d = deps(() => ({
      status: "answered", answer: "The footprint is 999 kg CO2e.", evidence: [{ chunkId: "p1-chart-1", quote: "999 kg" }],
      values: [{ label: "footprint", value: "999", unit: "kg CO2e", chunkId: "p1-chart-1" }], calculations: [], caveats: [],
    }));
    await ingestDocument(d, { buffer: await makePdf(["Carbon footprint: 270 kg"]), filename: "r.pdf" });
    const res = await answerQuestion(d, "carbon footprint");
    expect(res.status).toBe("partial");
    expect(res.values[0].verified).toBe(false);
    expect(res.warnings.join(" ")).toMatch(/999/);
  });

  it("returns insufficient_evidence with no fabricated citations when the model cites nothing real", async () => {
    const d = deps(() => ({ status: "answered", answer: "It is 42.", evidence: [{ chunkId: "nope", quote: "" }], values: [], calculations: [], caveats: [] }));
    await ingestDocument(d, { buffer: await makePdf(["Something: 1 kg"]), filename: "r.pdf" });
    const res = await answerQuestion(d, "what");
    expect(res.status).toBe("insufficient_evidence");
    expect(res.citations).toEqual([]);
    expect(res.answer).not.toContain("42");
  });

  it("falls back to showing retrieved evidence when Gemini is rate limited", async () => {
    const d = deps();
    await ingestDocument(d, { buffer: await makePdf(["Energy use: 120 kWh"]), filename: "r.pdf" });
    d.ai = { ...d.ai, answer: async () => { throw new AppError("GEMINI_RATE_LIMIT", "429", 429); } };
    const res = await answerQuestion(d, "energy use");
    expect(res.status).toBe("partial");
    expect(res.answer).toMatch(/rate limit/i);
    expect(res.citations.length).toBeGreaterThan(0);
    expect(res.citations[0].chunk.text).toContain("120 kWh");
  });

  it("rejects empty questions and questions with no active document", async () => {
    const d = deps();
    await expect(answerQuestion(d, "hi there")).rejects.toMatchObject({ code: "NO_DOCUMENT" });
    await expect(answerQuestion(d, "   ")).rejects.toThrow(/question/i);
  });
});

describe("lexicalRank", () => {
  it("ranks chunks containing rare query terms first", () => {
    const mk = (id: string, text: string) => ({ id, payload: { docId: "d", chunkId: id, pageNumber: 1, sourceType: "paragraph" as const, origin: "vision" as const, label: "", labels: [], text, facts: [], footnotes: [], referencedBy: [] } });
    const r = lexicalRank("stand recycled aluminum", [mk("a", "display brightness nits"), mk("b", "The stand is aluminum, 100% recycled")], 5);
    expect(r[0].id).toBe("b");
    expect(r).toHaveLength(1);
  });
});
