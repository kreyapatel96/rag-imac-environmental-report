import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestDocument, type IngestDeps } from "../src/lib/ingest";
import { pdfTools } from "../src/lib/pdf";
import { answerQuestion } from "../src/lib/rag";
import { LocalStorage } from "../src/lib/storage";
import { FakeCloud, FakeStore, makeFakeAi, type FakeAiOptions } from "./fakes";
import { makePdf } from "./fixtures";

let dir: string;
let cloud: FakeCloud;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "imac-rag-test-"));
  cloud = new FakeCloud();
});
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

/** A fresh set of dependencies = a "server restart": new objects, same disk + same cloud. */
function boot(ai: FakeAiOptions = {}): IngestDeps {
  return {
    store: new FakeStore(cloud),
    ai: makeFakeAi(ai),
    storage: new LocalStorage(dir),
    pdf: pdfTools,
    config: { collection: "t", visionModel: "fake", embeddingModel: "fake", embeddingProvider: "local", ingestMode: "vision", visionMaxPages: 99, embeddingDimensions: 64, maxUploadBytes: 5 * 1048576, maxPages: 10, pageConcurrency: 2 },
  };
}

const report = (use: string, mfg: string) =>
  makePdf([
    `Carbon use: ${use}% *\n* Based on a four-year lifespan.`,
    `Carbon manufacturing: ${mfg}%\nStand material: aluminum`,
  ]);
const files = (sub: string) => fs.readdir(path.join(dir, sub)).catch(() => [] as string[]);

describe("persistence across restarts", () => {
  it("keeps the PDF, manifest and vectors, and still answers after a 'restart'", async () => {
    const first = boot();
    const original = await report("55", "38");
    const m = await ingestDocument(first, { buffer: original, filename: "imac.pdf" });
    expect(m.pageCount).toBe(2);
    expect(await files("pdfs")).toEqual([`${m.docId}.pdf`]);

    const restarted = boot(); // brand-new objects
    const loaded = await restarted.storage.readManifest();
    expect(loaded?.docId).toBe(m.docId);
    expect(await restarted.store.countDoc(m.docId)).toBe(m.stats.chunks);
    const res = await answerQuestion(restarted, "carbon use");
    expect(res.docId).toBe(m.docId);
    expect(res.citations.length).toBeGreaterThan(0);
    expect(res.citations[0].chunk.pageNumber).toBe(1);
    // The saved PDF is byte-identical to the upload.
    expect((await restarted.storage.readPdf(m.docId)).equals(original)).toBe(true);
  });

  it("records stats and links footnotes to the elements that cite them", async () => {
    const d = boot();
    const m = await ingestDocument(d, { buffer: await report("55", "38"), filename: "imac.pdf" });
    expect(m.stats.footnotes).toBe(1);
    expect(m.stats.facts).toBe(2);
    const res = await answerQuestion(d, "carbon use lifespan");
    const cited = res.citations.find((c) => c.chunk.footnotes.length)!;
    expect(cited.chunk.footnotes[0].text).toBe("Based on a four-year lifespan.");
  });
});

describe("replacing the document", () => {
  it("indexes the new PDF first, then removes the old vectors, file and page images", async () => {
    const d = boot();
    const a = await ingestDocument(d, { buffer: await report("55", "38"), filename: "a.pdf" });
    const b = await ingestDocument(d, { buffer: await report("61", "29"), filename: "b.pdf" });
    expect(b.docId).not.toBe(a.docId);
    expect((await d.storage.readManifest())?.docId).toBe(b.docId);
    expect(await d.store.countDoc(a.docId)).toBe(0);
    expect(await files("pdfs")).toEqual([`${b.docId}.pdf`]);
    expect(await files("pages")).toEqual([b.docId]);
    expect(await files("staging")).toEqual([]);
    expect([...cloud.points.values()].every((p) => p.payload.docId === b.docId)).toBe(true);
  });

  it("answers only from the new document after replacement", async () => {
    const d = boot();
    await ingestDocument(d, { buffer: await report("55", "38"), filename: "a.pdf" });
    const b = await ingestDocument(d, { buffer: await report("61", "29"), filename: "b.pdf" });
    const res = await answerQuestion(boot(), "carbon use");
    expect(res.docId).toBe(b.docId);
    expect(res.filename).toBe("b.pdf");
    const everything = [...res.citations.map((c) => c.chunk), ...res.otherRetrieved];
    expect(everything.every((c) => c.docId === b.docId)).toBe(true);
    expect(res.answer).toContain("61");
    expect(res.answer).not.toContain("55");
  });

  it("keeps old vectors from being queried even while the new doc is still indexing", async () => {
    const d = boot();
    const a = await ingestDocument(d, { buffer: await report("55", "38"), filename: "a.pdf" });
    let midRun: string | null = null;
    const slow = boot();
    slow.ai = {
      ...makeFakeAi(),
      embed: async (t, k) => {
        // The new doc is mid-flight: the manifest still points at A and queries must see only A.
        if (k === "document") midRun = (await answerQuestion(d, "carbon use")).docId;
        return makeFakeAi().embed(t, k);
      },
    };
    const b = await ingestDocument(slow, { buffer: await report("61", "29"), filename: "b.pdf" });
    expect(midRun).toBe(a.docId);
    expect((await answerQuestion(d, "carbon use")).docId).toBe(b.docId);
  });
});

