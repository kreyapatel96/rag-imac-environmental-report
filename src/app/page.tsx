"use client";

import { useCallback, useEffect, useState } from "react";
import { Chat } from "@/components/Chat";
import { DocumentCard } from "@/components/DocumentCard";
import { PageViewer } from "@/components/PageViewer";
import { UploadCard } from "@/components/UploadCard";
import type { DocumentState } from "@/lib/client-types";

export default function Home() {
  const [state, setState] = useState<DocumentState | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewPage, setViewPage] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const h = await (await fetch("/api/health")).json();
      setProblems(h.problems ?? []);
      if (!h.ok) {
        // Without valid keys we can still show the local document, but not check Qdrant.
        setState({ document: null });
        return;
      }
      const res = await fetch("/api/document");
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error?.message ?? "Failed to load document status");
      setState(j);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const doc = state?.document ?? null;
  const ready = !!doc && state?.vectorStatus === "ok";

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">iMac Visual Document RAG</h1>
        <p className="mt-1 text-sm text-muted">
          Every page is read by Gemini vision, indexed in Qdrant Cloud, and answered with citations you can inspect.
        </p>
      </header>

      {problems.length > 0 && (
        <div role="alert" className="mb-6 rounded-2xl border border-warn bg-warn-soft p-4 text-sm text-warn">
          <b>Setup needed.</b> Add these to <code>.env.local</code> and restart <code>npm run dev</code>:
          <ul className="mt-1 list-disc pl-5">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {loadError && (
        <p role="alert" className="mb-6 rounded-2xl bg-bad-soft p-4 text-sm text-bad">
          {loadError}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
        <div className="space-y-6">
          <DocumentCard state={state} />
          <UploadCard
            hasDocument={!!doc}
            fileLabel={doc?.filename}
            disabled={problems.length > 0}
            onIndexed={() => {
              setViewPage(null);
              void refresh();
            }}
          />
        </div>
        <Chat key={doc?.docId ?? "none"} disabled={!ready} onViewPage={setViewPage} />
      </div>

      {viewPage !== null && doc && <PageViewer page={viewPage} pageCount={doc.pageCount} onClose={() => setViewPage(null)} onPage={setViewPage} />}
    </main>
  );
}
