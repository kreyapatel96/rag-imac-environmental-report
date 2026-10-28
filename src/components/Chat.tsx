"use client";

import { useEffect, useRef, useState } from "react";
import { SUGGESTED_QUESTIONS, type AnswerResult } from "@/lib/client-types";
import { AnswerView } from "./Evidence";

interface Turn {
  id: number;
  question: string;
  result?: AnswerResult;
  error?: string;
  loading: boolean;
}

export function Chat({ disabled, onViewPage }: { disabled: boolean; onViewPage: (p: number) => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const counter = useRef(0);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [turns]);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy || disabled) return;
    const id = ++counter.current;
    setTurns((t) => [...t, { id, question: q, loading: true }]);
    setText("");
    setBusy(true);
    try {
      const res = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error?.message ?? `Request failed (HTTP ${res.status})`);
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, loading: false, result: j } : x)));
    } catch (e) {
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, loading: false, error: (e as Error).message } : x)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex min-h-[32rem] flex-col rounded-2xl border border-line bg-card shadow-sm">
      <div className="border-b border-line p-4">
        <h2 className="text-base font-semibold">Ask the document</h2>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {SUGGESTED_QUESTIONS.map((q, i) => (
            <button
              key={q}
              type="button"
              disabled={busy || disabled}
              onClick={() => void ask(q)}
              className="rounded-full border border-line px-3 py-1.5 text-left text-xs transition hover:border-accent hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-50"
            >
              <b className="text-accent">Test {i + 1}</b> · {q}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto p-4" aria-live="polite">
        {turns.length === 0 && (
          <p className="py-10 text-center text-sm text-muted">
            {disabled ? "Upload a PDF to begin." : "Ask a question or use one of the test buttons above. Every answer shows the chunks it came from."}
          </p>
        )}
        {turns.map((t) => (
          <div key={t.id} className="space-y-3">
            <div className="ml-auto w-fit max-w-[90%] rounded-2xl bg-accent px-4 py-2 text-sm text-white dark:text-black">{t.question}</div>
            <div className="rounded-2xl border border-line p-4">
              {t.loading && <p className="animate-pulse text-sm text-muted">Retrieving evidence and verifying…</p>}
              {t.error && (
                <p role="alert" className="text-sm text-bad">
                  {t.error}
                </p>
              )}
              {t.result && <AnswerView result={t.result} onViewPage={onViewPage} />}
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>

      <form
        className="flex gap-2 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(text);
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={disabled}
          maxLength={1000}
          placeholder={disabled ? "Upload a document first" : "Ask about the report…"}
          aria-label="Question"
          className="min-w-0 flex-1 rounded-xl border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
        />
        <button type="submit" disabled={busy || disabled || !text.trim()} className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:text-black">
          Ask
        </button>
      </form>
    </section>
  );
}
