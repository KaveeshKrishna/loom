"use client";
import React, { useRef } from "react";

import { Folder, ChevronRight, MoreVertical, CheckCircle2 } from "lucide-react";
import { cn, formatBytes, formatDate } from "@/lib/utils";
import type { FileNode, Thumbnail, Preview } from "@prisma/client";
import { useContextMenu } from "@/hooks/useContextMenu";
import { ContextMenu } from "./ContextMenu";
import { FolderSize } from "./FolderSize";
import { FileIcon } from "./FileIcon";

type FileNodeWithThumbnail = FileNode & { contentIdentity: ({ thumbnail: Thumbnail | null, preview: Preview | null }) | null };

interface FileListProps {
  nodes: FileNodeWithThumbnail[];
  onNavigate: (node: FileNodeWithThumbnail) => void;
  onFavorite?: (nodeId: string) => void;
  favoriteIds?: Set<string>;
  showPath?: boolean;
  selectedIds?: Set<string>;
  onSelect?: (id: string, multi: boolean, shift: boolean) => void;
}



export function FileList({ nodes, onNavigate, onFavorite, favoriteIds, showPath, selectedIds, onSelect }: FileListProps) {
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
          id={`file-${node.id}`}
          className={cn(
            "group flex items-center px-4 py-2.5 gap-3 hover:bg-[hsl(var(--accent)/0.5)] active:bg-[hsl(var(--accent))] active:scale-[0.99] transition-all cursor-pointer",
            selectedIds?.has(node.id) ? "bg-[hsl(var(--accent)/0.8)]" : ""
          )}
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
        >
          {/* Left section: Checkbox and Icon */}
          <div className="flex items-center gap-3 shrink-0">
            {onSelect && (
              <div 
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(node.id, e.metaKey || e.ctrlKey, e.shiftKey);
                }}
                className={cn(
                  "rounded-full transition-opacity cursor-pointer",
                  selectedIds?.has(node.id) ? "opacity-100 text-[hsl(var(--primary))]" : "opacity-0 group-hover:opacity-100 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
                )}
              >
                <CheckCircle2 size={20} fill={selectedIds?.has(node.id) ? "currentColor" : "transparent"} className={selectedIds?.has(node.id) ? "text-[hsl(var(--background))]" : ""} />
              </div>
            )}
            <FileIcon mimeType={node.mimeType} type={node.type} />
          </div>

          {/* Icon + Name — takes all remaining space, truncates */}
          <div className="flex items-center gap-2.5 flex-1 min-w-0">
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
          selectedNodes={selectedIds ? nodes.filter(n => selectedIds.has(n.id)) : undefined}
        />
      )}
    </div>
  );
}
