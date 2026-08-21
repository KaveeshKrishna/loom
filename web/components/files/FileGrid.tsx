"use client";

import { Folder, FileText, Image as ImageIcon, Video, Music, File, Star } from "lucide-react";
import { cn, formatBytes, getFileCategory } from "@/lib/utils";
import type { FileNode, Thumbnail, Preview } from "@prisma/client";

type FileNodeWithThumbnail = FileNode & { thumbnail: Thumbnail | null, preview: Preview | null };

interface FileGridProps {
  nodes: FileNodeWithThumbnail[];
  onNavigate: (node: FileNodeWithThumbnail) => void;
  onFavorite?: (nodeId: string) => void;
  favoriteIds?: Set<string>;
}

function FileIcon({ mimeType, type }: { mimeType: string | null; type: string }) {
  if (type === "DIRECTORY") return <Folder size={24} className="text-[hsl(var(--primary))]" />;
  const cat = getFileCategory(mimeType);
  if (cat === "image") return <ImageIcon size={24} className="text-violet-500" />;
  if (cat === "video") return <Video size={24} className="text-rose-500" />;
  if (cat === "audio") return <Music size={24} className="text-amber-500" />;
  if (cat === "document") return <FileText size={24} className="text-blue-500" />;
  return <File size={24} className="text-[hsl(var(--muted-foreground))]" />;
}

export function FileGrid({ nodes, onNavigate, onFavorite, favoriteIds }: FileGridProps) {
  if (nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-[hsl(var(--muted-foreground))]">
        <Folder size={48} strokeWidth={1} className="mb-3 opacity-40" />
        <p className="text-sm">This folder is empty</p>
      </div>
    );
  }

  // Sort: directories first, then files alphabetically
  const sorted = [...nodes].sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === "DIRECTORY" ? -1 : 1;
  });

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 p-4">
      {sorted.map((node) => (
        <button
          key={node.id}
          id={`file-${node.id}`}
          onClick={() => onNavigate(node)}
          className="group relative flex flex-col gap-2 p-3 rounded-xl border bg-[hsl(var(--card))] hover:border-[hsl(var(--primary)/0.3)] hover:shadow-md transition-all duration-150 text-left animate-in-fade"
        >
          {/* Thumbnail or icon */}
          <div className="aspect-square rounded-lg bg-[hsl(var(--accent))] flex items-center justify-center overflow-hidden">
            {node.thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/cache/${node.thumbnail.cachePath}`}
                alt={node.name}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            ) : (
              <FileIcon mimeType={node.mimeType} type={node.type} />
            )}
          </div>

          {/* Name */}
          <p className="text-xs font-medium truncate leading-snug">{node.name}</p>

          {/* Size */}
          {node.size != null && node.type === "FILE" && (
            <p className="text-xs text-[hsl(var(--muted-foreground))]">{formatBytes(node.size)}</p>
          )}

          {/* Favorite button */}
          {onFavorite && node.type === "FILE" && (
            <button
              id={`favorite-${node.id}`}
              onClick={(e) => { e.stopPropagation(); onFavorite(node.id); }}
              className={cn(
                "absolute top-2 right-2 p-1 rounded-md opacity-0 group-hover:opacity-100 transition-all",
                favoriteIds?.has(node.id)
                  ? "opacity-100 text-amber-500"
                  : "text-[hsl(var(--muted-foreground))] hover:text-amber-500 bg-[hsl(var(--background)/0.8)]"
              )}
            >
              <Star size={13} fill={favoriteIds?.has(node.id) ? "currentColor" : "none"} />
            </button>
          )}
        </button>
      ))}
    </div>
  );
}
