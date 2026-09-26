"use client";

/** Search across the whole library (ranked by relevance). */

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api } from "@/lib/client/api";
import type { LNode } from "@/lib/client/types";
import { FileBrowser } from "./FileBrowser";

export function GlobalSearchResults({ query, onClose }: { query: string; onClose: () => void }) {
  const [results, setResults] = useState<LNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const ctrl = new AbortController();
    setLoading(true);
    api<{ results: LNode[] }>(`/api/search?q=${encodeURIComponent(q)}&limit=200`, { signal: ctrl.signal })
      .then((d) => {
        setResults(d.results);
        setError(null);
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError({ status: 0, message: (e as Error).message });
      })
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
  }, [query]);

  return (
    <div>
      <div className="flex items-center justify-between px-4 pt-4">
        <h1 className="text-sm text-[hsl(var(--muted-foreground))]">
          Results for <span className="font-semibold text-[hsl(var(--foreground))]">“{query}”</span> everywhere
        </h1>
        <button onClick={onClose} className="p-1.5 rounded-md hover:bg-[hsl(var(--accent))]" aria-label="Close search">
          <X size={16} />
        </button>
      </div>
      <FileBrowser
        nodes={results ?? []}
        loading={loading && !results}
        error={error}
        showPath
        preserveOrder
        emptyState={<p className="py-24 text-center text-sm text-[hsl(var(--muted-foreground))]">No files or folders match “{query}”</p>}
      />
    </div>
  );
}
