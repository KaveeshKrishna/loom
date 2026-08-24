"use client";
import React, { useRef } from "react";

import { Folder, FileText, Image as ImageIcon, Video, Music, File, Star, Download, ChevronRight } from "lucide-react";
import { cn, formatBytes, formatDate, getFileCategory } from "@/lib/utils";
import type { FileNode, Thumbnail, Preview } from "@prisma/client";
import { FolderMenu } from "./FolderMenu";

type FileNodeWithThumbnail = FileNode & { thumbnail: Thumbnail | null, preview: Preview | null };

interface FileListProps {
  nodes: FileNodeWithThumbnail[];
  onNavigate: (node: FileNodeWithThumbnail) => void;
  onFavorite?: (nodeId: string) => void;
  favoriteIds?: Set<string>;
  showPath?: boolean;
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

export function FileList({ nodes, onNavigate, onFavorite, favoriteIds, showPath }: FileListProps) {
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);

  if (nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-[hsl(var(--muted-foreground))]">
        <Folder size={48} strokeWidth={1} className="mb-3 opacity-40" />
        <p className="text-sm">This folder is empty</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-[hsl(var(--border))]">
      {/* Header */}
      <div className="grid grid-cols-12 gap-2 px-4 py-2 text-xs font-medium text-[hsl(var(--muted-foreground))]">
        <span className="col-span-6">Name</span>
        <span className="col-span-2 hidden md:block">Modified</span>
        <span className="col-span-2 hidden sm:block">Size</span>
        <span className="col-span-2"></span>
      </div>
      {nodes.map((node) => (
        <div
          key={node.id}
          className="group grid grid-cols-12 gap-2 px-4 py-2.5 items-center hover:bg-[hsl(var(--accent)/0.5)] active:bg-[hsl(var(--accent))] active:scale-[0.99] transition-all cursor-pointer"
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
          id={`file-row-${node.id}`}
        >
          <div className="col-span-6 flex items-center gap-2.5 min-w-0">
            <FileIcon mimeType={node.mimeType} type={node.type} />
            <div className="flex flex-col min-w-0 flex-1">
              <span className="text-sm font-medium truncate">{node.name}</span>
              {showPath && (
                <span className="text-xs text-[hsl(var(--muted-foreground))] truncate">
                  {node.relativePath.split("/").slice(0, -1).join("/") || "/"}
                </span>
              )}
            </div>
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
                  "p-1.5 rounded-md lg:opacity-0 lg:group-hover:opacity-100 opacity-100 transition-all",
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
                className="p-1.5 rounded-md lg:opacity-0 lg:group-hover:opacity-100 opacity-100 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-all"
              >
                <Download size={13} />
              </a>
            )}
            {node.type === "DIRECTORY" && (
              <div className="transition-all">
                <FolderMenu node={node} />
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
