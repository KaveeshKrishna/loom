"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState, Suspense } from "react";
import { FileList } from "@/components/files/FileList";
import { MediaViewer } from "@/components/viewer/MediaViewer";
import { Loader2, Search } from "lucide-react";
import type { FileNode, Thumbnail, Preview } from "@prisma/client";

type FileNodeWithThumbnail = FileNode & { thumbnail: Thumbnail | null, preview: Preview | null };

function SearchResults() {
  const searchParams = useSearchParams();
  const q = searchParams.get("q") ?? "";
  const [results, setResults] = useState<FileNodeWithThumbnail[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewer, setViewer] = useState<FileNodeWithThumbnail | null>(null);

  useEffect(() => {
    if (!q) return;
    setLoading(true);
    fetch(`/api/search?q=${encodeURIComponent(q)}`)
      .then((r) => r.json())
      .then((d) => { setResults(d.results ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [q]);

  return (
    <div>
      <div className="px-6 py-5 border-b">
        <div className="flex items-center gap-2">
          <Search size={20} className="text-[hsl(var(--primary))]" />
          <h1 className="text-lg font-semibold">
            {q ? `Results for "${q}"` : "Search"}
          </h1>
        </div>
        {!loading && q && (
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">
            {results.length} {results.length === 1 ? "result" : "results"}
          </p>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 size={24} className="animate-spin text-[hsl(var(--muted-foreground))]" />
        </div>
      ) : !q ? (
        <div className="flex flex-col items-center justify-center py-24 text-[hsl(var(--muted-foreground))]">
          <Search size={48} strokeWidth={1} className="mb-3 opacity-40" />
          <p className="text-sm">Enter a search term to find files.</p>
        </div>
      ) : results.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-[hsl(var(--muted-foreground))]">
          <Search size={48} strokeWidth={1} className="mb-3 opacity-40" />
          <p className="text-sm">No results found for &ldquo;{q}&rdquo;</p>
        </div>
      ) : (
        <FileList
          nodes={results}
          onNavigate={(n) => { if (n.type === "FILE") setViewer(n); }}
        />
      )}

      {viewer && (
        <MediaViewer
          relativePath={viewer.relativePath}
          name={viewer.name}
          mimeType={viewer.mimeType}
          onClose={() => setViewer(null)}
          hasPrev={false}
          hasNext={false}
        />
      )}
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center py-24"><Loader2 size={24} className="animate-spin text-[hsl(var(--muted-foreground))]" /></div>}>
      <SearchResults />
    </Suspense>
  );
}
