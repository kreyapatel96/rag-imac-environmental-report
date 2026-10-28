import type { PageAnalysis } from "./ai";
import { extractFacts as extractClaimFacts, stripFootnoteMarkers } from "./facts";

/** Page-analyser facts carry only label/value/unit; richer claim data is attached when chunks are built. */
export function extractFacts(text: string): { label: string; value: string; unit: string }[] {
  return extractClaimFacts(text).map(({ label, value, unit }) => ({ label, value, unit }));
}

/** One run of text from the PDF text layer, in PDF units (origin bottom-left). */
export interface TextItem {
  str: string;
  x: number;
  y: number; // baseline
  w: number;
  h: number; // font height
}

export interface PageLayout {
  width: number;
  height: number;
  items: TextItem[];
  images: number; // image paint operations on the page
  paths: number; // vector path operations (charts are mostly vector paths)
}

export interface LocalAnalysis {
  analysis: PageAnalysis;
  /** Higher = more likely to hold charts / infographics that text extraction alone cannot interpret. */
  visualScore: number;
  needsVision: boolean;
  reason: string;
}

type Element = PageAnalysis["elements"][number];
type Fact = Element["values"][number];

interface Cell {
  text: string;
  x: number;
  x2: number;
  y: number;
  h: number;
  markers: string[];
}
interface Line {
  y: number;
  h: number;
  cells: Cell[];
}
interface Block {
  lines: string[];
  x: number;
  cx: number; // centre
  lastX: number;
  top: number;
  bottom: number;
  h: number;
  markers: string[];
  words: number;
}

const MARKER_ONLY = /^[\d*†‡§]{1,3}$/;
const FOOTNOTE_START = /^(\*+|†+|‡+|§+|\(\d{1,2}\)|\d{1,2}[.)]?)\s+(?=\S)/;
const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
const norm = (t: string) => t.replace(/\s+/g, " ").trim();

function groupLines(items: TextItem[], body: number): Line[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: { refY: number; h: number; items: TextItem[] }[] = [];
  for (const it of sorted) {
    const row = rows.find((r) => Math.abs(r.refY - it.y) <= 0.55 * Math.min(Math.max(r.h, it.h), 1.3 * body));
    if (row) {
      row.items.push(it);
      row.h = Math.max(row.h, it.h);
    } else rows.push({ refY: it.y, h: it.h, items: [it] });
  }
  return rows
    .sort((a, b) => b.refY - a.refY)
    .map((row) => {
      const its = row.items.sort((a, b) => a.x - b.x);
      const cells: Cell[] = [];
      let cur: Cell | null = null;
      its.forEach((it, idx) => {
        const isMarker = idx > 0 && it.h < 0.72 * body && MARKER_ONLY.test(it.str.trim());
        if (isMarker && cur) {
          cur.markers.push(it.str.trim());
          cur.x2 = Math.max(cur.x2, it.x + it.w);
          return;
        }
        const gap = cur ? it.x - cur.x2 : 0;
        if (cur && gap <= Math.max(2.5 * it.h, 14)) {
          const needSpace = gap > 0.12 * it.h && !/\s$/.test(cur.text) && !/^\s/.test(it.str);
          cur.text += (needSpace ? " " : "") + it.str;
          cur.x2 = it.x + it.w;
          cur.h = Math.max(cur.h, it.h);
        } else {
          cur = { text: it.str, x: it.x, x2: it.x + it.w, y: it.y, h: it.h, markers: [] };
          cells.push(cur);
        }
      });
      for (const c of cells) c.text = norm(c.text);
      return { y: row.refY, h: row.h, cells: cells.filter((c) => c.text || c.markers.length) };
    })
    .filter((l) => l.cells.length);
}

