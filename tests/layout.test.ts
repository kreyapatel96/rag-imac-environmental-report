import { describe, expect, it } from "vitest";
import { analyzeLayout, extractFacts, type PageLayout, type TextItem } from "../src/lib/layout";

const it_ = (str: string, x: number, y: number, h = 10): TextItem => ({ str, x, y, h, w: str.length * h * 0.5 });
const page = (items: TextItem[], extra: Partial<PageLayout> = {}): PageLayout => ({ width: 612, height: 792, items, images: 0, paths: 0, ...extra });

describe("extractFacts", () => {
  it("pairs numbers with units and the preceding label", () => {
    expect(extractFacts("Total carbon footprint: 270 kg CO2e")).toEqual([{ label: "Total carbon footprint", value: "270", unit: "kg CO2e" }]);
    expect(extractFacts("Production 82%; Use 14%")).toEqual([
      { label: "Production", value: "82", unit: "%" },
      { label: "Use", value: "14", unit: "%" },
    ]);
    expect(extractFacts("Uses 58 percent less energy")[0]).toMatchObject({ value: "58", unit: "percent" });
  });
  it("keeps decimals and thousands separators exactly and ignores bare years", () => {
    const f = extractFacts("Energy 7.4 kWh in 2024, mass 1,250 g");
    expect(f.map((x) => x.value)).toEqual(["7.4", "1,250"]);
    expect(f[0].unit).toBe("kWh");
  });
});

describe("analyzeLayout", () => {
  it("builds paragraphs under a heading and pulls footnotes from the page bottom", () => {
    const l = analyzeLayout(
      page([
        it_("Energy efficiency", 50, 700, 18),
        it_("iMac meets the ENERGY STAR requirement and uses", 50, 670),
        it_("less energy than required by the standard.", 50, 658),
        it_("* Based on typical energy consumption.", 50, 60, 7),
        it_("1 Measured with the ENERGY STAR test method.", 50, 50, 7),
      ]),
    );
    const para = l.analysis.elements.find((e) => e.type === "paragraph")!;
    expect(para.label).toBe("Energy efficiency");
    expect(para.text).toContain("less energy than required");
    expect(l.analysis.footnotes).toEqual([
      { marker: "*", text: "Based on typical energy consumption." },
      { marker: "1", text: "Measured with the ENERGY STAR test method." },
    ]);
    expect(l.needsVision).toBe(false);
  });

  it("detects tables and keeps cell values with row/column labels", () => {
    const rows = [["Component", "Recycled", "Mass"], ["Stand", "100%", "1,250 g"], ["Enclosure", "30%", "800 g"]];
    const items = rows.flatMap((r, i) => r.map((c, j) => it_(c, 50 + j * 150, 600 - i * 14)));
    const t = analyzeLayout(page(items)).analysis.elements.find((e) => e.type === "table")!;
    expect(t.text).toBe("Component | Recycled | Mass\nStand | 100% | 1,250 g\nEnclosure | 30% | 800 g");
    expect(t.values).toContainEqual({ label: "Stand / Recycled", value: "100", unit: "%" });
    expect(t.values).toContainEqual({ label: "Enclosure / Mass", value: "800", unit: "g" });
  });

  it("turns big-number callouts into callout chunks with their caption", () => {
    const l = analyzeLayout(
      page([
        it_("Body text paragraph line one of the report.", 50, 400),
        it_("Body text paragraph line two of the report.", 50, 388),
        it_("55%", 50, 600, 40),
        it_("of the carbon footprint comes from use", 50, 580),
      ]),
    );
    const c = l.analysis.elements.find((e) => e.type === "callout")!;
    expect(c.text).toBe("55% — of the carbon footprint comes from use");
    expect(c.values[0]).toMatchObject({ value: "55", unit: "%" });
  });

  it("marks graphic-heavy pages for vision and groups chart labels", () => {
    const labels = ["Production", "82%", "Use", "14%", "Transport", "4%"];
    const l = analyzeLayout(page(labels.map((t, i) => it_(t, 80 + i * 70, 500)), { paths: 80 }));
    expect(l.needsVision).toBe(true);
    const chart = l.analysis.elements.find((e) => e.type === "chart")!;
    expect(chart.text).toMatch(/association .* not verified/);
    expect(chart.values.map((v) => v.value)).toEqual(["82", "14", "4"]);
  });

  it("flags image-only pages for vision and reports blank pages", () => {
    expect(analyzeLayout(page([], { images: 2 })).needsVision).toBe(true);
    const blank = analyzeLayout(page([]));
    expect(blank.needsVision).toBe(false);
    expect(blank.analysis.elements).toEqual([]);
  });

  it("links superscript footnote markers to the element", () => {
    const l = analyzeLayout(page([it_("Energy use 120 kWh", 50, 500), it_("1", 150, 504, 6), it_("Typical annual consumption.", 50, 400)]));
    const e = l.analysis.elements.find((x) => x.text.includes("120"))!;
    expect(e.footnoteMarkers).toContain("1");
    expect(e.text).not.toContain("120 kWh1");
  });
});
