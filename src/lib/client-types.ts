export type { AnswerResult, DocumentManifest, IngestProgress, RetrievedChunk, Citation } from "./types";

export interface DocumentState {
  document: import("./types").DocumentManifest | null;
  vectorStatus?: "ok" | "missing" | "unreachable";
  vectorCount?: number | null;
  busy?: boolean;
}

export const SUGGESTED_QUESTIONS = [
  "How much less energy does iMac use compared with the ENERGY STAR requirement?",
  "What is its total carbon footprint, and how much comes from product use versus manufacturing?",
  "What material is the iMac stand made from, and what percentage is recycled?",
] as const;
