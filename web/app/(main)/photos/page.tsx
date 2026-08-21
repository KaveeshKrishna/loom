"use client";

import { useEffect, useState } from "react";
import { FileGrid } from "@/components/files/FileGrid";
import { MediaViewer } from "@/components/viewer/MediaViewer";
import { Loader2, Image as ImageIcon } from "lucide-react";
import type { FileNode, Thumbnail, Preview } from "@prisma/client";

type FileNodeWithThumbnail = FileNode & { thumbnail: Thumbnail | null, preview: Preview | null };

export default function PhotosPage() {
  const [nodes, setNodes] = useState<FileNodeWithThumbnail[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewer, setViewer] = useState<{
    node: FileNodeWithThumbnail;
    siblings: FileNodeWithThumbnail[];
  } | null>(null);

  useEffect(() => {
    fetch("/api/files/recent")
      .then((r) => r.json())
      .then((data) => {
        const photos = (data.nodes ?? []).filter(
          (n: FileNodeWithThumbnail) => n.mimeType?.startsWith("image/")
        );
        setNodes(photos);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const viewerIndex = viewer
    ? viewer.siblings.findIndex((n) => n.id === viewer.node.id)
    : -1;

  return (
    <div>
      <div className="px-6 py-5 border-b">
        <div className="flex items-center gap-2">
          <ImageIcon size={20} className="text-violet-500" />
          <h1 className="text-lg font-semibold">Photos</h1>
        </div>
        <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">{nodes.length} photos</p>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 size={24} className="animate-spin text-[hsl(var(--muted-foreground))]" />
        </div>
      ) : (
        <FileGrid
          nodes={nodes}
          onNavigate={(n) => setViewer({ node: n, siblings: nodes })}
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
          onPrev={() => setViewer((v) => v ? { ...v, node: v.siblings[viewerIndex - 1] } : null)}
          onNext={() => setViewer((v) => v ? { ...v, node: v.siblings[viewerIndex + 1] } : null)}
        />
      )}
    </div>
  );
}
