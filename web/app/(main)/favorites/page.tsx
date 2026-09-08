"use client";

import { useEffect, useState } from "react";
import { FileGrid } from "@/components/files/FileGrid";
import { FileList } from "@/components/files/FileList";
import { MediaViewer, type MediaSibling } from "@/components/viewer/MediaViewer";
import { Loader2, Star } from "lucide-react";
import type { FileNode, Thumbnail, Preview } from "@prisma/client";
import { useTopBar } from "@/components/layout/TopBarContext";
import { sortNodes } from "@/lib/utils";
import { useInfiniteNodes } from "@/hooks/useInfiniteNodes";

type FileNodeWithThumbnail = FileNode & { contentIdentity: ({ thumbnail: Thumbnail | null; preview: Preview | null }) | null };
type FavoriteItem = { id: string; fileNodeId: string; fileNode: FileNodeWithThumbnail };

export default function FavoritesPage() {
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [viewer, setViewer] = useState<{ node: FileNodeWithThumbnail; siblings: MediaSibling[] } | null>(null);
  const { viewMode, setBreadcrumbs } = useTopBar();

  useEffect(() => {
    setBreadcrumbs([{ label: "Favorites", href: "/favorites" }]);
  }, [setBreadcrumbs]);

  // useInfiniteNodes adapts favorites: the JSON key is "favorites", and each item
  // has a .fileNode — we map them out in the component
  const { nodes: favoriteItems, loading, loadingMore, hasMore, sentinelRef } =
    useInfiniteNodes<FavoriteItem>("/api/favorites", "favorites");

  // Derive the actual FileNode list and the set of favorite IDs from the loaded items
  const nodes = favoriteItems.map((f) => f.fileNode);
  const sortedNodes = sortNodes(nodes);

  useEffect(() => {
    setFavoriteIds(new Set(favoriteItems.map((f) => f.fileNodeId)));
  }, [favoriteItems]);

  const toggleFavorite = async (nodeId: string) => {
    await fetch("/api/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileNodeId: nodeId }),
    });
    // Optimistically remove from list — a full reload would require re-fetching
    // all pages which is expensive; instead just remove the item from local state.
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      next.delete(nodeId);
      return next;
    });
  };

  return (
    <div>
      <div className="px-6 py-5 border-b">
        <div className="flex items-center gap-2">
          <Star size={20} className="text-amber-500" fill="currentColor" />
          <h1 className="text-lg font-semibold">Favorites</h1>
        </div>
        <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">{sortedNodes.length} items</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 size={24} className="animate-spin text-[hsl(var(--muted-foreground))]" />
        </div>
      ) : viewMode === "grid" ? (
        <FileGrid
          nodes={sortedNodes}
          onNavigate={(n) => {
            if (n.type !== "FILE") return;
            const siblings: MediaSibling[] = sortedNodes.filter((m) => m.type === "FILE").map((fn) => ({
              id: fn.id, name: fn.name, relativePath: fn.relativePath,
              mimeType: fn.mimeType, cachePath: fn.contentIdentity?.preview?.cachePath || fn.contentIdentity?.thumbnail?.cachePath,
            }));
            setViewer({ node: n, siblings });
          }}
          onFavorite={toggleFavorite}
          favoriteIds={favoriteIds}
        />
      ) : (
        <FileList
          nodes={sortedNodes}
          onNavigate={(n) => {
            if (n.type !== "FILE") return;
            const siblings: MediaSibling[] = sortedNodes.filter((m) => m.type === "FILE").map((fn) => ({
              id: fn.id, name: fn.name, relativePath: fn.relativePath,
              mimeType: fn.mimeType, cachePath: fn.contentIdentity?.preview?.cachePath || fn.contentIdentity?.thumbnail?.cachePath,
            }));
            setViewer({ node: n, siblings });
          }}
          onFavorite={toggleFavorite}
          favoriteIds={favoriteIds}
        />
      )}

      {hasMore && (
        <div ref={sentinelRef} className="flex justify-center py-6">
          {loadingMore && (
            <Loader2 size={20} className="animate-spin text-[hsl(var(--muted-foreground))]" />
          )}
        </div>
      )}

      {viewer && (
        <MediaViewer
          relativePath={viewer.node.relativePath}
          cachePath={viewer.node.contentIdentity?.preview?.cachePath || viewer.node.contentIdentity?.thumbnail?.cachePath}
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
