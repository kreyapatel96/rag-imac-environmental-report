import { describe, expect, it } from "vitest";
import type { RawAnswer } from "../src/lib/ai";
import { quoteSupported } from "../src/lib/evidence";
import { extractFacts } from "../src/lib/facts";
import { collectEndnotes, linkFootnotes } from "../src/lib/footnotes";
import { verifyAnswer } from "../src/lib/rag";
import type { ChunkPayload, RetrievedChunk } from "../src/lib/types";

/* Text exactly as pdf.js extracts it from the iMac Product Environmental Report (pages 7 and 12). */
const P7_TEXT =
  "Energy consumption of ENERGY STAR–rated products Apple devices consistently rank among the high-performing products rated by ENERGY STAR, " +
  "which sets specifications that typically reflect the 25 percent most energy-efficient devices on   the market. " +
  "iMac consumes 58   percent less energy   than the requirement for ENERGY   STAR. 18";
const P12_RAW = [
  "Endnotes",
  "© 2024 Apple Inc. All rights reserved. Apple, the Apple logo are trademarks of Apple Inc.",
  "17   Responsible sourcing of wood fiber is defined in   Apple’s Responsible Fiber Specification . We consider wood fibers",
  "to include bamboo.",
  "18   Energy consumption and energy efficiency values are based on the ENERGY STAR Program Requirements",
  "for Computers, including the max energy allowance for iMac. For more information, visit   www.energystar.gov .",
  "ENERGY STAR and the ENERGY STAR mark are registered trademarks owned by the U.S. Environmental Protection",
  "Agency. iMac is tested with the 143W Power Adapter, AC Cable (1m), and DC Cable (2m).",
  "•   Off: Lowest power mode of the system. System is shut down.",
  "19   Trade-in values vary based on the condition, year, and configuration of your trade-in device.",
  "Mode",
].join("\n");

const base = (over: Partial<ChunkPayload>): ChunkPayload => ({
  docId: "d", chunkId: "p7-paragraph-2", pageNumber: 7, sourceType: "paragraph", origin: "layout",
  label: "Energy consumption of ENERGY STAR–rated products", labels: [], text: P7_TEXT, facts: [], footnotes: [], referencedBy: [], markers: ["18"], ...over,
});

function linkedChunk(over: Partial<ChunkPayload> = {}): RetrievedChunk {
  const linked = linkFootnotes([base(over)], collectEndnotes([{ page: 12, text: P12_RAW }]));
  const c = linked.find((x) => x.chunkId === (over.chunkId ?? "p7-paragraph-2"))!;
  return { ...c, pointId: "pt", score: 1, vectorRank: 1, lexicalRank: 1 };
}

const raw = (over: Partial<RawAnswer>): RawAnswer => ({
  status: "answered",
  answer: "iMac consumes 58% less energy than the requirement for ENERGY STAR (page 7).",
  evidence: [{ chunkId: "p7-paragraph-2", quote: "iMac consumes 58 percent less energy than the requirement for ENERGY STAR" }],
  values: [{ label: "energy saving vs ENERGY STAR", value: "58", unit: "%", chunkId: "p7-paragraph-2" }],
  calculations: [], caveats: [], ...over,
});
const meta = { docId: "d", filename: "iMac_PER_Oct2024.pdf" };
const run = (r: RawAnswer, c = linkedChunk()) => verifyAnswer("q", r, [c], meta);

