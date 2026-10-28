import type { FactValue } from "./types";

/* ---------- units ---------- */

/** "percent", "per cent", "%" → "%"; everything else lower-cased without spaces. */
export function normalizeUnit(u: string): string {
  const s = u.toLowerCase().replace(/\s+/g, "");
  return ["%", "percent", "percentage", "percentages", "pct", "percent."].includes(s) ? "%" : s;
}

export function sameNumber(a: string, b: string): boolean {
  const x = parseFloat(a.replace(/,/g, ""));
  const y = parseFloat(b.replace(/,/g, ""));
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
}

export const sameUnit = (a: string, b: string) => normalizeUnit(a) === normalizeUnit(b);

/* ---------- footnote markers glued to the end of sentences ("ENERGY STAR. 18 We design…") ---------- */

const TRAILING_MARKER = /([.!?;:,)”"’'])\s{0,2}(\d{1,2})(?=\s+[A-Z“"(]|\s*$)/g;

/**
 * Removes superscript-style footnote numbers that follow sentence punctuation and returns them.
 * Only used for matching/claim extraction – callers must confirm a marker really exists before linking it.
 */
export function stripFootnoteMarkers(text: string): { text: string; markers: string[] } {
  const markers: string[] = [];
  const out = text.replace(TRAILING_MARKER, (_m, punct: string, num: string) => {
    markers.push(num);
    return punct;
  });
  return { text: out, markers };
}

/* ---------- fact + claim extraction ---------- */

const UNIT =
  "%|percentage|percent|per cent|kWh|MWh|GWh|GJ|MJ|kW|W|kg\\s?CO2e?|t\\s?CO2e?|kg|g|lbs?|tons?|years?|hours?|hrs?|mm|cm|inches|liters?";
const NUM_UNIT = new RegExp(`(?<![\\w.])(\\d{1,3}(?:,\\d{3})+|\\d+)(\\.\\d+)?\\s*(${UNIT})?(?![\\w])`, "gi");

const COMPARISON =
  /(\d[\d,]*(?:\.\d+)?)\s*(%|percentage|percent|per cent)\s+(less|lower|fewer|smaller|reduced|reduction|more|greater|higher|larger|increased)(?:\s+([a-z][a-z-]*(?:\s[a-z][a-z-]*){0,3}?))?\s+(?:than|compared (?:with|to)|versus|vs\.?|relative to)\s+(.{3,120}?)(?=[.;!?]|$)/i;

const VERBS = new Set(
  "is are was were has have uses use consumes consume emits produces contains contain achieves reduces saves requires meets exceeds delivers generates".split(" "),
);
const LESS = new Set(["less", "lower", "fewer", "smaller", "reduced", "reduction"]);

export const directionOf = (word: string): "less" | "more" => (LESS.has(word.toLowerCase()) ? "less" : "more");

