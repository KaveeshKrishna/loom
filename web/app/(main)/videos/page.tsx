"use client";

import { useEffect, useState } from "react";
import { FileGrid } from "@/components/files/FileGrid";
import { FileList } from "@/components/files/FileList";
import { MediaViewer, type MediaSibling } from "@/components/viewer/MediaViewer";
import { Loader2, Video as VideoIcon } from "lucide-react";
import type { FileNode, Thumbnail, Preview } from "@prisma/client";
import { useTopBar } from "@/components/layout/TopBarContext";

type FileNodeWithThumbnail = FileNode & { thumbnail: Thumbnail | null, preview: Preview | null };

export default function VideosPage() {
  const [nodes, setNodes] = useState<FileNodeWithThumbnail[]>([]);
  const [loading, setLoading] = useState(true);
  const { viewMode, setBreadcrumbs, searchQuery, searchGlobal } = useTopBar();
  
  useEffect(() => {
    setBreadcrumbs([{ label: "Videos", href: "/videos" }]);
  }, [setBreadcrumbs]);

  const [viewer, setViewer] = useState<{
    node: FileNodeWithThumbnail;
    siblings: MediaSibling[];
  } | null>(null);

  useEffect(() => {
    fetch("/api/files/type?type=video")
      .then((r) => r.json())
      .then((data) => {
        setNodes(data.nodes ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const filteredNodes = nodes.filter(
    (n) => searchGlobal || !searchQuery || n.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div>
      <div className="px-6 py-5 border-b">
        <div className="flex items-center gap-2">
          <VideoIcon size={20} className="text-rose-500" />
          <h1 className="text-lg font-semibold">Videos</h1>
        </div>
        <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">{filteredNodes.length} videos</p>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 size={24} className="animate-spin text-[hsl(var(--muted-foreground))]" />
        </div>
      ) : viewMode === "grid" ? (
        <FileGrid
          nodes={filteredNodes}
          onNavigate={(n) => setViewer({ node: n, siblings: filteredNodes })}
        />
      ) : (
        <FileList
          nodes={filteredNodes}
          onNavigate={(n) => setViewer({ node: n, siblings: filteredNodes })}
        />
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
          onNavigateTo={(s) => setViewer((v) => v ? { ...v, node: { ...viewer.node, ...s } as FileNodeWithThumbnail } : null)}
        />
      )}
    </div>
  );
}