describe("quote verification ignores harmless formatting only", () => {
  const chunk = linkedChunk();
  it.each([
    ["extra spaces inside the sentence", "iMac consumes 58 percent less energy than the requirement for ENERGY STAR"],
    ["trailing sentence period and glued footnote number", "iMac consumes 58 percent less energy than the requirement for ENERGY STAR.18"],
    ["spaced footnote number", "iMac consumes 58 percent less energy than the requirement for ENERGY STAR. 18"],
    ["footnote number copied without a period", "iMac consumes 58 percent less energy than the requirement for ENERGY STAR 18"],
    ["% instead of the word percent", "iMac consumes 58% less energy than the requirement for ENERGY STAR"],
    ["different case and curly punctuation", "IMAC CONSUMES 58 PERCENT LESS ENERGY THAN THE REQUIREMENT FOR “ENERGY STAR”."],
    ["newlines instead of spaces", "iMac consumes 58 percent\nless energy than the\nrequirement for ENERGY STAR"],
    ["ellipsis between fragments", "iMac consumes 58 percent … requirement for ENERGY STAR"],
    ["en dash vs hyphen", "ENERGY STAR-rated products Apple devices consistently rank"],
  ])("accepts: %s", (_n, quote) => expect(quoteSupported(quote, chunk)).toBe(true));

  it.each([
    ["different verb", "iMac uses 58 percent less energy than the requirement for ENERGY STAR"],
    ["different number", "iMac consumes 85 percent less energy than the requirement for ENERGY STAR"],
    ["opposite direction", "iMac consumes 58 percent more energy than the requirement for ENERGY STAR"],
    ["dropped word that changes meaning", "iMac consumes 58 percent energy than the requirement for ENERGY STAR"],
    ["reordered words", "less energy 58 percent iMac consumes"],
    ["text that is not in the chunk", "iMac is the most efficient computer ever made"],
    ["fragments out of order", "requirement for ENERGY STAR … iMac consumes 58 percent"],
    ["a single word", "58"],
  ])("rejects: %s", (_n, quote) => expect(quoteSupported(quote, chunk)).toBe(false));

  it("does not accept a trailing number as a footnote marker unless the chunk really has that footnote", () => {
    const noFootnote = { ...chunk, footnotes: [] };
    expect(quoteSupported("iMac consumes 58 percent less energy than the requirement for ENERGY STAR 18", noFootnote)).toBe(false);
  });
});

describe("structured fact extraction keeps the complete claim", () => {
  it("captures value, unit, comparison, subject and the full sentence", () => {
    const f = extractFacts(P7_TEXT).find((x) => x.value === "58")!;
    expect(f).toMatchObject({
      value: "58",
      unit: "%",
      label: "energy",
      subject: "iMac",
      comparison: { direction: "less", reference: "the requirement for ENERGY STAR" },
    });
    expect(f.claim).toBe("iMac consumes 58 percent less energy than the requirement for ENERGY STAR.");
  });
  it("does not confuse the 25 percent statement with the 58 percent claim", () => {
    const f = extractFacts(P7_TEXT);
    expect(f.find((x) => x.value === "25")?.comparison).toBeUndefined();
    expect(f.filter((x) => x.value === "58")).toHaveLength(1);
  });
  it("reads 'N% fewer/more X compared with Y'", () => {
    expect(extractFacts("Emissions are 20% lower compared with the previous model.")[0]).toMatchObject({
      value: "20", comparison: { direction: "less", reference: "the previous model" },
    });
  });
});

describe("footnotes stay attached across pages", () => {
  it("links the superscript 18 on page 7 to endnote 18 on page 12 with its full qualification", () => {
    const c = linkedChunk();
    expect(c.footnotes).toHaveLength(1);
    expect(c.footnotes[0].marker).toBe("18");
    expect(c.footnotes[0].text).toMatch(/^Energy consumption and energy efficiency values are based on the ENERGY STAR Program Requirements for Computers, including the max energy allowance for iMac\./);
    expect(c.footnotes[0].text).toContain("143W Power Adapter");
    expect(c.footnotes[0].text).not.toContain("Trade-in");
    expect(c.footnotes[0].chunkId).toBe("p12-footnote-1");
  });
  it("creates the footnote chunk on page 12 and cross-references it both ways", () => {
    const all = linkFootnotes([base({})], collectEndnotes([{ page: 12, text: P12_RAW }]));
    const note = all.find((x) => x.sourceType === "footnote" && x.labels[0] === "18")!;
    expect(note.pageNumber).toBe(12);
    expect(note.referencedBy).toEqual(["p7-paragraph-2"]);
  });
  it("finds the glued marker in the text even when the analyser reported none", () => {
    const c = linkedChunk({ markers: [] });
    expect(c.footnotes.map((f) => f.marker)).toEqual(["18"]);
  });
  it("never links a number that no note defines", () => {
    const all = linkFootnotes([base({ markers: ["99"], text: "iMac is efficient. 99 Percent of owners agree." })], collectEndnotes([{ page: 12, text: P12_RAW }]));
    expect(all[0].footnotes).toEqual([]);
  });
});

