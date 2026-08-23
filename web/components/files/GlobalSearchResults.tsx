"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FileList } from "@/components/files/FileList";
import { FileGrid } from "@/components/files/FileGrid";
import { MediaViewer, type MediaSibling } from "@/components/viewer/MediaViewer";
import { Loader2, Search } from "lucide-react";
import { useTopBar } from "@/components/layout/TopBarContext";
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
  const { viewMode } = useTopBar();
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!query) return;
    setLoading(true);
    fetch(`/api/search?q=${encodeURIComponent(query)}`)
      .then((r) => r.json())
      .then((d) => { setResults(d.results ?? []); setLoading(false); })
      .catch(() => setLoading(false));

    fetch("/api/favorites")
      .then((r) => r.json())
      .then((data) => {
        const ids = (data.favorites ?? []).map((f: { fileNodeId: string }) => f.fileNodeId);
        setFavoriteIds(new Set(ids));
      })
      .catch(() => {});
  }, [query]);

  const toggleFavorite = async (nodeId: string) => {
    const res = await fetch("/api/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileNodeId: nodeId }),
    });
    const data = await res.json();
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      if (data.favorited) next.add(nodeId);
      else next.delete(nodeId);
      return next;
    });
  };

  const handleNavigate = (n: FileNodeWithThumbnail) => {
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
  };

  return (
    <>
      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 size={24} className="animate-spin text-[hsl(var(--muted-foreground))]" />
        </div>
      ) : results.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-[hsl(var(--muted-foreground))]">
          <Search size={48} strokeWidth={1} className="mb-3 opacity-40" />
          <p className="text-sm">No results found for &ldquo;{query}&rdquo;</p>
        </div>
      ) : viewMode === "grid" ? (
        <FileGrid
          nodes={results}
          onNavigate={handleNavigate}
          onFavorite={toggleFavorite}
          favoriteIds={favoriteIds}
          showPath={true}
        />
      ) : (
        <FileList
          nodes={results}
          onNavigate={handleNavigate}
          onFavorite={toggleFavorite}
          favoriteIds={favoriteIds}
          showPath={true}
        />
      )}

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
    </>
  );
}
