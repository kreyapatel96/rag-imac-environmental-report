import { describe, expect, it } from "vitest";
import { buildPageChunks, embeddingText, pointIdFor } from "../src/lib/chunking";

const analysis = {
  elements: [
    { type: "chart" as const, label: "Carbon footprint", labels: ["Use", "Production"], text: "Use: 55%; Production: 38%", values: [{ label: "Use", value: "55", unit: "%" }], footnoteMarkers: ["*"] },
    { type: "paragraph" as const, label: "Intro", labels: [], text: "  Some   text ", values: [], footnoteMarkers: ["†"] },
    { type: "table" as const, label: "empty", labels: [], text: "", values: [], footnoteMarkers: [] },
  ],
  footnotes: [{ marker: "*", text: "Based on 4-year use." }],
};

describe("buildPageChunks", () => {
  const chunks = buildPageChunks("doc1", 7, analysis, "raw page text");

  it("creates readable unique chunk ids and keeps the page number", () => {
    const ids = chunks.map((c) => c.chunkId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("p7-chart-1");
    expect(chunks.every((c) => c.pageNumber === 7 && c.docId === "doc1")).toBe(true);
  });
  it("links footnotes both ways and ignores unknown markers", () => {
    const chart = chunks.find((c) => c.chunkId === "p7-chart-1")!;
    const note = chunks.find((c) => c.sourceType === "footnote")!;
    expect(chart.footnotes).toEqual([{ marker: "*", text: "Based on 4-year use.", chunkId: note.chunkId }]);
    expect(note.referencedBy).toEqual(["p7-chart-1"]);
    expect(chunks.find((c) => c.chunkId === "p7-paragraph-1")!.footnotes).toEqual([]);
  });
  it("drops empty elements, normalises whitespace and adds a verbatim text-layer chunk", () => {
    expect(chunks.some((c) => c.label === "empty")).toBe(false);
    expect(chunks.find((c) => c.chunkId === "p7-paragraph-1")!.text).toBe("Some text");
    const raw = chunks.find((c) => c.origin === "text-layer")!;
    expect(raw.text).toBe("raw page text");
  });
  it("embeds facts and footnotes with the text", () => {
    const t = embeddingText(chunks.find((c) => c.chunkId === "p7-chart-1")!);
    expect(t).toContain("Facts: Use: 55% (p7)");
    expect(t).toContain("Based on 4-year use.");
  });
  it("point ids are stable UUID-shaped values", () => {
    expect(pointIdFor("a", "b")).toBe(pointIdFor("a", "b"));
    expect(pointIdFor("a", "b")).not.toBe(pointIdFor("a2", "b"));
    expect(pointIdFor("a", "b")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
