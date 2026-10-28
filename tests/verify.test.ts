import { describe, expect, it } from "vitest";
import { valueAppearsIn, verifyAnswer } from "../src/lib/rag";
import type { RawAnswer } from "../src/lib/ai";
import type { RetrievedChunk } from "../src/lib/types";

const chunk = (over: Partial<RetrievedChunk>): RetrievedChunk => ({
  docId: "d", chunkId: "p3-chart-1", pageNumber: 3, sourceType: "chart", origin: "vision", label: "Energy", labels: [],
  text: "Typical energy use: 120 kWh per year. ENERGY STAR requirement: 200 kWh per year.", facts: [], footnotes: [], referencedBy: [],
  pointId: "pt", score: 1, vectorRank: 1, lexicalRank: 1, ...over,
});
const meta = { docId: "d", filename: "f.pdf" };
const base: RawAnswer = { status: "answered", answer: "", evidence: [], values: [], calculations: [], caveats: [] };

describe("valueAppearsIn", () => {
  it("matches whole numbers only", () => {
    const c = chunk({});
    expect(valueAppearsIn("120", c)).toBe(true);
    expect(valueAppearsIn("12", c)).toBe(false);
    expect(valueAppearsIn("20", c)).toBe(false);
    expect(valueAppearsIn("1,200", chunk({ text: "total 1,200 kg" }))).toBe(true);
  });
});

describe("verifyAnswer", () => {
  it("discards fabricated chunk ids and reports insufficient evidence", () => {
    const r = verifyAnswer("q", { ...base, answer: "It is 5.", evidence: [{ chunkId: "p99-fake-1", quote: "x" }] }, [chunk({})], meta);
    expect(r.citations).toHaveLength(0);
    expect(r.status).toBe("insufficient_evidence");
    expect(r.warnings.join()).toMatch(/p99-fake-1/);
  });
  it("verifies quotes and values literally against chunk text", () => {
    const r = verifyAnswer("q", {
      ...base, answer: "Usage is 120 kWh (page 3).",
      evidence: [{ chunkId: "p3-chart-1", quote: "Typical energy use: 120 kWh per year" }],
      values: [{ label: "use", value: "120", unit: "kWh", chunkId: "p3-chart-1" }],
    }, [chunk({})], meta);
    expect(r.status).toBe("answered");
    expect(r.citations[0].quoteVerified).toBe(true);
    expect(r.values[0].verified).toBe(true);
    expect(r.warnings).toEqual([]);
  });
  it("downgrades when a value or prose number is not in the evidence", () => {
    const r = verifyAnswer("q", {
      ...base, answer: "Usage is 999 kWh.",
      evidence: [{ chunkId: "p3-chart-1", quote: "not in the chunk" }],
      values: [{ label: "use", value: "999", unit: "kWh", chunkId: "p3-chart-1" }],
    }, [chunk({})], meta);
    expect(r.status).toBe("partial");
    expect(r.values[0].verified).toBe(false);
    expect(r.warnings.join()).toMatch(/999/);
  });
  it("computes derived numbers server-side from verified inputs", () => {
    const r = verifyAnswer("q", {
      ...base, answer: "It uses 40% less energy (120 vs 200 kWh).",
      evidence: [{ chunkId: "p3-chart-1", quote: "" }],
      calculations: [{ label: "less than ENERGY STAR", operation: "percent_less", inputs: [
        { label: "iMac", value: 120, unit: "kWh", chunkId: "p3-chart-1" },
        { label: "ENERGY STAR", value: 200, unit: "kWh", chunkId: "p3-chart-1" }], reportedResult: null }],
    }, [chunk({})], meta);
    expect(r.calculations[0].result).toBe(40);
    expect(r.calculations[0].inputs.every((i) => i.verified)).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.status).toBe("answered");
  });
  it("flags calculation inputs the chunk does not contain", () => {
    const r = verifyAnswer("q", { ...base, answer: "x", evidence: [{ chunkId: "p3-chart-1", quote: "" }],
      calculations: [{ label: "d", operation: "difference", inputs: [
        { label: "a", value: 500, unit: "kWh", chunkId: "p3-chart-1" }, { label: "b", value: 200, unit: "kWh", chunkId: "p3-chart-1" }] }] }, [chunk({})], meta);
    expect(r.calculations[0].inputs[0].verified).toBe(false);
    expect(r.status).toBe("partial");
  });
  it("surfaces footnotes attached to cited chunks", () => {
    const c = chunk({ footnotes: [{ marker: "*", text: "Based on 4-year use.", chunkId: "p3-footnote-1" }] });
    const r = verifyAnswer("q", { ...base, answer: "120", evidence: [{ chunkId: "p3-chart-1", quote: "" }] }, [c], meta);
    expect(r.citations[0].footnoteChunks[0]).toMatchObject({ marker: "*", chunkId: "p3-footnote-1" });
  });
});
