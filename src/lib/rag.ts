import type { AiClient, RawAnswer } from "./ai";
import { runCalculation } from "./calc";
import { AppError } from "./errors";
import type { LocalStorage } from "./storage";
import { markersForSupport, matchTokens, quoteSupported, supportingSentences, unitInChunk } from "./evidence";
import { describeFact, extractFacts, normalizeUnit, sameNumber, sameUnit } from "./facts";
import type {
  AnswerFootnote,
  AnswerResult,
  CalculationResult,
  ChunkPayload,
  Citation,
  RetrievedChunk,
  SupportedClaim,
  VerifiedValue,
} from "./types";
import type { VectorStore } from "./vectorstore";

export interface RagDeps {
  store: VectorStore;
  ai: AiClient;
  storage: LocalStorage;
}

const TOP_K = 10;
const STOP = new Set(
  "the a an of to in on for and or is are was be it its how what which does do with from by as at this that than much many more less compare compared".split(" "),
);

export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9.%-]*/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
}

/** Small BM25-style lexical ranker over the document's chunks (catches exact terms embeddings blur). */
export function lexicalRank(
  query: string,
  docs: { id: string; payload: ChunkPayload }[],
  limit: number,
): { id: string; score: number }[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !docs.length) return [];
  const toks = docs.map((d) =>
    tokenize([d.payload.label, d.payload.labels.join(" "), d.payload.text, d.payload.facts.map((f) => `${f.label} ${f.value} ${f.unit} ${f.claim ?? ""}`).join(" "), d.payload.footnotes.map((f) => f.text).join(" ")].join(" ")),
  );
  const avg = toks.reduce((s, t) => s + t.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const t of q) df.set(t, toks.filter((tt) => tt.includes(t)).length);
  const k1 = 1.4;
  const b = 0.75;
  return docs
    .map((d, i) => {
      let score = 0;
      for (const t of q) {
        const tf = toks[i].filter((x) => x === t).length;
        if (!tf) continue;
        const idf = Math.log(1 + (docs.length - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
        score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * toks[i].length) / avg));
      }
      return { id: d.id, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, limit);
}

/** Reciprocal-rank fusion of the vector and lexical rankings. */
export async function retrieve(
  { store, ai }: Pick<RagDeps, "store" | "ai">,
  docId: string,
  question: string,
): Promise<RetrievedChunk[]> {
  const [[qv], all] = await Promise.all([ai.embed([question], "query"), store.listDoc(docId)]);
  const vec = await store.search(qv, docId, TOP_K);
  const lex = lexicalRank(question, all, TOP_K);

  const byId = new Map<string, ChunkPayload>();
  for (const a of all) byId.set(a.id, a.payload);
  for (const v of vec) byId.set(v.id, v.payload);

  const fused = new Map<string, RetrievedChunk>();
  const add = (id: string, rank: number, kind: "vectorRank" | "lexicalRank") => {
    const payload = byId.get(id);
    if (!payload || payload.docId !== docId) return; // hard guard: never surface another document
    const cur =
      fused.get(id) ??
      ({ ...payload, pointId: id, score: 0, vectorRank: null, lexicalRank: null } as RetrievedChunk);
    cur.score += 1 / (60 + rank);
    cur[kind] = rank + 1;
    fused.set(id, cur);
  };
  vec.forEach((v, i) => add(v.id, i, "vectorRank"));
  lex.forEach((l, i) => add(l.id, i, "lexicalRank"));
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, TOP_K);
}

/* ---------------- verification ---------------- */

const digits = (s: string) => s.replace(/,/g, "");

