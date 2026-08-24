"use client";

import { useEffect, useState, useMemo } from "react";
import { FileGrid } from "@/components/files/FileGrid";
import { FileList } from "@/components/files/FileList";
import { MediaViewer, type MediaSibling } from "@/components/viewer/MediaViewer";
import { Loader2, Star } from "lucide-react";
import type { FileNode, Thumbnail, Preview } from "@prisma/client";
import { useTopBar } from "@/components/layout/TopBarContext";
import { sortNodes } from "@/lib/utils";

type FileNodeWithThumbnail = FileNode & { thumbnail: Thumbnail | null, preview: Preview | null };

export default function FavoritesPage() {
  const [nodes, setNodes] = useState<FileNodeWithThumbnail[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [viewer, setViewer] = useState<{ node: FileNodeWithThumbnail; siblings: MediaSibling[] } | null>(null);
  const { viewMode, setBreadcrumbs } = useTopBar();

  const load = () => {
    fetch("/api/favorites")
      .then((r) => r.json())
      .then((data) => {
        const items = (data.favorites ?? []).map((f: { fileNode: FileNodeWithThumbnail }) => f.fileNode);
        setNodes(items);
        setFavoriteIds(new Set(items.map((n: FileNodeWithThumbnail) => n.id)));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => { 
    setBreadcrumbs([{ label: "Favorites", href: "/favorites" }]);
    load(); 
  }, [setBreadcrumbs]);

  const toggleFavorite = async (nodeId: string) => {
    await fetch("/api/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileNodeId: nodeId }),
    });
    load();
  };

  const sortedNodes = useMemo(() => sortNodes(nodes), [nodes]);

  return (
    <div>
      <div className="px-6 py-5 border-b">
        <div className="flex items-center gap-2">
          <Star size={20} className="text-amber-500" fill="currentColor" />
          <h1 className="text-lg font-semibold">Favorites</h1>
        </div>
        <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">{nodes.length} items</p>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 size={24} className="animate-spin text-[hsl(var(--muted-foreground))]" />
        </div>
      ) : viewMode === "grid" ? (
        <FileGrid nodes={sortedNodes} onNavigate={(n) => {
          if (n.type !== "FILE") return;
          const siblings: MediaSibling[] = sortedNodes.filter(m => m.type === "FILE").map((fn) => ({
            id: fn.id, name: fn.name, relativePath: fn.relativePath,
            mimeType: fn.mimeType, cachePath: fn.preview?.cachePath || fn.thumbnail?.cachePath,
          }));
          setViewer({ node: n, siblings });
        }} onFavorite={toggleFavorite} favoriteIds={favoriteIds} />
      ) : (
        <FileList nodes={sortedNodes} onNavigate={(n) => {
          if (n.type !== "FILE") return;
          const siblings: MediaSibling[] = sortedNodes.filter(m => m.type === "FILE").map((fn) => ({
            id: fn.id, name: fn.name, relativePath: fn.relativePath,
            mimeType: fn.mimeType, cachePath: fn.preview?.cachePath || fn.thumbnail?.cachePath,
          }));
          setViewer({ node: n, siblings });
        }} onFavorite={toggleFavorite} favoriteIds={favoriteIds} />
      )}
      {viewer && (
        <MediaViewer
          relativePath={viewer.node.relativePath}
          cachePath={viewer.node.preview?.cachePath || viewer.node.thumbnail?.cachePath}
          name={viewer.node.name}
          mimeType={viewer.node.mimeType}
          onClose={() => setViewer(null)}
          siblings={viewer.siblings}
          currentId={viewer.node.id}
          onNavigateTo={(s) => {
            const fullNode = nodes.find((n) => n.id === s.id);
            if (fullNode) setViewer((v) => v ? { ...v, node: fullNode } : null);
          }}
        />
      )}
    </div>
  );
}
