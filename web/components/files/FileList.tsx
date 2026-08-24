"use client";
import React, { useRef } from "react";

import { Folder, FileText, Image as ImageIcon, Video, Music, File, ChevronRight, MoreVertical } from "lucide-react";
import { formatBytes, formatDate, getFileCategory } from "@/lib/utils";
import type { FileNode, Thumbnail, Preview } from "@prisma/client";
import { useContextMenu } from "@/hooks/useContextMenu";
import { ContextMenu } from "./ContextMenu";
import { FolderSize } from "./FolderSize";

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
  const contextMenu = useContextMenu();

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
      <div className="flex items-center px-4 py-2 text-xs font-medium text-[hsl(var(--muted-foreground))] gap-3">
        <span className="flex-1 min-w-0">Name</span>
        <span className="w-28 shrink-0 hidden md:block">Modified</span>
        <span className="w-20 shrink-0 text-right">Size</span>
        <span className="w-7 shrink-0" />
      </div>
      {nodes.map((node) => (
        <div
          key={node.id}
          className="group flex items-center px-4 py-2.5 gap-3 hover:bg-[hsl(var(--accent)/0.5)] active:bg-[hsl(var(--accent))] active:scale-[0.99] transition-all cursor-pointer"
          onClick={(e) => {
            if (longPressFiredRef.current) {
              e.preventDefault();
              e.stopPropagation();
              return;
            }
            onNavigate(node);
          }}
          onContextMenu={(e: React.MouseEvent) => {
            e.preventDefault();
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
          id={`file-row-${node.id}`}
        >
          {/* Icon + Name — takes all remaining space, truncates */}
          <div className="flex items-center gap-2.5 flex-1 min-w-0">
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
              <ChevronRight size={14} className="text-[hsl(var(--muted-foreground))] opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
            )}
          </div>

          {/* Modified — hidden on mobile */}
          <span className="w-28 shrink-0 hidden md:block text-xs text-[hsl(var(--muted-foreground))] truncate">
            {formatDate(node.modifiedAt)}
          </span>

          {/* Size — always visible */}
          <span className="w-20 shrink-0 text-right text-xs text-[hsl(var(--muted-foreground))]">
            {node.type === "FILE" && node.size != null
              ? formatBytes(node.size)
              : node.type === "DIRECTORY"
              ? <FolderSize path={node.relativePath} />
              : "—"}
          </span>

          {/* 3-dots — pinned far right */}
          <button
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              contextMenu.open(e, node, { current: e.currentTarget as HTMLElement });
            }}
            className="w-7 shrink-0 flex items-center justify-center p-1 rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--background)/0.8)] transition-all lg:opacity-0 lg:group-hover:opacity-100 opacity-100"
          >
            <MoreVertical size={16} />
          </button>
        </div>
      ))}
      
      {contextMenu.isOpen && contextMenu.node && contextMenu.position && (
        <ContextMenu 
          node={contextMenu.node} 
          position={contextMenu.position} 
          onClose={contextMenu.close} 
          onFavorite={onFavorite} 
          isFavorite={favoriteIds?.has(contextMenu.node.id)} 
        />
      )}
    </div>
  );
}
