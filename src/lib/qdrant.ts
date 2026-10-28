import { QdrantClient } from "@qdrant/js-client-rest";
import type { Env } from "./env";
import { AppError, errorStatus, withRetry } from "./errors";
import type { ChunkPayload } from "./types";
import type { VectorHit, VectorPoint, VectorStore } from "./vectorstore";

function mapError(err: unknown, what: string): AppError {
  if (err instanceof AppError) return err;
  const status = errorStatus(err);
  const msg = err instanceof Error ? err.message : String(err);
  if (status === 401 || status === 403)
    return new AppError("QDRANT_AUTH", "Qdrant rejected the API key. Check QDRANT_API_KEY in .env.local.", 502, err);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|certificate/i.test(msg) || status === undefined)
    return new AppError(
      "QDRANT_UNREACHABLE",
      `Cannot reach Qdrant (${what}). Check QDRANT_URL and that the cluster is running. (${msg.slice(0, 160)})`,
      502,
      err,
    );
  return new AppError("QDRANT_FAILED", `Qdrant ${what} failed: ${msg.slice(0, 300)}`, 502, err);
}

const docFilter = (docId: string) => ({ must: [{ key: "docId", match: { value: docId } }] });

export function createQdrantStore(env: Env): VectorStore {
  const client = new QdrantClient({ url: env.QDRANT_URL, apiKey: env.QDRANT_API_KEY, checkCompatibility: false });
  const collection = env.QDRANT_COLLECTION;
  let ready = false;

  async function run<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await withRetry(fn, { attempts: 3 });
    } catch (e) {
      throw mapError(e, what);
    }
  }

  return {
    async ensureCollection(dimensions) {
      if (ready) return;
      await run("collection check", async () => {
        const { exists } = await client.collectionExists(collection);
        if (!exists) {
          await client.createCollection(collection, {
            vectors: { size: dimensions, distance: "Cosine" },
          });
        } else {
          const info = await client.getCollection(collection);
          const vectors = info.config.params.vectors as { size?: number } | undefined;
          if (vectors?.size && vectors.size !== dimensions)
            throw new AppError(
              "QDRANT_FAILED",
              `Collection "${collection}" has ${vectors.size}-dim vectors but EMBEDDING_DIMENSIONS=${dimensions}. Use a new QDRANT_COLLECTION name or delete the collection.`,
              500,
            );
        }
        for (const [field, schema] of [
          ["docId", "keyword"],
          ["pageNumber", "integer"],
          ["sourceType", "keyword"],
        ] as const)
          await client.createPayloadIndex(collection, { field_name: field, field_schema: schema, wait: true }).catch(() => {});
      });
      ready = true;
    },

    async upsert(points: VectorPoint[]) {
      for (let i = 0; i < points.length; i += 64) {
        const batch = points.slice(i, i + 64);
        await run("upsert", () =>
          client.upsert(collection, {
            wait: true,
            points: batch.map((p) => ({ id: p.id, vector: p.vector, payload: p.payload as unknown as Record<string, unknown> })),
          }),
        );
      }
    },

    async search(vector, docId, limit): Promise<VectorHit[]> {
      const res = await run("search", () =>
        client.query(collection, { query: vector, limit, filter: docFilter(docId), with_payload: true }),
      );
      return res.points.map((r) => ({ id: String(r.id), score: r.score, payload: r.payload as unknown as ChunkPayload }));
    },

    async listDoc(docId) {
      const out: { id: string; payload: ChunkPayload }[] = [];
      let offset: string | number | Record<string, unknown> | null | undefined = undefined;
      do {
        const page: Awaited<ReturnType<typeof client.scroll>> = await run("scroll", () =>
          client.scroll(collection, { filter: docFilter(docId), limit: 256, with_payload: true, with_vector: false, offset }),
        );
        for (const p of page.points) out.push({ id: String(p.id), payload: p.payload as unknown as ChunkPayload });
        offset = page.next_page_offset as typeof offset;
      } while (offset !== null && offset !== undefined);
      return out;
    },

    async countDoc(docId) {
      const res = await run("count", () => client.count(collection, { filter: docFilter(docId), exact: true }));
      return res.count;
    },

    async deleteDoc(docId) {
      await run("delete", () => client.delete(collection, { wait: true, filter: docFilter(docId) }));
    },

    async deleteAllExcept(docId) {
      await run("delete", () =>
        client.delete(collection, { wait: true, filter: { must_not: [{ key: "docId", match: { value: docId } }] } }),
      );
    },
  };
}