/** "the requirement for ENERGY STAR, as stated on page 7" → "the requirement for ENERGY STAR" */
export function trimReference(ref: string): string {
  return ref.split(/[,(—–]|\s-\s|\s(?:as|according|per|based|which|where|and)\s/i)[0].replace(/\s+/g, " ").trim();
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

const ABBREV = /(?:\be\.g|\bi\.e|\bvs|\betc|\binc|\bapprox|\bno|\bfig|\bdr|\bmr|\bms|\bst)\.$/i;

/** Splits prose into sentences; brand names like "iMac" may start a sentence in lower case. */
export function splitSentences(text: string): string[] {
  const parts: string[] = [];
  for (const piece of text.split(/(?<=[.!?])\s+(?=[\p{L}“"(])/u)) {
    if (parts.length && ABBREV.test(parts[parts.length - 1])) parts[parts.length - 1] += " " + piece;
    else parts.push(piece);
  }
  return parts;
}

function sentences(text: string): string[] {
  return text.split(/\n|;/).flatMap(splitSentences).map(clean).filter(Boolean);
}

/**
 * Structured facts with the full claim: "iMac consumes 58 percent less energy than the requirement for ENERGY STAR"
 * → { value "58", unit "%", label "energy", subject "iMac", comparison {less, "the requirement for ENERGY STAR"}, claim }.
 */
export function extractFacts(text: string): FactValue[] {
  const out: FactValue[] = [];
  const stripped = stripFootnoteMarkers(text).text;
  // "Label | 50%" rows: the row label (first cell) names every number in the row; the whole row is the claim
  const rowLines = stripped.split("\n").filter((l) => /\s\|\s/.test(l));
  for (const line of rowLines) {
    const cells = line.split(/\s\|\s/).map(clean);
    for (let i = 0; i < cells.length; i++)
      for (const m of cells[i].matchAll(NUM_UNIT)) {
        const value = m[1] + (m[2] ?? "");
        const unit = (m[3] ?? "").replace(/\s+/g, " ");
        const own = cells[i].slice(0, m.index).replace(/[:(\-–—•]+\s*$/, "").trim();
        out.push({ label: own || (i > 0 ? cells[0].replace(/^[•\-–]\s*/, "") : ""), value, unit, claim: clean(line) });
      }
  }
  const rest = stripped.split("\n").filter((l) => !/\s\|\s/.test(l)).join("\n");
  for (const sentence of sentences(rest)) {
    const claim = sentence.length > 260 ? sentence.slice(0, 257) + "…" : sentence;
    const cmp = sentence.match(COMPARISON);
    let used: string | null = null;
    if (cmp) {
      const before = sentence.slice(0, cmp.index).trim().split(/\s+/);
      if (before.length && VERBS.has(before[before.length - 1].toLowerCase())) before.pop();
      out.push({
        label: clean(cmp[4] ?? "") || clean(before.slice(-4).join(" ")),
        value: cmp[1],
        unit: "%",
        claim,
        subject: before.slice(-4).join(" ") || undefined,
        comparison: { direction: directionOf(cmp[3]), reference: trimReference(cmp[5]) },
      });
      used = cmp[1];
    }
    for (const m of sentence.matchAll(NUM_UNIT)) {
      const value = m[1] + (m[2] ?? "");
      const unit = (m[3] ?? "").replace(/\s+/g, " ");
      if (used === value && normalizeUnit(unit) === "%" && cmp) continue; // already captured with its comparison
      if (!unit && value.length === 4 && /^(19|20)\d\d$/.test(value)) continue; // a year, not a measurement
      const idx = m.index ?? 0;
      const before = sentence.slice(0, idx).replace(/[:|(\-–—]+\s*$/, "").trim().split(/\s+/).slice(-7).join(" ");
      const after = sentence.slice(idx + m[0].length).trim().split(/\s+/).slice(0, 7).join(" ");
      out.push({ label: before || after, value, unit, claim });
    }
  }
  return out;
}

/**
 * Merges facts reported by the page analyser with locally extracted claims: the analyser's (often more specific,
 * e.g. table "Row / Column") label is kept, and the claim / comparison / subject are attached; extra local facts are appended.
 */
export function enrichFacts(givenRaw: FactValue[], text: string, page: number): FactValue[] {
  // analysers sometimes print the unit inside the value ("30%"): split it so values compare by number + unit
  const given = givenRaw.map((f) => {
    const m = f.value.trim().match(/^(\d[\d,]*(?:\.\d+)?)\s*(%|percent|percentage)$/i);
    return m && !f.unit ? { ...f, value: m[1], unit: m[2] === "%" ? "%" : m[2] } : f;
  });
  const rich = extractFacts(text);
  const used = new Set<FactValue>();
  const merged: FactValue[] = given.map((f) => {
    const m = rich.find((r) => !used.has(r) && sameNumber(r.value, f.value) && sameUnit(r.unit, f.unit));
    if (m) used.add(m);
    return { ...m, ...f, label: f.label || m?.label || "", claim: m?.claim ?? f.claim, page };
  });
  for (const r of rich) if (!used.has(r) && !merged.some((f) => sameNumber(f.value, r.value) && sameUnit(f.unit, r.unit) && f.claim === r.claim)) merged.push({ ...r, page });
  return merged;
}

export function describeFact(f: FactValue): string {
  const v = `${f.value}${f.unit ? (normalizeUnit(f.unit) === "%" ? "%" : " " + f.unit) : ""}`;
  if (f.comparison)
    return `${v} ${f.comparison.direction}${f.label ? " " + f.label : ""} than ${f.comparison.reference}${f.page ? ` (p${f.page})` : ""}`;
  return `${f.label ? f.label + ": " : ""}${v}${f.page ? ` (p${f.page})` : ""}`;
}
