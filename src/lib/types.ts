export const SOURCE_TYPES = ["chart", "table", "paragraph", "callout", "footnote"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export interface FactValue {
  label: string; // what the number measures, e.g. "energy"
  value: string; // exactly as printed, e.g. "7.4" or "58"
  unit: string; // as printed, e.g. "%", "percent", "kWh"
  claim?: string; // the complete sentence/row the value comes from
  subject?: string; // e.g. "iMac"
  comparison?: { direction: "less" | "more"; reference: string }; // e.g. less than "the requirement for ENERGY STAR"
  page?: number;
}

export interface FootnoteRef {
  marker: string;
  text: string;
  chunkId?: string; // chunk holding the footnote text itself
}

export interface ChunkPayload {
  docId: string;
  chunkId: string; // readable id, unique within a document, e.g. "p12-chart-1"
  pageNumber: number;
  sourceType: SourceType;
  origin: "vision" | "layout" | "text-layer"; // vision = Gemini, layout = local PDF layout analysis
  label: string; // heading / title of the element
  labels: string[]; // every label found in the element (axis, series, row, legend ...)
  text: string; // faithful transcription of the element
  facts: FactValue[]; // structured numeric facts
  footnotes: FootnoteRef[]; // footnotes this element points to
  referencedBy: string[]; // for footnote chunks: chunk ids that cite this footnote
  markers?: string[]; // footnote markers detected on the element (linked or not)
}

export interface DocumentStats {
  pagesAnalyzed: number;
  chunks: number;
  facts: number;
  footnotes: number;
  bySourceType: Record<SourceType, number>;
  visionModel: string;
  embeddingModel: string;
  embeddingProvider: "local" | "gemini";
  embeddingDimensions: number;
  ingestMode: "local" | "hybrid" | "vision";
  visionPages: number[]; // pages analysed by Gemini vision
  localPages: number[]; // pages analysed by the local layout analyser only
  visionFailedPages: number[]; // vision was planned but failed; local analysis was used instead
  warnings: string[];
}

export interface DocumentManifest {
  docId: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  pageCount: number;
  uploadedAt: string;
  indexedAt: string;
  collection: string;
  stats: DocumentStats;
}

export interface RetrievedChunk extends ChunkPayload {
  pointId: string;
  score: number; // fused ranking score
  vectorRank: number | null;
  lexicalRank: number | null;
}

export type VerificationLevel = "verified" | "unverified";

export interface VerifiedValue {
  label: string;
  value: string;
  unit: string;
  chunkId: string;
  page?: number;
  verified: boolean;
  note?: string; // why it is not verified (e.g. unit not found next to the value)
}

/** An evidence fact that backs a number the answer states (value + unit [+ comparison]). */
export interface SupportedClaim {
  statement: string; // e.g. "58% less energy than the requirement for ENERGY STAR (p7)"
  claim: string; // the complete source sentence
  value: string;
  unit: string;
  comparison?: { direction: "less" | "more"; reference: string };
  page: number;
  chunkId: string;
}

export interface AnswerFootnote {
  marker: string;
  text: string;
  chunkId?: string;
  page?: number;
  appliesTo: string[]; // cited chunk ids that point to this footnote
}

export interface CalculationResult {
  label: string;
  operation: string;
  inputs: { label: string; value: number; unit: string; chunkId: string; verified: boolean }[];
  result: number | null;
  unit: string;
  formula: string;
  reportedResult?: { value: number; unit: string } | null;
  matchesReported?: boolean | null;
  error?: string;
}

export interface Citation {
  chunk: RetrievedChunk;
  quote: string | null;
  quoteVerified: boolean;
  supporting: string[]; // sentences of the chunk that contain the verified value(s) – shown as the evidence
  footnoteChunks: { marker: string; text: string; chunkId?: string }[];
}

export interface AnswerResult {
  question: string;
  docId: string;
  filename: string;
  status: "answered" | "partial" | "insufficient_evidence";
  answer: string;
  values: VerifiedValue[];
  calculations: CalculationResult[];
  claims: SupportedClaim[];
  footnotes: AnswerFootnote[]; // qualifications attached to the cited chunks
  citations: Citation[];
  otherRetrieved: RetrievedChunk[];
  warnings: string[];
  caveats: string[];
}

export type IngestStage =
  | "validating"
  | "saving"
  | "analyzing"
  | "embedding"
  | "indexing"
  | "activating"
  | "cleanup"
  | "done";

export interface IngestProgress {
  stage: IngestStage;
  message: string;
  percent: number; // 0..100
  page?: number;
  pageCount?: number;
}
