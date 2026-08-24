"use client";

import { useEffect, useState } from "react";
import { FileList } from "@/components/files/FileList";
import { MediaViewer, type MediaSibling } from "@/components/viewer/MediaViewer";
import { Loader2, Clock } from "lucide-react";
import type { FileNode, Thumbnail, Preview } from "@prisma/client";

type FileNodeWithThumbnail = FileNode & { thumbnail: Thumbnail | null, preview: Preview | null };

export default function RecentPage() {
  const [nodes, setNodes] = useState<FileNodeWithThumbnail[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewer, setViewer] = useState<{ node: FileNodeWithThumbnail; siblings: MediaSibling[] } | null>(null);

  useEffect(() => {
    fetch("/api/files/recent")
      .then((r) => r.json())
      .then((data) => { setNodes(data.nodes ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  // Recent page should not be sorted alphabetically, we use the raw nodes which are ordered by updatedAt desc
  const sortedNodes = nodes;

  return (
    <div>
      <div className="px-6 py-5 border-b">
        <div className="flex items-center gap-2">
          <Clock size={20} className="text-[hsl(var(--primary))]" />
          <h1 className="text-lg font-semibold">Recent</h1>
        </div>
        <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">Recently modified files</p>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 size={24} className="animate-spin text-[hsl(var(--muted-foreground))]" />
        </div>
      ) : (
        <FileList nodes={sortedNodes} onNavigate={(n) => {
          if (n.type !== "FILE") return;
          const siblings: MediaSibling[] = sortedNodes.filter(m => m.type === "FILE").map((fn) => ({
            id: fn.id, name: fn.name, relativePath: fn.relativePath,
            mimeType: fn.mimeType, cachePath: fn.preview?.cachePath || fn.thumbnail?.cachePath,
          }));
          setViewer({ node: n, siblings });
        }} />
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