describe("verification of the ENERGY STAR answer", () => {
  it("verifies the quote, value+unit, comparison and keeps footnote 18 with the answer", () => {
    const r = run(raw({}));
    expect(r.warnings).toEqual([]);
    expect(r.status).toBe("answered");
    expect(r.citations[0].quoteVerified).toBe(true);
    expect(r.values[0]).toMatchObject({ verified: true, page: 7 });
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]).toMatchObject({ value: "58", page: 7, chunkId: "p7-paragraph-2", comparison: { direction: "less" } });
    expect(r.claims[0].statement).toBe("58% less energy than the requirement for ENERGY STAR (p7)");
    expect(r.citations[0].supporting[0]).toBe("iMac consumes 58 percent less energy than the requirement for ENERGY STAR.");
    expect(r.footnotes).toHaveLength(1);
    expect(r.footnotes[0]).toMatchObject({ marker: "18", chunkId: "p12-footnote-1", page: 12, appliesTo: ["p7-paragraph-2"] });
    expect(r.footnotes[0].text).toContain("ENERGY STAR Program Requirements for Computers");
  });

  it("accepts a reworded but equivalent reference (\"the ENERGY STAR requirement\")", () => {
    const r = run(raw({ answer: "iMac uses 58 percent less energy than the ENERGY STAR requirement." }));
    expect(r.status).toBe("answered");
  });

  it("accepts the footnote's page number and marker in the prose (footnote 18 on page 12)", () => {
    const r = run(raw({ answer: "iMac consumes 58% less energy than the requirement for ENERGY STAR (page 7); footnote 18 on page 12 explains the basis." }));
    expect(r.warnings).toEqual([]);
    expect(r.status).toBe("answered");
  });

  it.each([
    ["opposite direction", { answer: "iMac consumes 58% more energy than the requirement for ENERGY STAR." }, /does not match the cited evidence/],
    ["a different unit", { answer: "iMac consumes 58 kWh less energy than the requirement for ENERGY STAR.", values: [] }, /no cited evidence has that value with that unit/],
    ["a different number", { answer: "iMac consumes 85% less energy than the requirement for ENERGY STAR.", values: [] }, /85/],
    ["a different reference", { answer: "iMac consumes 58% less energy than the 2020 industry average." }, /does not match the cited evidence/],
    ["a reworded quote that is not in the chunk", { evidence: [{ chunkId: "p7-paragraph-2", quote: "iMac uses 58 percent less energy than the requirement for ENERGY STAR" }] }, /does not match the chunk/],
    ["a value whose unit is not in the chunk", { values: [{ label: "x", value: "58", unit: "kWh", chunkId: "p7-paragraph-2" }] }, /unit "kWh" is not/],
  ] as [string, Partial<RawAnswer>, RegExp][])("is NOT marked verified for %s", (_n, over, warning) => {
    const r = run(raw(over));
    expect(r.status).toBe("partial");
    expect(r.warnings.join("\n")).toMatch(warning);
  });

  it("is not verified when nothing in the answer can be confirmed", () => {
    const r = run(raw({ answer: "It is very efficient.", evidence: [{ chunkId: "p7-paragraph-2", quote: "" }], values: [] }));
    expect(r.status).toBe("partial");
    expect(r.warnings.join()).toMatch(/not marked verified/);
  });

  it("drops citations to chunks that were not retrieved", () => {
    const r = run(raw({ evidence: [{ chunkId: "p99-fake-1", quote: "x y z" }], values: [] }));
    expect(r.status).toBe("insufficient_evidence");
    expect(r.citations).toEqual([]);
  });
});

