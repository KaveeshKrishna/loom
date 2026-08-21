"use client";

import { useEffect, useState } from "react";
import { FileGrid } from "@/components/files/FileGrid";
import { MediaViewer } from "@/components/viewer/MediaViewer";
import { Loader2, Star } from "lucide-react";
import type { FileNode, Thumbnail, Preview } from "@prisma/client";

type FileNodeWithThumbnail = FileNode & { thumbnail: Thumbnail | null, preview: Preview | null };

export default function FavoritesPage() {
  const [nodes, setNodes] = useState<FileNodeWithThumbnail[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [viewer, setViewer] = useState<{ node: FileNodeWithThumbnail } | null>(null);

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

  useEffect(() => { load(); }, []);

  const toggleFavorite = async (nodeId: string) => {
    await fetch("/api/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileNodeId: nodeId }),
    });
    load();
  };

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
      ) : (
        <FileGrid nodes={nodes} onNavigate={(n) => n.type === "FILE" && setViewer({ node: n })} onFavorite={toggleFavorite} favoriteIds={favoriteIds} />
      )}
      {viewer && (
        <MediaViewer
          relativePath={viewer.node.relativePath}
          cachePath={viewer.node.preview?.cachePath || viewer.node.thumbnail?.cachePath}
          name={viewer.node.name}
          mimeType={viewer.node.mimeType}
          onClose={() => setViewer(null)}
          hasPrev={false}
          hasNext={false}
        />
      )}
    </div>
  );
}
