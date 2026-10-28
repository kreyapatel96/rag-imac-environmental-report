/**
 * LIVE smoke test against real Gemini + Qdrant (uses your .env.local and your data/ folder).
 *   npm run smoke -- path/to/imac-environmental-report.pdf
 * It indexes the PDF (replacing the active document) and asks the three test questions.
 */
import fs from "node:fs";
import { getServices } from "../src/lib/services";
import { ingestDocument } from "../src/lib/ingest";
import { answerQuestion } from "../src/lib/rag";
import { SUGGESTED_QUESTIONS } from "../src/lib/client-types";

for (const f of [".env.local", ".env"]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

async function main() {
  const file = process.argv[2];
  const s = getServices();
  if (file) {
    const doc = await ingestDocument(s.ingest, { buffer: fs.readFileSync(file), filename: file.split("/").pop()! }, (p) =>
      console.log(`[${String(p.percent).padStart(3)}%] ${p.message}`),
    );
    console.log("Indexed:", JSON.stringify(doc.stats));
  }
  for (const q of SUGGESTED_QUESTIONS) {
    const r = await answerQuestion(s.rag, q);
    console.log(`\nQ: ${q}\nStatus: ${r.status}\nA: ${r.answer}`);
    for (const c of r.citations) console.log(`  • p${c.chunk.pageNumber} ${c.chunk.sourceType} ${c.chunk.chunkId}: ${c.chunk.text.slice(0, 140)}`);
    for (const c of r.claims) console.log(`  ✔ claim: ${c.statement} [${c.chunkId}] — “${c.claim}”`);
    for (const f of r.footnotes) console.log(`  ⚑ footnote [${f.marker}] (p${f.page ?? "?"}, ${f.chunkId}): ${f.text.slice(0, 160)}`);
    if (r.warnings.length) console.log("  warnings:", r.warnings);
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
