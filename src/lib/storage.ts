import fs from "node:fs/promises";
import path from "node:path";
import type { DocumentManifest } from "./types";

/**
 * Local persistent storage. Layout under DATA_DIR:
 *   manifest.json            – the single active document (written atomically, last)
 *   pdfs/<docId>.pdf         – committed PDFs
 *   staging/<docId>.pdf      – PDF being processed (never active)
 *   pages/<docId>/<n>.png    – rendered page images (cache + vision input)
 */
export class LocalStorage {
  constructor(public readonly root: string) {}

  private p(...parts: string[]) {
    return path.join(this.root, ...parts);
  }

  async init() {
    await Promise.all(["pdfs", "staging", "pages"].map((d) => fs.mkdir(this.p(d), { recursive: true })));
  }

  pdfPath(docId: string) {
    return this.p("pdfs", `${docId}.pdf`);
  }
  stagingPath(docId: string) {
    return this.p("staging", `${docId}.pdf`);
  }
  pagePath(docId: string, page: number) {
    return this.p("pages", docId, `${page}.png`);
  }

  async readManifest(): Promise<DocumentManifest | null> {
    try {
      const raw = await fs.readFile(this.p("manifest.json"), "utf8");
      const m = JSON.parse(raw) as DocumentManifest;
      // A manifest whose PDF vanished is not a usable active document.
      await fs.access(this.pdfPath(m.docId));
      return m;
    } catch {
      return null;
    }
  }

  async writeManifest(m: DocumentManifest) {
    const tmp = this.p(`manifest.json.${process.pid}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(m, null, 2));
    await fs.rename(tmp, this.p("manifest.json")); // atomic on same filesystem
  }

  async stagePdf(docId: string, data: Buffer) {
    await this.init();
    await fs.writeFile(this.stagingPath(docId), data);
  }

  async promotePdf(docId: string) {
    await fs.rename(this.stagingPath(docId), this.pdfPath(docId));
  }

  async savePage(docId: string, page: number, png: Buffer) {
    await fs.mkdir(this.p("pages", docId), { recursive: true });
    await fs.writeFile(this.pagePath(docId, page), png);
  }

  async readPage(docId: string, page: number): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.pagePath(docId, page));
    } catch {
      return null;
    }
  }

  async readPdf(docId: string): Promise<Buffer> {
    return fs.readFile(this.pdfPath(docId));
  }

  /** Removes every local trace of a document (committed, staged, page images). */
  async removeDoc(docId: string) {
    await Promise.all([
      fs.rm(this.pdfPath(docId), { force: true }),
      fs.rm(this.stagingPath(docId), { force: true }),
      fs.rm(this.p("pages", docId), { recursive: true, force: true }),
    ]);
  }

  /** Deletes committed PDFs / page caches that do not belong to the active document. */
  async removeAllExcept(activeDocId: string) {
    for (const [dir, strip] of [
      ["pdfs", true],
      ["pages", false],
    ] as const) {
      const entries = await fs.readdir(this.p(dir)).catch(() => []);
      for (const e of entries) {
        const id = strip ? e.replace(/\.pdf$/, "") : e;
        if (id !== activeDocId) await fs.rm(this.p(dir, e), { recursive: true, force: true });
      }
    }
  }

  async clearStaging() {
    await fs.rm(this.p("staging"), { recursive: true, force: true });
    await fs.mkdir(this.p("staging"), { recursive: true });
  }
}
