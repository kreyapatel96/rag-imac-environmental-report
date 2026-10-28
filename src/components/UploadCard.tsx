"use client";

import { useRef, useState } from "react";
import type { DocumentManifest, IngestProgress } from "@/lib/client-types";

interface Props {
  hasDocument: boolean;
  disabled?: boolean;
  onIndexed: (doc: DocumentManifest) => void;
  fileLabel?: string;
}

export function UploadCard({ hasDocument, disabled, onIndexed, fileLabel }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [progress, setProgress] = useState<IngestProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const busy = progress !== null;

  async function upload(file: File) {
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
      setError("Please choose a PDF file.");
      return;
    }
    const body = new FormData();
    body.append("file", file);
    await run("/api/upload", { method: "POST", body }, file.name);
  }

  async function run(url: string, init: RequestInit, label: string) {
    setError(null);
    setFileName(label);
    setProgress({ stage: "validating", message: "Starting…", percent: 1 });
    try {
      const res = await fetch(url, init);
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error?.message ?? `Upload failed (HTTP ${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let finished = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line);
          if (ev.type === "progress") setProgress(ev);
          else if (ev.type === "error") throw new Error(ev.message);
          else if (ev.type === "done") {
            finished = true;
            onIndexed(ev.document);
          }
        }
      }
      if (!finished) throw new Error("The connection closed before processing finished. Your previous document (if any) is unchanged.");
    } catch (e) {
      setError((e as Error).message + (hasDocument ? " Your previous document is still active." : ""));
    } finally {
      setProgress(null);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <section className="rounded-2xl border border-line bg-card p-5 shadow-sm">
      <h2 className="text-base font-semibold">{hasDocument ? "Replace document" : "Upload document"}</h2>
      <p className="mt-1 text-sm text-muted">
        {hasDocument
          ? "The new PDF is validated and fully indexed first. Only then is the old one removed."
          : "Upload the Apple iMac Product Environmental Report (PDF)."}
      </p>

      <div
        role="button"
        tabIndex={0}
        aria-disabled={busy || disabled}
        onClick={() => !busy && !disabled && input.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !busy && !disabled && input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files?.[0];
          if (f && !busy && !disabled) void upload(f);
        }}
        className={`mt-4 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition ${
          drag ? "border-accent bg-accent-soft" : "border-line hover:border-accent"
        } ${busy || disabled ? "pointer-events-none opacity-60" : ""}`}
      >
        <div className="text-3xl" aria-hidden>
          📄
        </div>
        <p className="mt-2 text-sm font-medium">Drag &amp; drop a PDF here</p>
        <p className="text-xs text-muted">or click to choose a file</p>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])}
        />
      </div>

      {hasDocument && (
        <button
          type="button"
          disabled={busy || disabled}
          onClick={() => void run("/api/reindex", { method: "POST" }, fileLabel ?? "stored PDF")}
          className="mt-3 w-full rounded-xl border border-line px-3 py-2 text-sm font-medium transition hover:border-accent hover:bg-accent-soft disabled:opacity-50"
        >
          Re-analyse stored PDF (re-run chart vision)
        </button>
      )}

      {progress && (
        <div className="mt-4" aria-live="polite">
          <div className="flex justify-between text-xs text-muted">
            <span className="truncate pr-2">{fileName}</span>
            <span>{progress.percent}%</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${progress.percent}%` }} />
          </div>
          <p className="mt-2 text-sm">{progress.message}</p>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-bad-soft p-3 text-sm text-bad">
          {error}
        </p>
      )}
    </section>
  );
}
