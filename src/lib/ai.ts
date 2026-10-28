import { z } from "zod";
import type { FactValue, RetrievedChunk } from "./types";
import { SOURCE_TYPES } from "./types";

/* ---------- Page analysis (vision) ---------- */

export const pageAnalysisSchema = z.object({
  elements: z
    .array(
      z.object({
        type: z.enum(SOURCE_TYPES).catch("paragraph"),
        label: z.string().default(""),
        labels: z.array(z.string()).default([]),
        text: z.string().default(""),
        values: z
          .array(
            z.object({
              label: z.string().default(""),
              value: z.coerce.string().default(""),
              unit: z.string().default(""),
            }),
          )
          .default([]),
        footnoteMarkers: z.array(z.coerce.string()).default([]),
      }),
    )
    .default([]),
  footnotes: z
    .array(z.object({ marker: z.coerce.string(), text: z.string() }))
    .default([]),
});
export type PageAnalysis = z.infer<typeof pageAnalysisSchema>;

/* ---------- Answer generation ---------- */

export const rawAnswerSchema = z.object({
  status: z.enum(["answered", "partial", "insufficient_evidence"]).catch("partial"),
  answer: z.string(),
  evidence: z
    .array(z.object({ chunkId: z.string(), quote: z.string().default("") }))
    .default([]),
  values: z
    .array(
      z.object({
        label: z.string().default(""),
        value: z.coerce.string(),
        unit: z.string().default(""),
        chunkId: z.string(),
      }),
    )
    .default([]),
  calculations: z
    .array(
      z.object({
        label: z.string().default(""),
        operation: z.string(),
        inputs: z.array(
          z.object({
            label: z.string().default(""),
            value: z.coerce.number(),
            unit: z.string().default(""),
            chunkId: z.string(),
          }),
        ),
        reportedResult: z
          .object({ value: z.coerce.number(), unit: z.string().default("") })
          .nullable()
          .optional(),
      }),
    )
    .default([]),
  caveats: z.array(z.string()).default([]),
});
export type RawAnswer = z.infer<typeof rawAnswerSchema>;

export interface AiClient {
  analyzePage(input: { pageNumber: number; imagePng: Buffer; textLayer: string }): Promise<PageAnalysis>;
  embed(texts: string[], task: "document" | "query"): Promise<number[][]>;
  answer(question: string, chunks: RetrievedChunk[]): Promise<RawAnswer>;
}

export type { FactValue };
