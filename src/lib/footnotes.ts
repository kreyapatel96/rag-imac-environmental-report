import { stripFootnoteMarkers } from "./facts";
import type { ChunkPayload } from "./types";

export interface EndnoteDef {
  marker: string;
  text: string;
  page: number;
}

const DEF_LINE = /^(\d{1,2})\s{2,}(?=[A-Z“"(])(.*)$/;

/**
 * Numbered notes printed as "18   Energy consumption …" (typically on an Endnotes page), taken from the raw text layer.
 * A note continues until the next numbered note or a bullet-less break; markers stay unconfirmed until a chunk cites them.
 */
export function collectEndnotes(pages: { page: number; text: string }[]): EndnoteDef[] {
  const defs: EndnoteDef[] = [];
  for (const { page, text } of pages) {
    let cur: EndnoteDef | null = null;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      const m = line.match(DEF_LINE);
      if (m) {
        cur = { marker: m[1], text: m[2].replace(/\s+/g, " ").trim(), page };
        defs.push(cur);
      } else if (cur && line && !/^[A-Z][A-Za-z ]{2,40}$/.test(line)) {
        cur.text += " " + line.replace(/\s+/g, " ");
      } else cur = null;
    }
  }
  return defs.map((d) => ({ ...d, text: d.text.replace(/\s+/g, " ").trim() }));
}

/** Footnote numbers a chunk points to: explicit superscripts plus numbers glued to sentence ends. */
export function markersOf(chunk: ChunkPayload): string[] {
  return [...new Set([...(chunk.markers ?? []), ...chunk.footnotes.map((f) => f.marker), ...stripFootnoteMarkers(chunk.text).markers])];
}

/**
 * Links every chunk to its footnotes, across pages. A numeric marker is only linked when the document actually defines
 * that note (an existing footnote chunk or an endnote definition) – never guessed. Missing footnote chunks are created
 * on the page where the note is printed, and cross-referenced both ways.
 */
export function linkFootnotes(
  chunks: ChunkPayload[],
  endnotes: EndnoteDef[],
): ChunkPayload[] {
  const out = [...chunks];
  const nextId = new Map<number, number>();
  for (const c of out) {
    const m = c.chunkId.match(/^p(\d+)-footnote-(\d+)$/);
    if (m) nextId.set(+m[1], Math.max(nextId.get(+m[1]) ?? 0, +m[2]));
  }
  const key = (s: string) => s.replace(/[().\s]/g, "").toLowerCase();

  const footnoteChunk = (marker: string, page: number | null): ChunkPayload | undefined =>
    out.find((c) => c.sourceType === "footnote" && key(c.labels[0] ?? "") === key(marker) && (page === null || c.pageNumber === page)) ??
    out.find((c) => c.sourceType === "footnote" && key(c.text.match(/^\[?([^\]\s]+)\]?/)?.[1] ?? "") === key(marker) && (page === null || c.pageNumber === page));

  const ensureFromEndnote = (def: EndnoteDef): ChunkPayload => {
    const existing = footnoteChunk(def.marker, def.page);
    if (existing) return existing;
    const n = (nextId.get(def.page) ?? 0) + 1;
    nextId.set(def.page, n);
    const chunk: ChunkPayload = {
      docId: out[0].docId,
      chunkId: `p${def.page}-footnote-${n}`,
      pageNumber: def.page,
      sourceType: "footnote",
      origin: "layout",
      label: `Footnote ${def.marker}`,
      labels: [def.marker],
      text: `[${def.marker}] ${def.text}`,
      facts: [],
      footnotes: [],
      referencedBy: [],
    };
    out.push(chunk);
    return chunk;
  };

  for (const c of [...out]) {
    if (c.sourceType === "footnote") continue;
    for (const marker of markersOf(c)) {
      if (c.footnotes.some((f) => key(f.marker) === key(marker))) continue;
      // same page first, then anywhere in the document
      const sameTarget = footnoteChunk(marker, c.pageNumber);
      const def = sameTarget ? null : endnotes.find((d) => key(d.marker) === key(marker));
      if (!sameTarget && !def) continue; // not a defined footnote → ignore (e.g. a stray number)
      const target = sameTarget ?? ensureFromEndnote(def!);
      c.footnotes.push({ marker, text: target.text.replace(/^\[[^\]]*\]\s*/, ""), chunkId: target.chunkId });
      if (!target.referencedBy.includes(c.chunkId)) target.referencedBy.push(c.chunkId);
    }
  }
  return out;
}
