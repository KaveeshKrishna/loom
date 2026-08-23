"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FileList } from "@/components/files/FileList";
import { MediaViewer, type MediaSibling } from "@/components/viewer/MediaViewer";
import { Loader2, Search, X } from "lucide-react";
import type { FileNode, Thumbnail, Preview } from "@prisma/client";

type FileNodeWithThumbnail = FileNode & { thumbnail: Thumbnail | null, preview: Preview | null };

interface GlobalSearchResultsProps {
  query: string;
  onClose: () => void;
}

export function GlobalSearchResults({ query, onClose }: GlobalSearchResultsProps) {
  const router = useRouter();
  const [results, setResults] = useState<FileNodeWithThumbnail[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewer, setViewer] = useState<{ node: FileNodeWithThumbnail; siblings: MediaSibling[] } | null>(null);

  useEffect(() => {
    if (!query) return;
    setLoading(true);
    fetch(`/api/search?q=${encodeURIComponent(query)}`)
      .then((r) => r.json())
      .then((d) => { setResults(d.results ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [query]);

  return (
    <div className="flex flex-col h-full bg-[hsl(var(--background))] animate-in-fade relative z-10">
      <div className="px-6 py-5 border-b flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Search size={20} className="text-[hsl(var(--primary))]" />
            <h1 className="text-lg font-semibold">
              Results for &ldquo;{query}&rdquo;
            </h1>
          </div>
          {!loading && query && (
            <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">
              {results.length} {results.length === 1 ? "result" : "results"}
            </p>
          )}
        </div>
        <button
          onClick={onClose}
          className="p-2 rounded-lg hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))] transition-colors"
          title="Close search"
        >
          <X size={20} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 size={24} className="animate-spin text-[hsl(var(--muted-foreground))]" />
          </div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-[hsl(var(--muted-foreground))]">
            <Search size={48} strokeWidth={1} className="mb-3 opacity-40" />
            <p className="text-sm">No results found for &ldquo;{query}&rdquo;</p>
          </div>
        ) : (
          <FileList
            nodes={results}
            onNavigate={(n) => { 
              if (n.type === "FILE") {
                const fileResults = results.filter(r => r.type === "FILE");
                const siblings: MediaSibling[] = fileResults.map((fn) => ({
                  id: fn.id, name: fn.name, relativePath: fn.relativePath,
                  mimeType: fn.mimeType, cachePath: fn.preview?.cachePath || fn.thumbnail?.cachePath,
                }));
                setViewer({ node: n, siblings });
              } else if (n.type === "DIRECTORY") {
                onClose();
                router.push(`/files/${n.relativePath}`);
              }
            }}
            showPath={true}
          />
        )}
      </div>

      {viewer && (
        <MediaViewer
          relativePath={viewer.node.relativePath}
          name={viewer.node.name}
          mimeType={viewer.node.mimeType}
          cachePath={viewer.node.preview?.cachePath || viewer.node.thumbnail?.cachePath}
          onClose={() => setViewer(null)}
          siblings={viewer.siblings}
          currentId={viewer.node.id}
          onNavigateTo={(s) => setViewer((v) => v ? { ...v, node: { ...viewer.node, ...s } as FileNodeWithThumbnail } : null)}
        />
      )}
    </div>
  );
}
