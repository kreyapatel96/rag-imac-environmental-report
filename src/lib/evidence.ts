import { normalizeUnit, splitSentences, stripFootnoteMarkers } from "./facts";
import type { ChunkPayload } from "./types";

/**
 * Words of a text, normalised so that harmless typography does not matter:
 * whitespace/line breaks, case, curly quotes, dash variants, ligatures, "%" vs "percent", thousands separators,
 * and footnote numbers glued to sentence ends ("STAR. 18", "STAR.18").
 * Wording differences ("uses" vs "consumes"), different numbers and reordering are NOT normalised away.
 */
export function matchTokens(text: string): string[] {
  const t = stripFootnoteMarkers(text)
    .text.normalize("NFKC")
    .replace(/­/g, "")
    .toLowerCase()
    .replace(/%/g, " percent ")
    .replace(/\bper\s+cent\b/g, "percent")
    .replace(/\bpercentage\b/g, "percent");
  return (t.match(/[\p{L}\p{N}]+(?:[.,][\p{N}]+)*/gu) ?? []).map((x) => x.replace(/,/g, ""));
}

function indexOfRun(hay: string[], needle: string[], from: number): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * True only if every word of the quote appears, in order and contiguously, in the chunk text
 * (after the normalisation above). "…" in a quote separates fragments that must each match, in order.
 * A trailing footnote number the model copied (e.g. "STAR 18") is tolerated only if the chunk really has that footnote.
 */
export function quoteSupported(quote: string, chunk: Pick<ChunkPayload, "text" | "footnotes">): boolean {
  const hay = matchTokens(chunk.text);
  const markers = new Set(chunk.footnotes.map((f) => f.marker));
  const fragments = quote.split(/\s*(?:…|\.{3,})\s*/).map(matchTokens).filter((f) => f.length > 0);
  if (!fragments.length || fragments.reduce((n, f) => n + f.length, 0) < 2) return false;
  let pos = 0;
  for (const frag of fragments) {
    let at = indexOfRun(hay, frag, pos);
    if (at < 0 && markers.has(frag[frag.length - 1]) && frag.length > 1) {
      const without = frag.slice(0, -1);
      at = indexOfRun(hay, without, pos);
      if (at >= 0) pos = at + without.length;
      else return false;
    } else if (at < 0) return false;
    else pos = at + frag.length;
  }
  return true;
}

/** true if the unit (or a synonym, e.g. "%" ↔ "percent") is printed in the chunk. Empty unit always passes. */
export function unitInChunk(unit: string, chunk: Pick<ChunkPayload, "text" | "facts" | "labels">): boolean {
  const u = normalizeUnit(unit);
  if (!u) return true;
  if (u === "%") return /%|percent|per cent/i.test(chunk.text) || chunk.facts.some((f) => normalizeUnit(f.unit) === "%");
  const squash = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  return squash(chunk.text).includes(u) || chunk.facts.some((f) => normalizeUnit(f.unit) === u);
}

/** Sentences of the chunk (footnote numbers removed) that contain one of the given printed values. */
export function supportingSentences(text: string, values: string[]): string[] {
  const clean = stripFootnoteMarkers(text).text;
  const vs = values.map((v) => v.replace(/,/g, "")).filter(Boolean);
  if (!vs.length) return [];
  return clean
    .split(/\n/)
    .flatMap(splitSentences)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => {
      const flat = s.replace(/,/g, "");
      return vs.some((v) => new RegExp(`(?<![\\d.])${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\d]|\\.\\d)`).test(flat));
    })
    .slice(0, 3);
}

/**
 * Footnote markers that belong to the sentences supporting an answer. For a page-sized chunk only the markers printed
 * inside those sentences count (not every footnote on the page); small element chunks keep all of theirs.
 */
export function markersForSupport(chunk: Pick<ChunkPayload, "text" | "origin" | "footnotes" | "markers">, supporting: string[]): string[] {
  const small = chunk.origin !== "text-layer" && chunk.text.length <= 700;
  if (small) return chunk.footnotes.map((f) => f.marker);
  if (!supporting.length) return [];
  const want = new Set(supporting.map((t) => t.replace(/\s+/g, " ")));
  const found = new Set<string>();
  for (const line of chunk.text.split("\n"))
    for (const sentence of splitSentences(line)) {
      const stripped = stripFootnoteMarkers(sentence);
      if (want.has(stripped.text.replace(/\s+/g, " ").trim())) stripped.markers.forEach((m) => found.add(m));
    }
  return chunk.footnotes.map((f) => f.marker).filter((m) => found.has(m));
}
