"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { FileGrid } from "@/components/files/FileGrid";
import { FileList } from "@/components/files/FileList";
import { MediaViewer } from "@/components/viewer/MediaViewer";
import { Loader2 } from "lucide-react";
import type { FileNode, Thumbnail, Preview } from "@prisma/client";

type FileNodeWithThumbnail = FileNode & { thumbnail: Thumbnail | null, preview: Preview | null };

export default function FilesPage() {
  const params = useParams();
  const router = useRouter();
  const pathSegments = Array.isArray(params.path)
    ? params.path.map(decodeURIComponent)
    : params.path
    ? [decodeURIComponent(params.path as string)]
    : [];
  const currentPath = pathSegments.join("/");

  const [nodes, setNodes] = useState<FileNodeWithThumbnail[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode] = useState<"grid" | "list">("grid");
  const [viewer, setViewer] = useState<{
    node: FileNodeWithThumbnail;
    siblings: FileNodeWithThumbnail[];
  } | null>(null);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setLoading(true);
    fetch(`/api/files?path=${encodeURIComponent(currentPath)}`)
      .then((r) => r.json())
      .then((data) => {
        setNodes(data.children ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));

    fetch("/api/favorites")
      .then((r) => r.json())
      .then((data) => {
        const ids = (data.favorites ?? []).map(
          (f: { fileNodeId: string }) => f.fileNodeId
        );
        setFavoriteIds(new Set(ids));
      })
      .catch(() => {});
  }, [currentPath]);

  const navigate = useCallback(
    (node: FileNodeWithThumbnail) => {
      if (node.type === "DIRECTORY") {
        router.push(`/files/${node.relativePath}`);
      } else {
        const siblings = nodes.filter((n) => n.type === "FILE");
        setViewer({ node, siblings });
      }
    },
    [nodes, router]
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

  const viewerIndex = viewer
    ? viewer.siblings.findIndex((n) => n.id === viewer.node.id)
    : -1;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 size={24} className="animate-spin text-[hsl(var(--muted-foreground))]" />
      </div>
    );
  }

  return (
    <>
      {viewMode === "grid" ? (
        <FileGrid
          nodes={nodes}
          onNavigate={navigate}
          onFavorite={toggleFavorite}
          favoriteIds={favoriteIds}
        />
      ) : (
        <FileList
          nodes={nodes}
          onNavigate={navigate}
          onFavorite={toggleFavorite}
          favoriteIds={favoriteIds}
        />
      )}

      {viewer && (
        <MediaViewer
          relativePath={viewer.node.relativePath}
          cachePath={viewer.node.preview?.cachePath || viewer.node.thumbnail?.cachePath}
          name={viewer.node.name}
          mimeType={viewer.node.mimeType}
          onClose={() => setViewer(null)}
          hasPrev={viewerIndex > 0}
          hasNext={viewerIndex < viewer.siblings.length - 1}
          onPrev={() =>
            setViewer((v) =>
              v ? { ...v, node: v.siblings[viewerIndex - 1] } : null
            )
          }
          onNext={() =>
            setViewer((v) =>
              v ? { ...v, node: v.siblings[viewerIndex + 1] } : null
            )
          }
        />
      )}
    </>
  );
}