describe("regressions found on the real iMac report", () => {
  it("trims trailing clauses from a comparison reference", async () => {
    const { trimReference } = await import("../src/lib/facts");
    expect(trimReference("the requirement for ENERGY STAR, as stated on page 7")).toBe("the requirement for ENERGY STAR");
    expect(trimReference("the ENERGY STAR requirement (see footnote 18)")).toBe("the ENERGY STAR requirement");
    const r = run(raw({ answer: "iMac consumes 58% less energy than the requirement for ENERGY STAR, as stated on page 7." }));
    expect(r.warnings).toEqual([]);
    expect(r.status).toBe("answered");
  });

  it("keeps a headline-sized sentence with a footnote number as content instead of dropping it as a heading", async () => {
    const { analyzeLayout } = await import("../src/lib/layout");
    const t = (str: string, x: number, y: number, h: number) => ({ str, x, y, h, w: str.length * h * 0.5 });
    const l = analyzeLayout({
      width: 612, height: 792, images: 0, paths: 0,
      items: [
        t("Use", 50, 700, 22),
        t("iMac uses 58 percent less energy than the requirement for ENERGY STAR. 18", 50, 660, 16),
        ...[0, 1, 2].map((i) => t(`We design our products to be energy efficient line ${i} of the paragraph text.`, 50, 600 - i * 13, 10)),
      ],
    });
    const el = l.analysis.elements.find((e) => e.text.includes("58 percent"))!;
    expect(el).toBeDefined();
    expect(el.text).toContain("less energy than the requirement for ENERGY STAR");
  });

  it("keeps table rows on their own lines so each fact keeps its row label", async () => {
    const { buildPageChunks } = await import("../src/lib/chunking");
    const [c] = buildPageChunks("d", 10, {
      elements: [{ type: "table", label: "Greenhouse gas emissions", labels: [], text: "Production | 50%\nTransportation | 5%\nProduct use | 45%", values: [], footnoteMarkers: [] }],
      footnotes: [],
    }, "", { origin: "layout", includeRawText: false });
    expect(c.text).toBe("Production | 50%\nTransportation | 5%\nProduct use | 45%");
    expect(c.facts.map((f) => `${f.label}=${f.value}${f.unit}`)).toEqual(["Production=50%", "Transportation=5%", "Product use=45%"]);
    expect(c.facts.every((f) => f.page === 10)).toBe(true);
  });
});

describe("footnotes on page-sized chunks", () => {
  it("attaches only the footnotes printed in the sentence that supports the answer", () => {
    const page = linkFootnotes(
      [base({ chunkId: "p7-text-1", origin: "text-layer", label: "Page 7 raw text layer", markers: [],
        text: "iMac is free of harmful substances. 5 We apply rigorous controls to materials. " + P7_TEXT + "\n" + "Padding text. ".repeat(60) })],
      collectEndnotes([{ page: 12, text: P12_RAW + "\n5   Regulated Substances Specification describes restrictions on chemicals in Apple products." }]),
    )[0];
    expect(page.footnotes.map((f) => f.marker).sort()).toEqual(["18", "5"]);
    const r = verifyAnswer("q", raw({ evidence: [{ chunkId: "p7-text-1", quote: "" }], values: [{ label: "saving", value: "58", unit: "%", chunkId: "p7-text-1" }] }),
      [{ ...page, pointId: "pt", score: 1, vectorRank: 1, lexicalRank: 1 }], meta);
    expect(r.footnotes.map((f) => f.marker)).toEqual(["18"]);
    expect(r.citations[0].footnoteChunks.map((f) => f.marker)).toEqual(["18"]);
  });
});