describe("hybrid ingestion (minimal Gemini usage)", () => {
  it("never calls vision for text-only pages and uses local layout analysis + chunks", async () => {
    const calls: number[] = [];
    const d = boot({ onAnalyze: (p) => calls.push(p) });
    d.config.ingestMode = "hybrid";
    const m = await ingestDocument(d, { buffer: await report("55", "38"), filename: "a.pdf" });
    expect(calls).toEqual([]);
    expect(m.stats.visionPages).toEqual([]);
    expect(m.stats.localPages).toEqual([1, 2]);
    expect(m.stats.chunks).toBeGreaterThan(0);
    expect([...cloud.points.values()].every((p) => p.payload.origin !== "vision")).toBe(true);
  });

  it("local mode never calls vision, even when asked for many pages", async () => {
    const calls: number[] = [];
    const d = boot({ onAnalyze: (p) => calls.push(p) });
    d.config.ingestMode = "local";
    await ingestDocument(d, { buffer: await report("55", "38"), filename: "a.pdf" });
    expect(calls).toEqual([]);
  });

  it("a failing vision page degrades to local analysis and is reported, without aborting", async () => {
    const d = boot({ failOnPage: 2 });
    const m = await ingestDocument(d, { buffer: await report("55", "38"), filename: "a.pdf" });
    expect(m.stats.visionFailedPages).toEqual([2]);
    expect(m.stats.visionPages).toEqual([1]);
    expect(m.stats.warnings.join()).toMatch(/page 2/);
    expect([...cloud.points.values()].some((p) => p.payload.pageNumber === 2)).toBe(true);
  });
});

describe("rate-limited vision", () => {
  it("stops calling Gemini after the first rate limit and reports one clear warning", async () => {
    const calls: number[] = [];
    const d = boot({ onAnalyze: (p) => calls.push(p), rateLimit: true });
    const m = await ingestDocument(d, { buffer: await report("55", "38"), filename: "a.pdf" });
    expect(calls).toHaveLength(1);
    expect(m.stats.visionFailedPages).toEqual([1, 2]);
    expect(m.stats.warnings).toHaveLength(1);
    expect(m.stats.warnings[0]).toMatch(/rate limit/i);
    expect(m.stats.chunks).toBeGreaterThan(0);
  });
});

describe("failed replacement preserves the old document", () => {
  async function expectOldIntact(d: IngestDeps, old: { docId: string; stats: { chunks: number } }, pdf: Buffer) {
    expect((await d.storage.readManifest())?.docId).toBe(old.docId);
    expect(await d.store.countDoc(old.docId)).toBe(old.stats.chunks);
    expect([...cloud.points.values()].every((p) => p.payload.docId === old.docId)).toBe(true);
    expect(await files("pdfs")).toEqual([`${old.docId}.pdf`]);
    expect(await files("staging")).toEqual([]);
    expect(await files("pages")).toEqual([old.docId]);
    expect((await d.storage.readPdf(old.docId)).equals(pdf)).toBe(true);
    expect((await answerQuestion(d, "carbon use")).answer).toContain("55");
  }

  it("when Gemini rejects the API key", async () => {
    const original = await report("55", "38");
    const old = await ingestDocument(boot(), { buffer: original, filename: "a.pdf" });
    const d = boot({ authFailure: true });
    await expect(ingestDocument(d, { buffer: await report("61", "29"), filename: "b.pdf" })).rejects.toMatchObject({ code: "GEMINI_AUTH" });
    await expectOldIntact(boot(), old, original);
  });

  it("when embedding fails", async () => {
    const original = await report("55", "38");
    const old = await ingestDocument(boot(), { buffer: original, filename: "a.pdf" });
    await expect(ingestDocument(boot({ failEmbed: true }), { buffer: await report("61", "29"), filename: "b.pdf" })).rejects.toThrow(/embedding/);
    await expectOldIntact(boot(), old, original);
  });

  it("when Qdrant fails after partially writing vectors", async () => {
    const original = await report("55", "38");
    const old = await ingestDocument(boot(), { buffer: original, filename: "a.pdf" });
    const d = boot();
    const real = d.store.upsert.bind(d.store);
    d.store.upsert = async (pts) => {
      await real(pts.slice(0, 2));
      throw new Error("qdrant down");
    };
    await expect(ingestDocument(d, { buffer: await report("61", "29"), filename: "b.pdf" })).rejects.toThrow(/qdrant down/);
    await expectOldIntact(boot(), old, original);
  });

  it("when the upload is not a valid PDF, is empty, or has too many pages", async () => {
    const original = await report("55", "38");
    const old = await ingestDocument(boot(), { buffer: original, filename: "a.pdf" });
    const d = boot();
    await expect(ingestDocument(d, { buffer: Buffer.from("hello, not a pdf"), filename: "x.pdf" })).rejects.toMatchObject({ code: "INVALID_PDF" });
    await expect(ingestDocument(d, { buffer: Buffer.alloc(0), filename: "x.pdf" })).rejects.toMatchObject({ code: "INVALID_UPLOAD" });
    await expect(ingestDocument(d, { buffer: Buffer.from("%PDF-1.4\ngarbage"), filename: "x.pdf" })).rejects.toMatchObject({ code: "PDF_PARSE_FAILED" });
    d.config.maxPages = 1;
    await expect(ingestDocument(d, { buffer: await report("61", "29"), filename: "b.pdf" })).rejects.toMatchObject({ code: "INVALID_PDF" });
    await expectOldIntact(boot(), old, original);
  });

  it("a failed FIRST upload leaves nothing behind", async () => {
    const d = boot({ authFailure: true });
    await expect(ingestDocument(d, { buffer: await report("55", "38"), filename: "a.pdf" })).rejects.toThrow();
    expect(await d.storage.readManifest()).toBeNull();
    expect(cloud.points.size).toBe(0);
    expect(await files("pdfs")).toEqual([]);
    await expect(answerQuestion(d, "anything")).rejects.toMatchObject({ code: "NO_DOCUMENT" });
  });
});
