import type { DocumentState } from "@/lib/client-types";

const fmtBytes = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

export function DocumentCard({ state }: { state: DocumentState | null }) {
  const doc = state?.document;
  return (
    <section className="rounded-2xl border border-line bg-card p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Active document</h2>
        {doc ? (
          state?.vectorStatus === "ok" ? (
            <Badge tone="ok">Indexed</Badge>
          ) : state?.vectorStatus === "unreachable" ? (
            <Badge tone="warn">Qdrant unreachable</Badge>
          ) : (
            <Badge tone="bad">Vectors missing</Badge>
          )
        ) : (
          <Badge tone="muted">None</Badge>
        )}
      </div>

      {!doc ? (
        <p className="mt-3 text-sm text-muted">No document yet. Upload a PDF to start asking questions.</p>
      ) : (
        <>
          <p className="mt-3 break-words text-sm font-medium">{doc.filename}</p>
          <p className="text-xs text-muted">
            {doc.pageCount} pages · {fmtBytes(doc.sizeBytes)} · indexed {new Date(doc.indexedAt).toLocaleString()}
          </p>
          {state?.vectorStatus === "missing" && (
            <p className="mt-3 rounded-lg bg-bad-soft p-2 text-xs text-bad">
              Qdrant holds {state.vectorCount ?? 0} of {doc.stats.chunks} expected chunks. Re-upload the PDF to rebuild the index.
            </p>
          )}
          <dl className="mt-4 grid grid-cols-2 gap-3">
            <Stat label="Chunks" value={doc.stats.chunks} />
            <Stat label="Structured facts" value={doc.stats.facts} />
            <Stat label="Footnotes" value={doc.stats.footnotes} />
            <Stat label="Pages analysed" value={doc.stats.pagesAnalyzed} />
          </dl>
          <div className="mt-4 flex flex-wrap gap-1.5">
            {Object.entries(doc.stats.bySourceType).map(([k, v]) => (
              <span key={k} className="rounded-full bg-bg px-2.5 py-1 text-xs text-muted">
                {k} <b className="text-ink">{v}</b>
              </span>
            ))}
          </div>
          <p className="mt-4 text-[11px] leading-relaxed text-muted">
            Mode: <b className="text-ink">{doc.stats.ingestMode}</b> · Gemini vision on {doc.stats.visionPages.length} page(s)
            {doc.stats.visionPages.length > 0 && ` (${compact(doc.stats.visionPages)})`}, local layout analysis on {doc.stats.localPages.length}.
            <br />
            Embeddings: {doc.stats.embeddingProvider} · {doc.stats.embeddingModel} ({doc.stats.embeddingDimensions}d) · Vision model: {doc.stats.visionModel} · Collection: {doc.collection}
          </p>
          {doc.stats.warnings.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 rounded-lg bg-warn-soft p-2 pl-6 text-xs text-warn">
              {doc.stats.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          <a href="/api/pdf" target="_blank" rel="noreferrer" className="mt-3 inline-block text-sm font-medium text-accent hover:underline">
            Open stored PDF ↗
          </a>
        </>
      )}
    </section>
  );
}

const compact = (xs: number[]) => (xs.length > 12 ? `${xs.slice(0, 12).join(", ")}…` : xs.join(", "));

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-bg p-3">
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="text-xl font-semibold">{value}</dd>
    </div>
  );
}

function Badge({ tone, children }: { tone: "ok" | "warn" | "bad" | "muted"; children: React.ReactNode }) {
  const cls = { ok: "bg-accent-soft text-accent", warn: "bg-warn-soft text-warn", bad: "bg-bad-soft text-bad", muted: "bg-bg text-muted" }[tone];
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}>{children}</span>;
}
