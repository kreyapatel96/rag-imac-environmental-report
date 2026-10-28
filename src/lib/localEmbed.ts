import path from "node:path";

/** bge models expect this prefix on queries (not on documents) for retrieval. */
const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

type Extractor = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;

const g = globalThis as unknown as { __imacExtractors?: Map<string, Promise<Extractor>> };

function load(model: string, cacheDir: string): Promise<Extractor> {
  g.__imacExtractors ??= new Map();
  let p = g.__imacExtractors.get(model);
  if (!p) {
    p = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.cacheDir = cacheDir;
      return (await pipeline("feature-extraction", model, { dtype: "q8" })) as unknown as Extractor;
    })();
    p.catch(() => g.__imacExtractors?.delete(model)); // allow retry after a failed download
    g.__imacExtractors.set(model, p);
  }
  return p;
}

/** Free, offline embeddings (first run downloads the model once into DATA_DIR/models). */
export function createLocalEmbedder(model: string, dataDir: string, expectedDims: number) {
  const cacheDir = path.join(dataDir, "models");
  return async function embed(texts: string[], task: "document" | "query"): Promise<number[][]> {
    let extractor: Extractor;
    try {
      extractor = await load(model, cacheDir);
    } catch (e) {
      throw new Error(`Could not load local embedding model "${model}" (needs internet on first run): ${(e as Error).message}`);
    }
    const input = task === "query" && /bge/i.test(model) ? texts.map((t) => BGE_QUERY_PREFIX + t) : texts;
    const out: number[][] = [];
    for (let i = 0; i < input.length; i += 16) {
      const res = await extractor(input.slice(i, i + 16), { pooling: "mean", normalize: true });
      const [n, d] = res.dims;
      if (d !== expectedDims)
        throw new Error(`Local model "${model}" produces ${d}-dim vectors but EMBEDDING_DIMENSIONS=${expectedDims}. Remove EMBEDDING_DIMENSIONS or set it to ${d}.`);
      for (let r = 0; r < n; r++) out.push(Array.from(res.data.subarray(r * d, (r + 1) * d)));
    }
    return out;
  };
}
