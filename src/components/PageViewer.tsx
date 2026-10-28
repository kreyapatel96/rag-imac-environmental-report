"use client";

import { useEffect, useState } from "react";

export function PageViewer({ page, pageCount, onClose, onPage }: { page: number; pageCount: number; onClose: () => void; onPage: (p: number) => void }) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div role="dialog" aria-modal="true" aria-label={`PDF page ${page}`} className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="flex max-h-full w-full max-w-3xl flex-col rounded-2xl bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-4 py-2 text-sm">
          <div className="flex items-center gap-2">
            <button type="button" disabled={page <= 1} onClick={() => { setState("loading"); onPage(page - 1); }} className="rounded px-2 py-1 hover:bg-bg disabled:opacity-30">
              ←
            </button>
            <span>
              Page {page} / {pageCount}
            </span>
            <button type="button" disabled={page >= pageCount} onClick={() => { setState("loading"); onPage(page + 1); }} className="rounded px-2 py-1 hover:bg-bg disabled:opacity-30">
              →
            </button>
          </div>
          <div className="flex items-center gap-3">
            <a href={`/api/pdf#page=${page}`} target="_blank" rel="noreferrer" className="text-accent hover:underline">
              Open PDF ↗
            </a>
            <button type="button" onClick={onClose} className="rounded px-2 py-1 hover:bg-bg" aria-label="Close">
              ✕
            </button>
          </div>
        </div>
        <div className="overflow-auto bg-white p-2">
          {state === "loading" && <p className="p-8 text-center text-sm text-zinc-500">Rendering page…</p>}
          {state === "error" && <p className="p-8 text-center text-sm text-red-600">Could not load this page image.</p>}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={page}
            src={`/api/pages/${page}`}
            alt={`PDF page ${page}`}
            className={`mx-auto h-auto max-w-full ${state === "ok" ? "" : "hidden"}`}
            onLoad={() => setState("ok")}
            onError={() => setState("error")}
          />
        </div>
      </div>
    </div>
  );
}
