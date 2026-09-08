"use client";
import React, { useRef } from "react";

import { Folder, FileText, Image as ImageIcon, Video, Music, File, MoreVertical, CheckCircle2 } from "lucide-react";
import { cn, formatBytes, getFileCategory } from "@/lib/utils";
import type { FileNode, Thumbnail, Preview } from "@prisma/client";
import { useTopBar } from "../layout/TopBarContext";
import { useContextMenu } from "@/hooks/useContextMenu";
import { ContextMenu } from "./ContextMenu";
import { FolderSize } from "./FolderSize";

type FileNodeWithThumbnail = FileNode & { contentIdentity: ({ thumbnail: Thumbnail | null, preview: Preview | null }) | null };

interface FileGridProps {
  nodes: FileNodeWithThumbnail[];
  onNavigate: (node: FileNodeWithThumbnail) => void;
  onFavorite?: (nodeId: string) => void;
  favoriteIds?: Set<string>;
  showPath?: boolean;
  selectedIds?: Set<string>;
  onSelect?: (id: string, multi: boolean, shift: boolean) => void;
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

export function FileGrid({ nodes, onNavigate, onFavorite, favoriteIds, showPath, selectedIds, onSelect }: FileGridProps) {
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const contextMenu = useContextMenu();

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
            if (e.shiftKey || e.metaKey || e.ctrlKey) {
              e.preventDefault();
              e.stopPropagation();
              onSelect?.(node.id, e.metaKey || e.ctrlKey, e.shiftKey);
              return;
            }
            onNavigate(node);
          }}
          onContextMenu={(e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            contextMenu.open(e, node);
          }}
          onTouchStart={(e: React.TouchEvent) => {
            longPressFiredRef.current = false;
            touchTimerRef.current = setTimeout(() => {
              longPressFiredRef.current = true;
              contextMenu.open(e, node);
            }, 500);
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
          className={cn(
            "group relative flex flex-col gap-2 p-3 rounded-xl border bg-[hsl(var(--card))] hover:shadow-md active:scale-[0.98] active:bg-[hsl(var(--accent)/0.5)] transition-all duration-150 text-left animate-in-fade",
            selectedIds?.has(node.id) ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.05)] ring-1 ring-[hsl(var(--primary)/0.3)]" : "hover:border-[hsl(var(--primary)/0.3)]"
          )}
        >
          {/* Checkbox (visible on hover or if selected) */}
          {onSelect && (
            <div 
              onClick={(e) => {
                e.stopPropagation();
                onSelect(node.id, e.metaKey || e.ctrlKey, e.shiftKey);
              }}
              className={cn(
                "absolute top-2 left-2 z-10 rounded-full transition-opacity cursor-pointer",
                selectedIds?.has(node.id) ? "opacity-100 text-[hsl(var(--primary))]" : "opacity-0 group-hover:opacity-100 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
              )}
            >
              <CheckCircle2 size={20} fill={selectedIds?.has(node.id) ? "currentColor" : "transparent"} className={selectedIds?.has(node.id) ? "text-[hsl(var(--background))]" : ""} />
            </div>
          )}

          {/* Thumbnail or icon */}
          {/* Videos store their poster in the `previews` table; images use `thumbnails` */}
          <div className="aspect-square rounded-lg bg-[hsl(var(--accent))] flex items-center justify-center overflow-hidden">
            {(node.contentIdentity?.thumbnail || node.contentIdentity?.preview) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/cache/${node.contentIdentity?.preview?.cachePath ?? node.contentIdentity?.thumbnail!.cachePath}`}
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
          {node.type === "FILE" && node.size != null ? (
            <p className="text-[10px] sm:text-xs text-[hsl(var(--muted-foreground))]">{formatBytes(node.size)}</p>
          ) : node.type === "DIRECTORY" ? (
            <p className="text-[10px] sm:text-xs text-[hsl(var(--muted-foreground))]"><FolderSize path={node.relativePath} /></p>
          ) : null}

          {/* Action Menu Button (3 dots) for ALL nodes */}
          <button
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              contextMenu.open(e, node, { current: e.currentTarget as HTMLElement });
            }}
            className={cn(
              "absolute top-2 right-2 p-1.5 rounded-md transition-all shadow-sm",
              favoriteIds?.has(node.id) 
                ? "text-amber-500 bg-[hsl(var(--background)/0.8)] opacity-100" 
                : "text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] bg-[hsl(var(--background)/0.8)] hover:bg-[hsl(var(--background))] opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
            )}
          >
            <MoreVertical size={16} />
          </button>
        </button>
      ))}
      
      {contextMenu.isOpen && contextMenu.node && contextMenu.position && (
        <ContextMenu 
          node={contextMenu.node} 
          position={contextMenu.position} 
          onClose={contextMenu.close} 
          onFavorite={onFavorite} 
          isFavorite={favoriteIds?.has(contextMenu.node.id)} 
          selectedNodes={selectedIds ? nodes.filter(n => selectedIds.has(n.id)) : undefined}
        />
      )}
    </div>
  );
}
