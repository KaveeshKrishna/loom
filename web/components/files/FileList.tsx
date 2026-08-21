"use client";

import { Folder, FileText, Image as ImageIcon, Video, Music, File, Star, Download, ChevronRight } from "lucide-react";
import { cn, formatBytes, formatDate, getFileCategory } from "@/lib/utils";
import type { FileNode, Thumbnail, Preview } from "@prisma/client";

type FileNodeWithThumbnail = FileNode & { thumbnail: Thumbnail | null, preview: Preview | null };

interface FileListProps {
  nodes: FileNodeWithThumbnail[];
  onNavigate: (node: FileNodeWithThumbnail) => void;
  onFavorite?: (nodeId: string) => void;
  favoriteIds?: Set<string>;
}

function FileIcon({ mimeType, type, size = 16 }: { mimeType: string | null; type: string; size?: number }) {
  if (type === "DIRECTORY") return <Folder size={size} className="text-[hsl(var(--primary))]" />;
  const cat = getFileCategory(mimeType);
  if (cat === "image") return <ImageIcon size={size} className="text-violet-500" />;
  if (cat === "video") return <Video size={size} className="text-rose-500" />;
  if (cat === "audio") return <Music size={size} className="text-amber-500" />;
  if (cat === "document") return <FileText size={size} className="text-blue-500" />;
  return <File size={size} className="text-[hsl(var(--muted-foreground))]" />;
}

export function FileList({ nodes, onNavigate, onFavorite, favoriteIds }: FileListProps) {
  if (nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-[hsl(var(--muted-foreground))]">
        <Folder size={48} strokeWidth={1} className="mb-3 opacity-40" />
        <p className="text-sm">This folder is empty</p>
      </div>
    );
  }

  const sorted = [...nodes].sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === "DIRECTORY" ? -1 : 1;
  });

  return (
    <div className="divide-y divide-[hsl(var(--border))]">
      {/* Header */}
      <div className="grid grid-cols-12 gap-2 px-4 py-2 text-xs font-medium text-[hsl(var(--muted-foreground))]">
        <span className="col-span-6">Name</span>
        <span className="col-span-2 hidden md:block">Modified</span>
        <span className="col-span-2 hidden sm:block">Size</span>
        <span className="col-span-2"></span>
      </div>
      {sorted.map((node) => (
        <div
          key={node.id}
          className="group grid grid-cols-12 gap-2 px-4 py-2.5 items-center hover:bg-[hsl(var(--accent)/0.5)] transition-colors cursor-pointer"
          onClick={() => onNavigate(node)}
          id={`file-row-${node.id}`}
        >
          <div className="col-span-6 flex items-center gap-2.5 min-w-0">
            <FileIcon mimeType={node.mimeType} type={node.type} />
            <span className="text-sm font-medium truncate">{node.name}</span>
            {node.type === "DIRECTORY" && (
              <ChevronRight size={14} className="ml-auto text-[hsl(var(--muted-foreground))] opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
            )}
          </div>
          <span className="col-span-2 hidden md:block text-xs text-[hsl(var(--muted-foreground))]">
            {formatDate(node.modifiedAt)}
          </span>
          <span className="col-span-2 hidden sm:block text-xs text-[hsl(var(--muted-foreground))]">
            {node.size != null && node.type === "FILE" ? formatBytes(node.size) : "—"}
          </span>
          <div className="col-span-2 flex items-center justify-end gap-1">
            {onFavorite && node.type === "FILE" && (
              <button
                id={`favorite-row-${node.id}`}
                onClick={(e) => { e.stopPropagation(); onFavorite(node.id); }}
                className={cn(
                  "p-1.5 rounded-md opacity-0 group-hover:opacity-100 transition-all",
                  favoriteIds?.has(node.id) ? "opacity-100 text-amber-500" : "text-[hsl(var(--muted-foreground))] hover:text-amber-500"
                )}
              >
                <Star size={13} fill={favoriteIds?.has(node.id) ? "currentColor" : "none"} />
              </button>
            )}
            {node.type === "FILE" && (
              <a
                id={`download-${node.id}`}
                href={`/api/files/serve?path=${encodeURIComponent(node.relativePath)}&download=1`}
                onClick={(e) => e.stopPropagation()}
                className="p-1.5 rounded-md opacity-0 group-hover:opacity-100 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-all"
              >
                <Download size={13} />
              </a>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