function findTables(lines: Line[]): { start: number; end: number }[] {
  const tabular = (l: Line) => l.cells.length >= 2 && l.cells.reduce((s, c) => s + c.text.length, 0) / l.cells.length < 40;
  const aligned = (a: Line, b: Line) => a.cells.filter((c) => b.cells.some((d) => Math.abs(c.x - d.x) < 8)).length >= 2;
  const runs: { start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; ) {
    if (!tabular(lines[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < lines.length && tabular(lines[j + 1]) && aligned(lines[j], lines[j + 1]) && lines[j].y - lines[j + 1].y < 2.6 * lines[j].h) j++;
    if (j - i + 1 >= 3) runs.push({ start: i, end: j });
    i = j + 1;
  }
  return runs;
}

function buildBlocks(lines: Line[]): Block[] {
  const blocks: Block[] = [];
  for (const line of lines) {
    for (const c of line.cells) {
      if (!c.text) continue;
      const cx = (c.x + c.x2) / 2;
      const b = blocks.find(
        (bl) =>
          bl.bottom - c.y <= 1.9 * Math.max(c.h, bl.h) &&
          bl.bottom > c.y &&
          Math.abs(c.h - bl.h) <= 0.18 * bl.h &&
          (Math.abs(c.x - bl.lastX) <= Math.max(10, 1.2 * c.h) || Math.abs(cx - bl.cx) <= 8),
      );
      if (b) {
        b.lines.push(c.text);
        b.bottom = c.y;
        b.lastX = c.x;
        b.markers.push(...c.markers);
        b.words += words(c.text);
      } else
        blocks.push({ lines: [c.text], x: c.x, cx, lastX: c.x, top: c.y, bottom: c.y, h: c.h, markers: [...c.markers], words: words(c.text) });
    }
  }
  return blocks;
}

function markersIn(text: string, explicit: string[]): string[] {
  const found = [...text.matchAll(/([*†‡§]+)(?=\s|$|[.,;:)])/g)].map((m) => m[1]);
  return [...new Set([...explicit, ...found])];
}

/**
 * Local (no API) page understanding from the PDF text layer geometry:
 * headings, paragraphs, tables, big-number callouts, footnotes, chart label groups, and numeric facts.
 */
export function analyzeLayout(layout: PageLayout): LocalAnalysis {
  const items = layout.items.filter((i) => i.str.trim() && i.h > 0);
  const analysis: PageAnalysis = { elements: [], footnotes: [] };
  const empty = (reason: string): LocalAnalysis => ({
    analysis,
    visualScore: layout.images * 5 + layout.paths / 4,
    needsVision: layout.images > 0 || layout.paths >= 30,
    reason,
  });
  if (!items.length) return empty(layout.images > 0 || layout.paths > 0 ? "no text layer, graphics only" : "blank page");

  // body font size = most common height weighted by characters
  const hist = new Map<number, number>();
  for (const i of items) {
    const k = Math.round(i.h * 2) / 2;
    hist.set(k, (hist.get(k) ?? 0) + i.str.length);
  }
  const body = [...hist.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const lines = groupLines(items, body);
  const tableRuns = findTables(lines);
  const inTable = new Set<number>();
  tableRuns.forEach((r) => {
    for (let i = r.start; i <= r.end; i++) inTable.add(i);
  });
  const flow = lines.filter((_, i) => !inTable.has(i));
  const blocks = buildBlocks(flow);
  const visual = layout.images > 0 || layout.paths >= 20;

  // ---- classify blocks ----
  let heading = "";
  const shortLabelBlocks: Block[] = [];
  const emitted: { y: number; el: Element }[] = [];
  const footnoteZone = layout.height * 0.22;
  const textOf = (b: Block) => norm(b.lines.join("\n").replace(/\n/g, " "));

  for (const b of blocks.sort((a, c) => c.top - a.top || a.x - c.x)) {
    const text = textOf(b);
    if (!text) continue;
    const nWords = b.words;
    const isFootnoteArea = b.top < footnoteZone && b.h <= 0.95 * body;

    if (isFootnoteArea || (b.h <= 0.85 * body && FOOTNOTE_START.test(b.lines[0]) && b.top < layout.height * 0.35)) {
      let cur: { marker: string; text: string } | null = null;
      for (const l of b.lines) {
        const m = l.match(FOOTNOTE_START);
        if (m) {
          cur = { marker: m[1].replace(/[().]/g, ""), text: l.slice(m[0].length) };
          analysis.footnotes.push(cur);
        } else if (cur) cur.text += " " + l;
        else {
          cur = { marker: "", text: l };
          analysis.footnotes.push(cur);
        }
      }
      continue;
    }

    const big = b.h >= 1.5 * body;
    const hasNumber = /\d/.test(text);
    // a headline-sized *sentence* ("iMac uses 58 percent less energy than … ENERGY STAR. 18") is content, not a heading
    const sentenceLike = /[.!?]\s*$/.test(stripFootnoteMarkers(text).text) || (hasNumber && /%|percent/i.test(text));
    if (nWords <= 14 && !sentenceLike && b.h >= 1.2 * body && !(big && hasNumber)) {
      heading = text;
      continue;
    }
    if (visual && nWords <= 5 && (hasNumber || nWords <= 3) && !big) {
      shortLabelBlocks.push(b);
      continue;
    }
    const label = heading || text.split(" ").slice(0, 8).join(" ");
    if (big && hasNumber && nWords <= 14) {
      // big-number callout: attach the nearest short caption below/above
      const cap = blocks
        .filter((o) => o !== b && o.words <= 25 && o.h < b.h && o.top < b.bottom && b.bottom - o.top <= 3.2 * b.h && Math.abs(o.cx - b.cx) <= 140 && !(o.top < footnoteZone))
        .sort((x, y) => b.bottom - x.top - (b.bottom - y.top))[0];
      const full = cap ? `${text} — ${textOf(cap)}` : text;
      emitted.push({ y: b.top, el: { type: "callout", label, labels: [heading, text].filter(Boolean), text: full, values: extractFacts(full), footnoteMarkers: markersIn(full, b.markers) } });
      continue;
    }
    const numericShort = nWords <= 25 && extractFacts(text).some((f) => f.unit || f.value.length > 1);
    const type: Element["type"] = visual && numericShort ? "chart" : numericShort && b.h >= 1.2 * body ? "callout" : "paragraph";
    emitted.push({
      y: b.top,
      el: { type, label, labels: heading ? [heading] : [], text, values: type === "paragraph" ? extractFacts(text) : extractFacts(text), footnoteMarkers: markersIn(text, b.markers) },
    });
  }

  // ---- chart label group (graphic text whose association with shapes cannot be read locally) ----
  if (shortLabelBlocks.length >= 4) {
    const ordered = shortLabelBlocks.sort((a, c) => c.top - a.top || a.x - c.x);
    const text = ordered.map(textOf).join("; ");
    emitted.push({
      y: ordered[0].top,
      el: {
        type: "chart",
        label: heading ? `${heading} (graphic labels)` : "Graphic labels",
        labels: ordered.map(textOf),
        text: `Text labels found inside a chart/graphic (association with bars/segments not verified): ${text}`,
        values: extractFacts(text),
        footnoteMarkers: markersIn(text, ordered.flatMap((o) => o.markers)),
      },
    });
  } else {
    for (const b of shortLabelBlocks) {
      const text = textOf(b);
      emitted.push({ y: b.top, el: { type: "paragraph", label: heading || text, labels: [], text, values: extractFacts(text), footnoteMarkers: markersIn(text, b.markers) } });
    }
  }

  // ---- tables ----
  for (const run of tableRuns) {
    const rows = lines.slice(run.start, run.end + 1).map((l) => l.cells.map((c) => c.text));
    const header = rows[0];
    const values: Fact[] = [];
    for (const row of rows.slice(1))
      row.slice(1).forEach((cell, i) => {
        for (const f of extractFacts(cell)) values.push({ label: `${row[0]} / ${header[i + 1] ?? ""}`.trim(), value: f.value, unit: f.unit });
      });
    const text = rows.map((r) => r.join(" | ")).join("\n");
    emitted.push({
      y: lines[run.start].y,
      el: { type: "table", label: heading || header.join(" | "), labels: header, text, values, footnoteMarkers: markersIn(text, lines.slice(run.start, run.end + 1).flatMap((l) => l.cells.flatMap((c) => c.markers))) },
    });
  }

  analysis.elements = emitted.sort((a, b) => b.y - a.y).map((e) => e.el);
  if (!analysis.elements.length && heading)
    analysis.elements.push({ type: "paragraph", label: heading, labels: [], text: heading, values: [], footnoteMarkers: [] });

  const numericBlocks = analysis.elements.filter((e) => e.values.length).length;
  const visualScore = layout.images * 5 + layout.paths / 4 + shortLabelBlocks.length * 2 + numericBlocks;
  const needsVision = layout.images > 0 || layout.paths >= 30 || shortLabelBlocks.length >= 4;
  return {
    analysis,
    visualScore,
    needsVision,
    reason: needsVision ? `graphics detected (${layout.images} images, ${layout.paths} vector paths, ${shortLabelBlocks.length} graphic labels)` : "text-only page",
  };
}
