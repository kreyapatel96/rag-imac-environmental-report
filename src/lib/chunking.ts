import crypto from "node:crypto";
import type { PageAnalysis } from "./ai";
import { describeFact, enrichFacts } from "./facts";
import type { ChunkPayload, FactValue, FootnoteRef, SourceType } from "./types";

const norm = (s: string) => s.trim().replace(/\s+/g, " ");
/** Like norm, but keeps line breaks (table rows, list items) so facts stay row-aligned. */
const normLines = (s: string) => s.split("\n").map(norm).filter(Boolean).join("\n");
const markerKey = (m: string) => m.trim().replace(/[().\s]/g, "").toLowerCase();

/** Qdrant point ids must be UUIDs; derive a stable one from doc + chunk id. */
export function pointIdFor(docId: string, chunkId: string): string {
  const h = crypto.createHash("sha1").update(`${docId}:${chunkId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Text that is embedded: includes the structured facts and footnotes so queries match them. */
export function embeddingText(c: ChunkPayload): string {
  const parts = [`Page ${c.pageNumber} ${c.sourceType}: ${c.label}`, c.text];
  if (c.labels.length) parts.push(`Labels: ${c.labels.join("; ")}`);
  if (c.facts.length) parts.push(`Facts: ${c.facts.map(describeFact).join("; ")}`);
  if (c.footnotes.length) parts.push(`Footnotes: ${c.footnotes.map((f) => `[${f.marker}] ${f.text}`).join(" ")}`);
  return parts.filter(Boolean).join("\n");
}

/**
 * Turns one analysed page (+ its raw text layer) into chunks.
 * - one chunk per visual element (chart/table/paragraph/callout)
 * - one chunk per footnote, cross-linked to the elements that cite it (same page only)
 * - one verbatim text-layer chunk per page as a ground-truth fallback
 */
export function buildPageChunks(
  docId: string,
  pageNumber: number,
  analysis: PageAnalysis,
  textLayer: string,
  opts: { origin?: "vision" | "layout"; includeRawText?: boolean } = {},
): ChunkPayload[] {
  const origin = opts.origin ?? "vision";
  const chunks: ChunkPayload[] = [];
  const counters: Record<string, number> = {};
  const nextId = (type: string) => {
    counters[type] = (counters[type] ?? 0) + 1;
    return `p${pageNumber}-${type}-${counters[type]}`;
  };

  const footnoteChunks = new Map<string, ChunkPayload>();
  for (const fn of analysis.footnotes) {
    if (!norm(fn.text)) continue;
    const key = markerKey(fn.marker);
    if (footnoteChunks.has(key)) continue;
    const chunk: ChunkPayload = {
      docId,
      chunkId: nextId("footnote"),
      pageNumber,
      sourceType: "footnote",
      origin,
      label: `Footnote ${fn.marker}`,
      labels: [fn.marker],
      text: `[${fn.marker}] ${norm(fn.text)}`,
      facts: [],
      footnotes: [],
      referencedBy: [],
    };
    footnoteChunks.set(key, chunk);
  }

  for (const el of analysis.elements) {
    const text = normLines(el.text);
    if (!text && !el.values.length) continue;
    const type: SourceType = el.type;
    if (type === "footnote") {
      // Model put a footnote in elements instead of footnotes[]; keep it as a footnote chunk.
      chunks.push({
        docId,
        chunkId: nextId("footnote"),
        pageNumber,
        sourceType: "footnote",
        origin,
        label: norm(el.label) || "Footnote",
        labels: el.labels.map(norm).filter(Boolean),
        text,
        facts: [],
        footnotes: [],
        referencedBy: [],
      });
      continue;
    }
    const chunkId = nextId(type);
    const footnotes: FootnoteRef[] = [];
    for (const m of el.footnoteMarkers) {
      const fc = footnoteChunks.get(markerKey(m));
      if (!fc) continue;
      footnotes.push({ marker: m, text: fc.text.replace(/^\[[^\]]*\]\s*/, ""), chunkId: fc.chunkId });
      fc.referencedBy.push(chunkId);
    }
    const facts: FactValue[] = el.values
      .map((v) => ({ label: norm(v.label), value: norm(v.value), unit: norm(v.unit) }))
      .filter((v) => v.value);
    const body = text || facts.map((f) => `${f.label}: ${f.value} ${f.unit}`.trim()).join("; ");
    chunks.push({
      docId,
      chunkId,
      pageNumber,
      sourceType: type,
      origin,
      label: norm(el.label) || `${type} on page ${pageNumber}`,
      labels: el.labels.map(norm).filter(Boolean),
      text: body,
      facts: enrichFacts(facts, body, pageNumber),
      footnotes,
      referencedBy: [],
      markers: el.footnoteMarkers.map((m) => m.trim()).filter(Boolean),
    });
  }

  chunks.push(...footnoteChunks.values());

  if (norm(textLayer) && (opts.includeRawText ?? true)) {
    chunks.push({
      docId,
      chunkId: nextId("text"),
      pageNumber,
      sourceType: "paragraph",
      origin: "text-layer",
      label: `Page ${pageNumber} raw text layer`,
      labels: [],
      text: textLayer.trim(),
      facts: [], // facts live on the element chunks; the raw text is only a verbatim fallback
      footnotes: [],
      referencedBy: [],
    });
  }
  return chunks;
}
