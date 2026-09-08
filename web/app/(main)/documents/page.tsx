"use client";

import { useCallback, useEffect, useState, useMemo } from "react";
import { FileGrid } from "@/components/files/FileGrid";
import { FileList } from "@/components/files/FileList";
import { FileGridSkeleton, FileListSkeleton } from "@/components/files/FileSkeletons";
import { MediaViewer, type MediaSibling } from "@/components/viewer/MediaViewer";
import type { FileNode, Thumbnail, Preview } from "@prisma/client";
import { useTopBar } from "@/components/layout/TopBarContext";
import { sortNodes } from "@/lib/utils";
import { useInfiniteNodes } from "@/hooks/useInfiniteNodes";
import { Loader2 } from "lucide-react";

type FileNodeWithThumbnail = FileNode & { contentIdentity: ({ thumbnail: Thumbnail | null; preview: Preview | null }) | null };

export default function DocumentsPage() {
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [viewer, setViewer] = useState<{
    node: FileNodeWithThumbnail;
    siblings: MediaSibling[];
  } | null>(null);
  const { searchQuery, searchGlobal, viewMode, setBreadcrumbs } = useTopBar();

  useEffect(() => {
    setBreadcrumbs([{ label: "Documents", href: "/documents" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/favorites?limit=500", { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => {
        const ids = (data.favorites ?? []).map(
          (f: { fileNodeId: string }) => f.fileNodeId
        );
        setFavoriteIds(new Set(ids));
      })
      .catch((err) => { if (err.name !== "AbortError") console.error(err); });
    return () => controller.abort();
  }, []);

  const { nodes, loading, loadingMore, hasMore, sentinelRef } =
    useInfiniteNodes<FileNodeWithThumbnail>("/api/files/type?type=document");

  const sortedNodes = useMemo(() => sortNodes(nodes), [nodes]);

  const filteredNodes = sortedNodes.filter(
    (n) => searchGlobal || !searchQuery || n.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const buildSiblings = (fromNodes: FileNodeWithThumbnail[]): MediaSibling[] =>
    fromNodes.map((fn) => ({
      id: fn.id,
      name: fn.name,
      relativePath: fn.relativePath,
      mimeType: fn.mimeType,
      cachePath: fn.contentIdentity?.preview?.cachePath ?? fn.contentIdentity?.thumbnail?.cachePath,
    }));

  const navigate = useCallback(
    (node: FileNodeWithThumbnail) => {
      const siblings = buildSiblings(filteredNodes);
      setViewer({ node, siblings });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredNodes]
  );

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

  if (loading) {
    return viewMode === "grid" ? <FileGridSkeleton /> : <FileListSkeleton />;
  }

  return (
    <>
      {viewMode === "grid" ? (
        <FileGrid
          nodes={filteredNodes}
          onNavigate={navigate}
          onFavorite={toggleFavorite}
          favoriteIds={favoriteIds}
          showPath
        />
      ) : (
        <FileList
          nodes={filteredNodes}
          onNavigate={navigate}
          onFavorite={toggleFavorite}
          favoriteIds={favoriteIds}
          showPath
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
    </>
  );
}
