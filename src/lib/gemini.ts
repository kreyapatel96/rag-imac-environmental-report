import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import type { Env } from "./env";
import { AppError, errorStatus, isQuotaExhausted, withRetry } from "./errors";
import {
  pageAnalysisSchema,
  rawAnswerSchema,
  type AiClient,
  type PageAnalysis,
  type RawAnswer,
} from "./ai";

const VISION_PROMPT = `You are extracting evidence from ONE page of a product environmental report so it can be indexed for question answering.
You receive the page IMAGE and the PDF text layer (which may be incomplete or mis-ordered for charts).

Return ONLY JSON of this shape:
{
  "elements": [
    {
      "type": "chart" | "table" | "paragraph" | "callout" | "footnote",
      "label": "title/heading of the element, as printed",
      "labels": ["every axis label, legend entry, series name, row/column header, or callout heading printed in/near the element"],
      "text": "faithful transcription. For charts: describe the chart type and list EVERY data label with its exact printed value and unit (e.g. 'Use: 55%'). For tables: transcribe every row as 'Row: col=value; col=value'. For paragraphs/callouts: copy the text verbatim.",
      "values": [{ "label": "what the number measures", "value": "number exactly as printed, e.g. '7.4' or '30%'", "unit": "unit as printed, e.g. 'kWh', 'kg CO2e', '%' or ''" }],
      "footnoteMarkers": ["markers (e.g. '*', '1', '†') printed on or next to this element that point to a footnote"]
    }
  ],
  "footnotes": [{ "marker": "marker exactly as printed", "text": "full footnote text verbatim" }]
}

Rules:
- Cover EVERYTHING on the page: charts, tables, numerical values, callouts, paragraphs, footnotes. Split distinct items into separate elements.
- Copy numbers, units and wording EXACTLY. Never round, convert, infer or calculate. If a value is unreadable, omit it; do not guess.
- Footnote text goes in "footnotes" (not as elements). Keep "footnoteMarkers" on the elements that reference them, INCLUDING superscript numbers printed after a sentence (e.g. "…ENERGY STAR.18" → footnoteMarkers ["18"]; do not leave the number inside "text").
- Numbered endnotes/notes lists ("18  Energy consumption and …") are footnotes: return each as {"marker":"18","text":"…full note…"}.
- Keep every sentence that states a number together with its comparison in ONE element (e.g. "iMac uses 58 percent less energy than the requirement for ENERGY STAR") and copy it word for word.
- A page with no meaningful content (blank/decorative) returns {"elements": [], "footnotes": []}.
- No commentary, no markdown fences.`;

const ANSWER_PROMPT = `You answer questions about ONE product environmental report using ONLY the numbered evidence chunks provided.

Return ONLY JSON of this shape:
{
  "status": "answered" | "partial" | "insufficient_evidence",
  "answer": "concise answer that restates exact values and units as they appear in the chunks, mentions page numbers, and mentions any footnote that qualifies a value",
  "evidence": [{ "chunkId": "id of a provided chunk you relied on", "quote": "short EXACT substring copied from that chunk's text" }],
  "values": [{ "label": "...", "value": "exactly as printed in the chunk", "unit": "...", "chunkId": "..." }],
  "calculations": [{
    "label": "what is being derived",
    "operation": "difference" | "percent_less" | "percent_of" | "sum" | "ratio",
    "inputs": [{ "label": "...", "value": 0, "unit": "...", "chunkId": "..." }],
    "reportedResult": { "value": 0, "unit": "..." } | null
  }],
  "caveats": ["anything that could not be verified or that a footnote qualifies"]
}

Rules:
- Use only provided chunks. Do not use outside knowledge. Do not invent chunk ids, values, units or pages.
- Never do arithmetic yourself. If the document states the final figure, report it in "values". If you need a derived figure, list the printed inputs in "calculations" ("percent_less" inputs are [actual, reference]; "difference" is first minus second) and the server will compute it. If the document ALSO prints that result, give it as "reportedResult".
- If the evidence does not contain the answer (or only part of it), say so plainly, set status to "partial" or "insufficient_evidence", and state what is missing. Do not guess.
- When an evidence chunk lists footnotes that qualify the value, mention them.
- Every number in "answer" must appear in a cited chunk or be a result of "calculations".`;

