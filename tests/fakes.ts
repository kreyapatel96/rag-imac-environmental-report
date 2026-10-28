import type { AiClient, PageAnalysis, RawAnswer } from "../src/lib/ai";
import type { ChunkPayload, RetrievedChunk } from "../src/lib/types";
import type { VectorHit, VectorPoint, VectorStore } from "../src/lib/vectorstore";
import { AppError } from "../src/lib/errors";
import { tokenize } from "../src/lib/rag";

/** The "cloud": survives creating new store/storage instances, like Qdrant Cloud survives a server restart. */
export class FakeCloud {
  points = new Map<string, VectorPoint>();
}

export class FakeStore implements VectorStore {
  constructor(public cloud: FakeCloud) {}
  async ensureCollection() {}
  async upsert(points: VectorPoint[]) {
    for (const p of points) this.cloud.points.set(p.id, p);
  }
  private doc(docId: string) {
    return [...this.cloud.points.values()].filter((p) => p.payload.docId === docId);
  }
  async search(vector: number[], docId: string, limit: number): Promise<VectorHit[]> {
    return this.doc(docId)
      .map((p) => ({ id: p.id, payload: p.payload, score: cosine(vector, p.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
  async listDoc(docId: string) {
    return this.doc(docId).map((p) => ({ id: p.id, payload: p.payload }));
  }
  async countDoc(docId: string) {
    return this.doc(docId).length;
  }
  async deleteDoc(docId: string) {
    for (const p of this.doc(docId)) this.cloud.points.delete(p.id);
  }
  async deleteAllExcept(docId: string) {
    for (const [id, p] of this.cloud.points) if (p.payload.docId !== docId) this.cloud.points.delete(id);
  }
}

function cosine(a: number[], b: number[]) {
  let d = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] ** 2;
    nb += b[i] ** 2;
  }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

function hashEmbed(text: string, dim = 64): number[] {
  const v = new Array(dim).fill(0);
  for (const t of tokenize(text)) {
    let h = 0;
    for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % dim] += 1;
  }
  return v;
}

export interface FakeAiOptions {
  failOnPage?: number;
  /** Fail every vision call like a bad API key. */
  authFailure?: boolean;
  rateLimit?: boolean;
  onAnalyze?: (page: number) => void;
  failEmbed?: boolean;
  /** Overrides what the "model" answers. */
  answer?: (q: string, chunks: RetrievedChunk[]) => RawAnswer;
}

/**
 * Test double for Gemini. analyzePage "reads" the page text layer: every line is a paragraph and a line like
 * "Label: 12.5 kWh*" becomes a chart element with a value and footnote marker; "* text" lines are footnotes.
 */
export function makeFakeAi(opts: FakeAiOptions = {}): AiClient {
  return {
    async analyzePage({ pageNumber, textLayer, imagePng }): Promise<PageAnalysis> {
      opts.onAnalyze?.(pageNumber);
      if (opts.rateLimit) throw new AppError("GEMINI_RATE_LIMIT", "Gemini rate limit reached.", 429);
      if (opts.authFailure) throw new AppError("GEMINI_AUTH", "bad key", 502);
      if (imagePng.subarray(1, 4).toString() !== "PNG") throw new Error("no image passed to vision");
      if (opts.failOnPage === pageNumber) throw new Error("simulated Gemini outage");
      const analysis: PageAnalysis = { elements: [], footnotes: [] };
      for (const line of textLayer.split("\n").map((l) => l.trim()).filter(Boolean)) {
        const fn = line.match(/^([*†])\s+(.*)$/);
        if (fn) {
          analysis.footnotes.push({ marker: fn[1], text: fn[2] });
          continue;
        }
        const m = line.match(/^(.+?):\s*([\d.,]+%?)\s*([A-Za-z0-9]*)\s*([*†])?$/);
        if (m)
          analysis.elements.push({
            type: "chart",
            label: m[1],
            labels: [m[1]],
            text: line,
            values: [{ label: m[1], value: m[2], unit: m[3] }],
            footnoteMarkers: m[4] ? [m[4]] : [],
          });
        else analysis.elements.push({ type: "paragraph", label: line.slice(0, 40), labels: [], text: line, values: [], footnoteMarkers: [] });
      }
      return analysis;
    },
    async embed(texts) {
      if (opts.failEmbed) throw new Error("simulated embedding failure");
      return texts.map((t) => hashEmbed(t));
    },
    async answer(q, chunks) {
      if (opts.answer) return opts.answer(q, chunks);
      const top = chunks.find((c) => c.facts.length) ?? chunks[0];
      const f = top.facts[0];
      return {
        status: "answered",
        answer: f ? `${f.label} is ${f.value} ${f.unit} (page ${top.pageNumber}).` : `See ${top.chunkId}.`,
        evidence: [{ chunkId: top.chunkId, quote: top.text }],
        values: f ? [{ label: f.label, value: f.value, unit: f.unit, chunkId: top.chunkId }] : [],
        calculations: [],
        caveats: [],
      };
    },
  };
}

export type { ChunkPayload };