/** true if the printed number appears in the chunk text, facts or footnotes (number-boundary aware). */
export function valueAppearsIn(value: string, chunk: ChunkPayload): boolean {
  const hay = digits(
    [chunk.text, chunk.labels.join(" "), chunk.facts.map((f) => `${f.value} ${f.unit}`).join(" "), chunk.footnotes.map((f) => f.text).join(" ")].join(" \n "),
  );
  const needle = digits(value).trim();
  if (!needle) return false;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\d.])${esc}(?![\\d]|\\.\\d)`, "i").test(hay);
}

function numbersIn(text: string): string[] {
  return (digits(text).match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(parseFloat(n)));
}

const FILLER = new Set(["the", "a", "an", "of", "for", "to", "than", "by", "in", "on", "and"]);
const contentTokens = (s: string) => matchTokens(s).filter((t) => !FILLER.has(t));

const footnoteView = (c: RetrievedChunk) => c.footnotes.map((f) => ({ marker: f.marker, text: f.text, chunkId: f.chunkId }));

export function verifyAnswer(
  question: string,
  raw: RawAnswer,
  retrieved: RetrievedChunk[],
  meta: { docId: string; filename: string },
): AnswerResult {
  const byChunk = new Map(retrieved.map((c) => [c.chunkId, c]));
  const warnings: string[] = [];
  const citations = new Map<string, Citation>();
  const cite = (chunk: RetrievedChunk): Citation => {
    let c = citations.get(chunk.chunkId);
    if (!c) {
      c = { chunk, quote: null, quoteVerified: false, supporting: [], footnoteChunks: footnoteView(chunk) };
      citations.set(chunk.chunkId, c);
    }
    return c;
  };
  const verifiedByChunk = new Map<string, string[]>();
  const noteVerified = (chunkId: string, value: string) => verifiedByChunk.set(chunkId, [...(verifiedByChunk.get(chunkId) ?? []), value]);

  // --- citations: only real, retrieved chunks; a quote counts only if every word is in the chunk, in order ---
  for (const ev of raw.evidence) {
    const chunk = byChunk.get(ev.chunkId);
    if (!chunk) {
      warnings.push(`Discarded citation "${ev.chunkId}" – it is not one of the retrieved chunks.`);
      continue;
    }
    const c = cite(chunk);
    const quote = ev.quote.trim();
    if (!quote) continue;
    const ok = quoteSupported(quote, chunk);
    if (!ok) warnings.push(`The quoted text for ${chunk.chunkId} does not match the chunk: “${quote.slice(0, 140)}”.`);
    if (!c.quote || (ok && !c.quoteVerified)) {
      c.quote = quote;
      c.quoteVerified = ok;
    }
  }

  // --- values: number must be in the cited chunk AND so must its unit (or a synonym such as "percent" for "%") ---
  const values: VerifiedValue[] = raw.values.map((v) => {
    const chunk = byChunk.get(v.chunkId);
    const numberFound = !!chunk && valueAppearsIn(v.value, chunk);
    const unitFound = !!chunk && unitInChunk(v.unit, chunk);
    const verified = numberFound && unitFound;
    let note: string | undefined;
    if (chunk && verified) {
      cite(chunk);
      noteVerified(chunk.chunkId, v.value);
    } else if (chunk && numberFound) note = `the number is in the chunk but the unit "${v.unit}" is not`;
    else note = `the number is not in chunk ${v.chunkId}`;
    if (!verified) warnings.push(`Could not verify "${v.label}: ${v.value}${v.unit ? " " + v.unit : ""}" – ${note}.`);
    return { ...v, page: chunk?.pageNumber, verified, note };
  });

  // --- calculations: inputs verified, arithmetic done by the server ---
  const calculations: CalculationResult[] = raw.calculations.map((c) => {
    const inputs = c.inputs.map((i) => {
      const chunk = byChunk.get(i.chunkId);
      const verified = !!chunk && valueAppearsIn(String(i.value), chunk) && unitInChunk(i.unit, chunk);
      if (chunk && verified) {
        cite(chunk);
        noteVerified(chunk.chunkId, String(i.value));
      }
      if (!verified) warnings.push(`Calculation input "${i.label}: ${i.value} ${i.unit}" was not found in chunk ${i.chunkId}.`);
      return { ...i, verified };
    });
    const out = runCalculation({
      label: c.label,
      operation: c.operation,
      inputs,
      unit: c.operation === "percent_less" || c.operation === "percent_of" ? "%" : (inputs[0]?.unit ?? ""),
      reportedResult: c.reportedResult ?? null,
    });
    if (out.error) warnings.push(`Calculation "${c.label}" failed: ${out.error}`);
    if (out.matchesReported === false)
      warnings.push(`Calculation "${c.label}" gives ${out.result}, which differs from the reported ${c.reportedResult?.value}.`);
    return out;
  });

  const cited = [...citations.values()];
  for (const c of cited) c.supporting = supportingSentences(c.chunk.text, verifiedByChunk.get(c.chunk.chunkId) ?? []);

  // --- every number in the prose must trace back to a cited chunk, a footnote of it, or a computed result ---
  const allowed = new Set<string>();
  for (const c of cited) {
    for (const n of numbersIn(`${c.chunk.text} ${c.chunk.facts.map((f) => f.value).join(" ")}`)) allowed.add(n);
    for (const f of c.chunk.footnotes) for (const n of numbersIn(`${f.marker} ${f.text}`)) allowed.add(n);
    allowed.add(String(c.chunk.pageNumber));
  }
  for (const c of calculations) {
    if (c.result !== null) allowed.add(String(parseFloat(String(c.result))));
    for (const i of c.inputs) allowed.add(String(i.value));
  }
  for (const f of cited.flatMap((c) => c.footnoteChunks)) {
    const fc = f.chunkId ? retrieved.find((r) => r.chunkId === f.chunkId) : undefined;
    const page = f.chunkId?.match(/^p(\d+)-/)?.[1];
    if (page) allowed.add(String(parseInt(page, 10)));
    if (fc) allowed.add(String(fc.pageNumber));
  }
  const stray = [...new Set(numbersIn(raw.answer))].filter((n) => !allowed.has(n));
  if (stray.length) warnings.push(`Numbers in the answer not found in the cited evidence: ${stray.join(", ")}.`);

  // --- claims: each "value + unit [+ comparison]" the answer states must exist as such in the cited evidence ---
  const evidenceFacts = cited.flatMap((c) =>
    [...extractFacts(c.chunk.text), ...c.chunk.facts].map((fact) => ({ fact: { ...fact, page: fact.page ?? c.chunk.pageNumber }, chunk: c.chunk })),
  );
  const claims: SupportedClaim[] = [];
  let claimProblem = false;
  for (const af of extractFacts(raw.answer).filter((f) => f.unit)) {
    const matches = evidenceFacts.filter((e) => sameNumber(e.fact.value, af.value) && sameUnit(e.fact.unit, af.unit));
    const computed = calculations.some((c) => c.result !== null && sameNumber(String(c.result), af.value) && sameUnit(c.unit, af.unit));
    const label = `${af.value}${normalizeUnit(af.unit) === "%" ? "%" : " " + af.unit}`;
    if (!matches.length && !computed) {
      claimProblem = true;
      warnings.push(`The answer states ${label}, but no cited evidence has that value with that unit.`);
      continue;
    }
    if (!matches.length) continue;
    let best = matches.find((m) => m.fact.comparison) ?? matches[0];
    if (af.comparison) {
      const cmp = matches.filter((m) => m.fact.comparison);
      if (cmp.length) {
        const ansRef = new Set(contentTokens(af.comparison.reference));
        const good = cmp.filter((m) => {
          if (m.fact.comparison!.direction !== af.comparison!.direction) return false;
          const ev = new Set(contentTokens(m.fact.comparison!.reference));
          const shared = [...ansRef].filter((t) => ev.has(t)).length;
          return ansRef.size === 0 || shared / ansRef.size >= 0.6;
        });
        if (!good.length) {
          claimProblem = true;
          warnings.push(`The answer states ${label} ${af.comparison.direction} than “${af.comparison.reference}”, which does not match the cited evidence (“${cmp[0].fact.claim ?? ""}”).`);
          continue;
        }
        best = good[0];
      }
    }
    if (!claims.some((c) => c.chunkId === best.chunk.chunkId && sameNumber(c.value, best.fact.value) && sameUnit(c.unit, best.fact.unit)))
      claims.push({
        statement: describeFact(best.fact),
        claim: best.fact.claim ?? best.chunk.text.slice(0, 200),
        value: best.fact.value,
        unit: best.fact.unit,
        comparison: best.fact.comparison,
        page: best.fact.page ?? best.chunk.pageNumber,
        chunkId: best.chunk.chunkId,
      });
  }

  // --- footnotes / qualifications that travel with the cited chunks ---
  const footnotes: AnswerFootnote[] = [];
  for (const c of cited) {
    const keep = new Set(markersForSupport(c.chunk, c.supporting));
    c.footnoteChunks = c.footnoteChunks.filter((f) => keep.has(f.marker));
    for (const f of c.footnoteChunks) {
      const existing = footnotes.find((x) => x.marker === f.marker && x.text === f.text);
      if (existing) existing.appliesTo.push(c.chunk.chunkId);
      else footnotes.push({ ...f, page: f.chunkId ? Number(f.chunkId.match(/^p(\d+)-/)?.[1]) || undefined : undefined, appliesTo: [c.chunk.chunkId] });
    }
  }

  // --- status: "answered" (verified) only when the key facts are actually supported ---
  const quotesFailed = cited.some((c) => c.quote && !c.quoteVerified);
  const supported =
    values.some((v) => v.verified) ||
    calculations.some((c) => c.result !== null && c.inputs.length > 0 && c.inputs.every((i) => i.verified)) ||
    cited.some((c) => c.quoteVerified);
  const hasUnverified =
    values.some((v) => !v.verified) ||
    calculations.some((c) => c.inputs.some((i) => !i.verified) || c.result === null) ||
    stray.length > 0 ||
    quotesFailed ||
    claimProblem;

  let status = raw.status;
  let answer = raw.answer.trim();
  if (cited.length === 0) {
    status = "insufficient_evidence";
    answer = "This could not be verified from the document: none of the retrieved chunks was confirmed as supporting evidence.";
  } else if (status === "answered" && (!supported || hasUnverified)) {
    status = "partial";
    if (!supported) warnings.push("No quote or value in the answer could be confirmed in the cited chunks, so it is not marked verified.");
  }

  return {
    question,
    docId: meta.docId,
    filename: meta.filename,
    status,
    answer,
    values,
    calculations,
    claims,
    footnotes,
    citations: cited,
    otherRetrieved: retrieved.filter((c) => !citations.has(c.chunkId)),
    warnings,
    caveats: raw.caveats,
  };
}

export async function answerQuestion(deps: RagDeps, question: string): Promise<AnswerResult> {
  const q = question.trim();
  if (!q) throw new AppError("INVALID_UPLOAD", "Please enter a question.", 400);
  if (q.length > 1000) throw new AppError("INVALID_UPLOAD", "Question is too long (max 1000 characters).", 400);
  const manifest = await deps.storage.readManifest();
  if (!manifest) throw new AppError("NO_DOCUMENT", "No document is indexed yet. Upload a PDF first.", 409);

  const retrieved = await retrieve(deps, manifest.docId, q);
  if (!retrieved.length)
    throw new AppError(
      "NO_DOCUMENT",
      "No indexed content was found in Qdrant for the active document. Re-upload the PDF to rebuild the index.",
      409,
    );
  let raw;
  try {
    raw = await deps.ai.answer(q, retrieved);
  } catch (e) {
    // Gemini unavailable (quota, outage): still show the evidence retrieved locally/from Qdrant, without a generated answer.
    const code = (e as { code?: string }).code;
    if (code !== "GEMINI_RATE_LIMIT" && code !== "GEMINI_FAILED") throw e;
    return {
      question: q,
      docId: manifest.docId,
      filename: manifest.filename,
      status: "partial",
      answer:
        code === "GEMINI_RATE_LIMIT"
          ? "Gemini's rate limit is reached, so no answer was generated. The most relevant evidence retrieved from the document is shown below; read the values directly from it, or retry in a minute."
          : "Gemini could not generate an answer. The most relevant evidence retrieved from the document is shown below.",
      values: [],
      calculations: [],
      claims: [],
      footnotes: [],
      citations: retrieved.slice(0, 4).map((chunk) => ({
        chunk,
        quote: null,
        quoteVerified: false,
        supporting: [],
        footnoteChunks: footnoteView(chunk),
      })),
      otherRetrieved: retrieved.slice(4),
      warnings: [`Answer generation unavailable: ${(e as Error).message}`],
      caveats: [],
    };
  }
  return verifyAnswer(q, raw, retrieved, { docId: manifest.docId, filename: manifest.filename });
}