function parseJson(text: string | undefined): unknown {
  if (!text) throw new Error("empty model response");
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

function mapError(err: unknown, what: string): AppError {
  if (err instanceof AppError) return err;
  const status = errorStatus(err);
  const msg = err instanceof Error ? err.message : String(err);
  if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(msg))
    return new AppError("GEMINI_AUTH", "Gemini rejected the API key. Check GEMINI_API_KEY in .env.local.", 502, err);
  if (status === 429)
    return new AppError(
      "GEMINI_RATE_LIMIT",
      isQuotaExhausted(err)
        ? "Gemini daily/free-tier quota is exhausted. Try again after it resets, use another model (GEMINI_MODEL / GEMINI_VISION_MODEL), or enable billing."
        : "Gemini rate limit reached. Wait a minute and try again.",
      429,
      err,
    );
  return new AppError("GEMINI_FAILED", `Gemini ${what} failed: ${msg.slice(0, 300)}`, 502, err);
}

export function createGeminiClient(env: Env): AiClient {
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY, httpOptions: { timeout: 180_000 } });
  let thinkingSupported = true;

  async function generateJson<T>(
    parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[],
    parse: (raw: unknown) => T,
    what: string,
    fast = false,
  ): Promise<T> {
    const model = fast ? (env.GEMINI_VISION_MODEL ?? env.GEMINI_MODEL) : env.GEMINI_MODEL;
    try {
      // One re-ask is allowed for malformed JSON; transient API errors retry inside.
      for (let attempt = 0; ; attempt++) {
        const res = await withRetry(() =>
          ai.models.generateContent({
            model,
            contents: [{ role: "user", parts }],
            config: {
              responseMimeType: "application/json",
              temperature: 0,
              // Extraction is transcription, not reasoning: low thinking is ~3x faster. Skipped if the model rejects it.
              ...(fast && thinkingSupported ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
            },
          }).catch((e: unknown) => {
            if (fast && thinkingSupported && /thinking/i.test(e instanceof Error ? e.message : "")) {
              thinkingSupported = false;
              throw Object.assign(new Error("retry without thinking config"), { status: 503 });
            }
            throw e;
          }),
          // Vision runs once per page: wait out per-minute limits instead of failing the page.
          { rateLimitAttempts: fast ? 3 : 1 },
        );
        try {
          return parse(parseJson(res.text));
        } catch (e) {
          if (attempt >= 1) throw new Error(`model returned invalid JSON (${(e as Error).message})`);
        }
      }
    } catch (err) {
      throw mapError(err, what);
    }
  }

  return {
    analyzePage({ pageNumber, imagePng, textLayer }): Promise<PageAnalysis> {
      return generateJson(
        [
          { text: `${VISION_PROMPT}\n\nPage number: ${pageNumber}\n\nPDF text layer:\n"""\n${textLayer.slice(0, 12000)}\n"""` },
          { inlineData: { mimeType: "image/png", data: imagePng.toString("base64") } },
        ],
        (raw) => pageAnalysisSchema.parse(raw),
        `analysis of page ${pageNumber}`,
        true,
      );
    },

    async embed(texts, task) {
      const out: number[][] = [];
      try {
        for (let i = 0; i < texts.length; i += 50) {
          const batch = texts.slice(i, i + 50);
          const res = await withRetry(() =>
            ai.models.embedContent({
              model: env.GEMINI_EMBEDDING_MODEL,
              contents: batch,
              config: {
                taskType: task === "document" ? "RETRIEVAL_DOCUMENT" : "RETRIEVAL_QUERY",
                outputDimensionality: env.EMBEDDING_DIMENSIONS,
              },
            }),
          );
          const vectors = (res.embeddings ?? []).map((e) => e.values ?? []);
          if (vectors.length !== batch.length || vectors.some((v) => v.length !== env.EMBEDDING_DIMENSIONS))
            throw new Error(`unexpected embedding shape (got ${vectors.length} vectors for ${batch.length} inputs)`);
          out.push(...vectors);
        }
        return out;
      } catch (err) {
        throw mapError(err, "embedding");
      }
    },

    answer(question, chunks): Promise<RawAnswer> {
      const evidence = chunks
        .map(
          (c) =>
            `--- chunkId: ${c.chunkId} | page: ${c.pageNumber} | type: ${c.sourceType} | label: ${c.label}\n` +
            `${c.text}\n` +
            (c.labels.length ? `labels: ${c.labels.join("; ")}\n` : "") +
            (c.footnotes.length
              ? `footnotes: ${c.footnotes.map((f) => `[${f.marker}] ${f.text}`).join(" || ")}\n`
              : ""),
        )
        .join("\n");
      return generateJson(
        [{ text: `${ANSWER_PROMPT}\n\nQUESTION: ${question}\n\nEVIDENCE CHUNKS:\n${evidence}` }],
        (raw) => rawAnswerSchema.parse(raw),
        "answer generation",
      );
    },
  };
}
