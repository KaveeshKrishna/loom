"use client";

import { useEffect, useState } from "react";
import { FileList } from "@/components/files/FileList";
import { MediaViewer } from "@/components/viewer/MediaViewer";
import { Loader2, FileText } from "lucide-react";
import type { FileNode, Thumbnail, Preview } from "@prisma/client";

type FileNodeWithThumbnail = FileNode & { thumbnail: Thumbnail | null, preview: Preview | null };

const DOC_MIME_PREFIXES = ["application/pdf", "text/", "application/msword", "application/vnd."];

function isDocument(mimeType: string | null): boolean {
  if (!mimeType) return false;
  return DOC_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
}

export default function DocumentsPage() {
  const [nodes, setNodes] = useState<FileNodeWithThumbnail[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewer, setViewer] = useState<{ node: FileNodeWithThumbnail } | null>(null);

  useEffect(() => {
    fetch("/api/files/recent")
      .then((r) => r.json())
      .then((data) => {
        const docs = (data.nodes ?? []).filter(
          (n: FileNodeWithThumbnail) => isDocument(n.mimeType)
        );
        setNodes(docs);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div>
      <div className="px-6 py-5 border-b">
        <div className="flex items-center gap-2">
          <FileText size={20} className="text-blue-500" />
          <h1 className="text-lg font-semibold">Documents</h1>
        </div>
        <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">{nodes.length} documents</p>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 size={24} className="animate-spin text-[hsl(var(--muted-foreground))]" />
        </div>
      ) : (
        <FileList
          nodes={nodes}
          onNavigate={(n) => { if (n.type === "FILE") setViewer({ node: n }); }}
        />
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
