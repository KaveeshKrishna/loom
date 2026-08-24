"use client";
import React, { useRef } from "react";

import { Folder, FileText, Image as ImageIcon, Video, Music, File, Star } from "lucide-react";
import { cn, formatBytes, getFileCategory } from "@/lib/utils";
import type { FileNode, Thumbnail, Preview } from "@prisma/client";
import { FolderMenu } from "./FolderMenu";
import { useTopBar } from "../layout/TopBarContext";

type FileNodeWithThumbnail = FileNode & { thumbnail: Thumbnail | null, preview: Preview | null };

interface FileGridProps {
  nodes: FileNodeWithThumbnail[];
  onNavigate: (node: FileNodeWithThumbnail) => void;
  onFavorite?: (nodeId: string) => void;
  favoriteIds?: Set<string>;
  showPath?: boolean;
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

export function FileGrid({ nodes, onNavigate, onFavorite, favoriteIds, showPath }: FileGridProps) {
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);

  // Hooks must be called before any early returns
  const { gridSize } = useTopBar();

  const gridClasses: Record<string, string> = {
    sm: "grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-9 2xl:grid-cols-11",
    md: "grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8",
    lg: "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6",
    xl: "grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
  };

  if (nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-[hsl(var(--muted-foreground))]">
        <Folder size={48} strokeWidth={1} className="mb-3 opacity-40" />
        <p className="text-sm">This folder is empty</p>
      </div>
    );
  }

  return (
    <div className={cn("grid gap-3 p-4", gridClasses[gridSize])}>
      {nodes.map((node) => (
        <button
          key={node.id}
          id={`file-${node.id}`}
          onClick={(e) => {
            if (longPressFiredRef.current) {
              e.preventDefault();
              e.stopPropagation();
              return;
            }
            onNavigate(node);
          }}
          onContextMenu={(e: React.MouseEvent) => {
            if (node.type === "DIRECTORY") {
              e.preventDefault();
              document.getElementById(`folder-menu-btn-${node.id}`)?.dispatchEvent(new CustomEvent("open-menu"));
            }
          }}
          onTouchStart={() => {
            if (node.type === "DIRECTORY") {
              longPressFiredRef.current = false;
              touchTimerRef.current = setTimeout(() => {
                longPressFiredRef.current = true;
                document.getElementById(`folder-menu-btn-${node.id}`)?.dispatchEvent(new CustomEvent("open-menu"));
              }, 500);
            }
          }}
          onTouchMove={() => { 
            if (touchTimerRef.current) clearTimeout(touchTimerRef.current); 
            longPressFiredRef.current = false;
          }}
          onTouchEnd={(e) => { 
            if (touchTimerRef.current) clearTimeout(touchTimerRef.current);
            if (longPressFiredRef.current) {
              if (e.cancelable) e.preventDefault();
            }
          }}
          className="group relative flex flex-col gap-2 p-3 rounded-xl border bg-[hsl(var(--card))] hover:border-[hsl(var(--primary)/0.3)] hover:shadow-md active:scale-[0.98] active:bg-[hsl(var(--accent)/0.5)] transition-all duration-150 text-left animate-in-fade"
        >
          {/* Thumbnail or icon */}
          {/* Videos store their poster in the `previews` table; images use `thumbnails` */}
          <div className="aspect-square rounded-lg bg-[hsl(var(--accent))] flex items-center justify-center overflow-hidden">
            {(node.thumbnail || node.preview) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/cache/${node.preview?.cachePath ?? node.thumbnail!.cachePath}`}
                alt={node.name}
                className="w-full h-full object-cover"
                loading="lazy"
                decoding="async"
              />
            ) : (
              <FileIcon mimeType={node.mimeType} type={node.type} />
            )}
          </div>

          {/* Name and Path */}
          <div className="flex flex-col min-w-0">
            <p className="text-xs font-medium truncate leading-snug">{node.name}</p>
            {showPath && (
              <p className="text-[10px] text-[hsl(var(--muted-foreground))] truncate mt-0.5">
                {node.relativePath.split("/").slice(0, -1).join("/") || "/"}
              </p>
            )}
          </div>

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

          {/* Folder Menu */}
          {node.type === "DIRECTORY" && (
            <div className="absolute top-2 right-2 transition-all">
              <FolderMenu node={node} />
            </div>
          )}
        </button>
      ))}
    </div>
  );
}
