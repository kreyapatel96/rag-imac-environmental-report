import type { ChunkPayload } from "./types";

export interface VectorPoint {
  id: string;
  vector: number[];
  payload: ChunkPayload;
}

export interface VectorHit {
  id: string;
  score: number;
  payload: ChunkPayload;
}

/** Everything the app needs from a vector DB. Qdrant implements it; tests use an in-memory fake. */
export interface VectorStore {
  ensureCollection(dimensions: number): Promise<void>;
  upsert(points: VectorPoint[]): Promise<void>;
  /** Similarity search restricted to a single document. */
  search(vector: number[], docId: string, limit: number): Promise<VectorHit[]>;
  /** All chunks of one document (used for lexical retrieval and stats). */
  listDoc(docId: string): Promise<{ id: string; payload: ChunkPayload }[]>;
  countDoc(docId: string): Promise<number>;
  deleteDoc(docId: string): Promise<void>;
  /** Removes every vector that does not belong to `docId`. */
  deleteAllExcept(docId: string): Promise<void>;
}
