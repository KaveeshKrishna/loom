"use client";

import { useEffect, useState } from "react";
import { FileGrid } from "@/components/files/FileGrid";
import { FileList } from "@/components/files/FileList";
import { MediaViewer, type MediaSibling } from "@/components/viewer/MediaViewer";
import { Loader2, Image as ImageIcon } from "lucide-react";
import type { FileNode, Thumbnail, Preview } from "@prisma/client";
import { useTopBar } from "@/components/layout/TopBarContext";

type FileNodeWithThumbnail = FileNode & { thumbnail: Thumbnail | null, preview: Preview | null };

export default function PhotosPage() {
  const [nodes, setNodes] = useState<FileNodeWithThumbnail[]>([]);
  const [loading, setLoading] = useState(true);
  const { viewMode, setBreadcrumbs, searchQuery, searchGlobal } = useTopBar();
  
  useEffect(() => {
    setBreadcrumbs([{ label: "Photos", href: "/photos" }]);
  }, [setBreadcrumbs]);

  const [viewer, setViewer] = useState<{
    node: FileNodeWithThumbnail;
    siblings: MediaSibling[];
  } | null>(null);

  useEffect(() => {
    fetch("/api/files/type?type=image")
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
          <ImageIcon size={20} className="text-violet-500" />
          <h1 className="text-lg font-semibold">Photos</h1>
        </div>
        <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">{filteredNodes.length} photos</p>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 size={24} className="animate-spin text-[hsl(var(--muted-foreground))]" />
        </div>
      ) : viewMode === "grid" ? (
        <FileGrid
          nodes={filteredNodes}
          onNavigate={(n) => {
            const siblings: MediaSibling[] = filteredNodes.map((fn) => ({
              id: fn.id, name: fn.name, relativePath: fn.relativePath,
              mimeType: fn.mimeType, cachePath: fn.preview?.cachePath || fn.thumbnail?.cachePath,
            }));
            setViewer({ node: n, siblings });
          }}
        />
      ) : (
        <FileList
          nodes={filteredNodes}
          onNavigate={(n) => {
            const siblings: MediaSibling[] = filteredNodes.map((fn) => ({
              id: fn.id, name: fn.name, relativePath: fn.relativePath,
              mimeType: fn.mimeType, cachePath: fn.preview?.cachePath || fn.thumbnail?.cachePath,
            }));
            setViewer({ node: n, siblings });
          }}
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
          onNavigateTo={(s) => {
            const fullNode = nodes.find((n) => n.id === s.id);
            if (fullNode) setViewer((v) => v ? { ...v, node: fullNode } : null);
          }}
        />
      )}
    </div>
  );
}
