"use client";

import { useEffect, useState } from "react";
import { FileGrid } from "@/components/files/FileGrid";
import { FileList } from "@/components/files/FileList";
import { MediaViewer } from "@/components/viewer/MediaViewer";
import { Loader2, Video as VideoIcon } from "lucide-react";
import type { FileNode, Thumbnail, Preview } from "@prisma/client";
import { useTopBar } from "@/components/layout/TopBarContext";

type FileNodeWithThumbnail = FileNode & { thumbnail: Thumbnail | null, preview: Preview | null };

export default function VideosPage() {
  const [nodes, setNodes] = useState<FileNodeWithThumbnail[]>([]);
  const [loading, setLoading] = useState(true);
  const { viewMode, setBreadcrumbs } = useTopBar();
  
  useEffect(() => {
    setBreadcrumbs([{ label: "Videos", href: "/videos" }]);
  }, [setBreadcrumbs]);

  const [viewer, setViewer] = useState<{
    node: FileNodeWithThumbnail;
    siblings: FileNodeWithThumbnail[];
  } | null>(null);

  useEffect(() => {
    fetch("/api/files/recent")
      .then((r) => r.json())
      .then((data) => {
        const videos = (data.nodes ?? []).filter(
          (n: FileNodeWithThumbnail) => n.mimeType?.startsWith("video/")
        );
        setNodes(videos);
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
          <VideoIcon size={20} className="text-rose-500" />
          <h1 className="text-lg font-semibold">Videos</h1>
        </div>
        <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">{nodes.length} videos</p>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 size={24} className="animate-spin text-[hsl(var(--muted-foreground))]" />
        </div>
      ) : viewMode === "grid" ? (
        <FileGrid
          nodes={nodes}
          onNavigate={(n) => setViewer({ node: n, siblings: nodes })}
        />
      ) : (
        <FileList
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
