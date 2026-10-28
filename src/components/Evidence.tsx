"use client";

import { useState } from "react";
import { describeFact } from "@/lib/facts";
import type { AnswerResult, Citation, RetrievedChunk } from "@/lib/client-types";

const TYPE_STYLE: Record<string, string> = {
  chart: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  table: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  paragraph: "bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200",
  callout: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  footnote: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
};

export function AnswerView({ result, onViewPage }: { result: AnswerResult; onViewPage: (page: number) => void }) {
  const tone =
    result.status === "answered" ? "bg-accent-soft text-accent" : result.status === "partial" ? "bg-warn-soft text-warn" : "bg-bad-soft text-bad";
  return (
    <div className="space-y-4">
      <div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>
          {result.status === "answered" ? "Verified against evidence" : result.status === "partial" ? "Partially verified" : "Cannot verify"}
        </span>
        <p className="mt-3 whitespace-pre-wrap text-[15px] leading-relaxed">{result.answer}</p>
      </div>

      {result.claims.length > 0 && (
        <div className="rounded-xl border border-accent/40 bg-accent-soft p-3 text-sm">
          <b>Supported claim{result.claims.length > 1 ? "s" : ""}</b>
          <ul className="mt-1 space-y-2">
            {result.claims.map((c, i) => (
              <li key={i}>
                <span className="font-medium">{c.statement}</span>
                <span className="ml-2 font-mono text-xs text-muted">{c.chunkId}</span>
                <p className="text-xs text-muted">“{c.claim}”</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.footnotes.length > 0 && (
        <div className="rounded-xl border border-warn/50 bg-warn-soft p-3 text-sm text-ink">
          <b className="text-warn">Footnotes that qualify this answer</b>
          <ul className="mt-1 space-y-2">
            {result.footnotes.map((f, i) => (
              <li key={i}>
                <span className="font-medium">[{f.marker}]</span> {f.text}
                <p className="text-xs text-muted">
                  {f.page ? `page ${f.page} · ` : ""}
                  {f.chunkId && <span className="font-mono">{f.chunkId}</span>} · applies to {f.appliesTo.join(", ")}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.values.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-left text-sm">
            <thead className="bg-bg text-xs text-muted">
              <tr>
                <th className="px-3 py-2">Value</th>
                <th className="px-3 py-2">Printed</th>
                <th className="px-3 py-2">Page</th>
                <th className="px-3 py-2">Chunk</th>
                <th className="px-3 py-2">Check</th>
              </tr>
            </thead>
            <tbody>
              {result.values.map((v, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="px-3 py-2">{v.label}</td>
                  <td className="px-3 py-2 font-mono">
                    {v.value} {v.unit}
                  </td>
                  <td className="px-3 py-2">{v.page ?? "–"}</td>
                  <td className="px-3 py-2 font-mono text-xs">{v.chunkId}</td>
                  <td className="px-3 py-2">{v.verified ? "✓ value + unit found in chunk" : `✗ ${v.note ?? "not found"}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {result.calculations.map((c, i) => (
        <div key={i} className="rounded-xl border border-line bg-bg p-3 text-sm">
          <p className="font-medium">Computed: {c.label}</p>
          {c.error ? (
            <p className="text-bad">{c.error}</p>
          ) : (
            <p className="mt-1 font-mono">
              {c.formula} = <b>{c.result}</b> {c.unit}
            </p>
          )}
          <ul className="mt-1 text-xs text-muted">
            {c.inputs.map((inp, j) => (
              <li key={j}>
                {inp.label}: {inp.value} {inp.unit} ({inp.chunkId}) {inp.verified ? "✓" : "✗ unverified"}
              </li>
            ))}
          </ul>
          {c.reportedResult && (
            <p className="mt-1 text-xs text-muted">
              Document reports {c.reportedResult.value} {c.reportedResult.unit} — {c.matchesReported ? "matches" : "does not match"}.
            </p>
          )}
        </div>
      ))}

      {result.caveats.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          {result.caveats.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      )}
      {result.warnings.length > 0 && (
        <div className="rounded-xl bg-warn-soft p-3 text-sm text-warn" role="status">
          <b>Verification notes</b>
          <ul className="mt-1 list-disc pl-5">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="text-sm font-semibold">Sources ({result.citations.length})</h3>
        <div className="mt-2 space-y-2">
          {result.citations.length === 0 && <p className="text-sm text-muted">No verified citations.</p>}
          {result.citations.map((c) => (
            <CitationPanel key={c.chunk.chunkId} citation={c} onViewPage={onViewPage} defaultOpen />
          ))}
        </div>
      </div>

      {result.otherRetrieved.length > 0 && (
        <details className="rounded-xl border border-line">
          <summary className="cursor-pointer px-3 py-2 text-sm text-muted">
            Other retrieved chunks, not cited ({result.otherRetrieved.length})
          </summary>
          <div className="space-y-2 p-3">
            {result.otherRetrieved.map((c) => (
              <ChunkBody key={c.chunkId} chunk={c} onViewPage={onViewPage} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function CitationPanel({ citation, onViewPage, defaultOpen }: { citation: Citation; onViewPage: (p: number) => void; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const { chunk } = citation;
  return (
    <div className="rounded-xl border border-line">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-sm"
      >
        <span className="font-medium">Page {chunk.pageNumber}</span>
        <TypeBadge type={chunk.sourceType} />
        <span className="font-mono text-xs text-muted">{chunk.chunkId}</span>
        <span className="min-w-0 flex-1 truncate text-muted">{chunk.label}</span>
        <span aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="border-t border-line p-3">
          {citation.quote && (
            <p className="mb-2 text-xs text-muted">
              Model quote: “{citation.quote}” — {citation.quoteVerified ? "✓ every word found in the chunk (spacing, case and footnote numbers ignored)" : "✗ does not match the chunk"}
            </p>
          )}
          {citation.supporting.length > 0 && (
            <div className="mb-2 rounded-lg border border-accent/40 bg-accent-soft p-2 text-sm">
              <b className="text-xs uppercase tracking-wide text-accent">Evidence sentence{citation.supporting.length > 1 ? "s" : ""}</b>
              {citation.supporting.map((t, i) => (
                <p key={i}>“{t}”</p>
              ))}
            </div>
          )}
          <ChunkBody chunk={chunk} onViewPage={onViewPage} />
        </div>
      )}
    </div>
  );
}

function ChunkBody({ chunk, onViewPage }: { chunk: RetrievedChunk; onViewPage: (p: number) => void }) {
  return (
    <div className="rounded-lg bg-bg p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <TypeBadge type={chunk.sourceType} />
        <span>
          chunk ID <b className="font-mono text-ink">{chunk.chunkId}</b>
        </span>
        <span>
          point <span className="font-mono">{chunk.pointId}</span>
        </span>
        <span>origin: {chunk.origin}</span>
        <span>
          rank: vector {chunk.vectorRank ?? "–"} / lexical {chunk.lexicalRank ?? "–"}
        </span>
        <button type="button" onClick={() => onViewPage(chunk.pageNumber)} className="ml-auto font-medium text-accent hover:underline">
          View page {chunk.pageNumber}
        </button>
      </div>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed">{chunk.text}</pre>
      {chunk.labels.length > 0 && (
        <p className="mt-2 text-xs text-muted">
          <b>Labels:</b> {chunk.labels.join(" · ")}
        </p>
      )}
      {chunk.facts.length > 0 && (
        <p className="mt-1 text-xs text-muted">
          <b>Extracted facts:</b> {chunk.facts.map(describeFact).join(" · ")}
        </p>
      )}
      {chunk.footnotes.length > 0 && (
        <div className="mt-2 rounded-md border border-line p-2 text-xs">
          <b>Supporting footnotes</b>
          <ul className="mt-1 space-y-1">
            {chunk.footnotes.map((f) => (
              <li key={f.marker}>
                [{f.marker}] {f.text} {f.chunkId && <span className="font-mono text-muted">({f.chunkId})</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {chunk.referencedBy.length > 0 && (
        <p className="mt-1 text-xs text-muted">Referenced by: {chunk.referencedBy.join(", ")}</p>
      )}
    </div>
  );
}

function TypeBadge({ type }: { type: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${TYPE_STYLE[type] ?? TYPE_STYLE.paragraph}`}>{type}</span>;
}
