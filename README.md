# iMac Visual Document RAG

Upload Apple's **iMac Product Environmental Report** (PDF), index every page with Gemini vision + embeddings in **Qdrant Cloud**, and ask questions whose answers are verified against the retrieved chunks and shown with page-level citations.

**Stack:** Next.js 16 · local embeddings via `@huggingface/transformers` (App Router) · TypeScript · Tailwind CSS 4 · `@google/genai` · `@qdrant/js-client-rest` · `pdfjs-dist` + `@napi-rs/canvas` · Vitest

## Setup

Requires **Node 22.3+** (22.22 or newer recommended) (pdf.js 6 needs `Promise.withResolvers`; Node 20 and older fail with "Promise.withResolvers is not a function" or hang).

```bash
nvm use 22            # must be 22.3 or newer
npm install
cp .env.example .env.local   # then fill in the keys below
npm run check-env     # validates .env.local (does not call the services)
npm run dev           # http://localhost:3000
```

### Gemini
1. Create a key at <https://aistudio.google.com/apikey> and put it in `GEMINI_API_KEY`.
2. `GEMINI_MODEL` (default `gemini-3.5-flash`) is used for chart/image page reading and for answers. Set any current vision-capable model if yours differs.

### Keeping Gemini usage (free-tier quota) low
| Work | Where it runs | Gemini calls |
| --- | --- | --- |
| Text extraction, layout, headings, tables, footnotes, callouts, numeric facts, chunking | local (`pdfjs` + `src/lib/layout.ts`) | 0 |
| Embeddings (`EMBEDDING_PROVIDER=local`) | local ONNX model (`bge-small`, 384d), downloaded once to `data/models` | 0 |
| Chart / image / infographic pages (`INGEST_MODE=hybrid`) | Gemini vision, only pages with images or many vector shapes, at most `VISION_MAX_PAGES` (default 15), most graphic-heavy first | ≤ 15 per upload |
| Answering | Gemini | 1 per question |

`INGEST_MODE=local` never calls vision; `INGEST_MODE=vision` reads every page with Gemini (uses the most quota). If vision fails on a page (e.g. rate limit) the page falls back to local analysis and the UI lists a warning; a rejected API key aborts the upload and keeps the old document. If Gemini is rate-limited when you ask a question, the app still shows the retrieved evidence chunks (without a generated answer).

### Qdrant Cloud (free tier)
1. Sign in at <https://cloud.qdrant.io> → **Create cluster** → Free.
2. Copy the cluster URL (e.g. `https://<id>.<region>.cloud.qdrant.io:6333`) into `QDRANT_URL`.
3. Cluster → **API Keys** → create a key → `QDRANT_API_KEY`.
4. The collection (`QDRANT_COLLECTION`, default `imac_rag_chunks`) is created automatically on first upload. If you switch `EMBEDDING_PROVIDER` (384 ↔ 768 dims), use a new `QDRANT_COLLECTION` name.

### Run
```bash
npm run dev                 # development
npm run build && npm start  # production
npm run smoke -- ./imac-environmental-report.pdf   # optional live CLI test: index + ask the 3 questions
```

## How it works

| Step | What happens |
| --- | --- |
| Upload | Magic-byte + size + page-count validation, then the PDF is written to `data/staging/`. |
| Analyse | Every page: text layer + positions + page image locally; the layout analyser finds headings, paragraphs, tables, big-number callouts, footnotes (and superscript markers) and chart label groups. Chart/image-heavy pages additionally go to Gemini vision, which returns charts, tables, callouts, footnotes, labels and exact values as JSON. |
| Chunk | One chunk per element + one per footnote + one verbatim text-layer chunk per page. Footnotes are linked to the elements citing them (same page). IDs look like `p7-chart-1`. |
| Index | Embeddings (local `bge-small` by default; Gemini optional) → Qdrant points; payload holds text, page, source type, labels, structured facts, footnotes. |
| Activate | PDF moved to `data/pdfs/`, `data/manifest.json` written atomically. **Only now** is the document active. |
| Clean up | Vectors, PDF and page images of any other document are deleted. |
| Ask | Query embedding (same model) → Qdrant search **filtered by the active `docId`** + BM25 lexical ranking over the same document, fused with RRF → Gemini answers from those chunks as JSON. |
| Verify | Citations must be retrieved chunk IDs; quotes must be verbatim substrings; values and calculation inputs must literally appear in the cited chunk; every number in the prose must appear in cited evidence or a computed result; arithmetic is done by the server (`src/lib/calc.ts`), never the model. Failures downgrade the status to *Partially verified* / *Cannot verify* and are listed. |

Nothing about the three test questions is hard-coded: they are plain strings sent through the same pipeline as any other question.

### Persistence & safe replacement
- Local: `data/` (`DATA_DIR`) holds the PDF, page images and `manifest.json`. Cloud: Qdrant holds chunks/embeddings/facts. Restarting the server or the browser loses nothing.
- Uploading a new PDF never touches the active document until the new one is fully indexed and verified in Qdrant (chunk count check). If anything fails (bad PDF, Gemini/Qdrant error, crash), the new document's vectors and files are rolled back and the old document stays active.
- Every query filters on the active `docId`, so old and new documents cannot mix, even during a replacement or if old-vector cleanup were interrupted (it is retried on the next upload).
- Uploads are serialised with an in-process lock (single-instance local use).

## Scripts
`npm run lint` · `npm run typecheck` · `npm test` · `npm run build` · `npm run check` (all four)

## Tests
`tests/` runs the real PDF parsing/rendering pipeline with in-memory fakes for Gemini and Qdrant, covering persistence across a simulated restart, successful replacement, failed replacement (Gemini failure, embedding failure, partial Qdrant write, invalid/oversized PDFs), calculations, citation/value verification, and env validation. **These fakes do not prove the real Gemini/Qdrant integrations or answer quality.** Use `npm run smoke` with your keys and the real PDF for that.

## Troubleshooting
- *"Setup needed" banner* – a variable in `.env.local` is missing/invalid; restart after editing.
- *GEMINI_AUTH / QDRANT_AUTH* – wrong key. *QDRANT_UNREACHABLE* – check `QDRANT_URL` (include `https://` and port `6333`).
- *Vectors missing* badge – the Qdrant collection was deleted/changed; re-upload the PDF.
- Free Gemini tiers are rate-limited; a 429 is retried with backoff, and surfaces as "rate limit" if it persists (re-upload; the old document stays).
