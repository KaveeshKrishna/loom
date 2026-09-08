"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Star, Download, Pin, PinOff, Scissors, Copy, ClipboardPaste, Edit2, Trash2, Info } from "lucide-react";
import type { FileNode } from "@prisma/client";
import { useTopBar } from "../layout/TopBarContext";
import { useClipboard } from "../layout/ClipboardContext";
import { ContextMenuPosition } from "@/hooks/useContextMenu";

interface ContextMenuProps {
  node: FileNode;
  position: ContextMenuPosition;
  onClose: () => void;
  onFavorite?: (nodeId: string) => void;
  isFavorite?: boolean;
  selectedNodes?: FileNode[];
}

export function ContextMenu({ node, position, onClose, onFavorite, isFavorite, selectedNodes }: ContextMenuProps) {
  const { pins, togglePin } = useTopBar();
  const { clipboard, cutToClipboard, copyToClipboard, clearClipboard } = useClipboard();
  const isPinned = pins.some((p: { id: string }) => p.id === node.id);
  const menuRef = useRef<HTMLDivElement>(null);

  // Start invisible at the requested position; measure once mounted and flip if needed
  const [adjustedPos, setAdjustedPos] = useState<{ x: number; y: number; visible: boolean }>({
    x: position.x,
    y: position.y,
    visible: false,
  });

  useEffect(() => {
    if (!menuRef.current) return;

    const rect = menuRef.current.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const MARGIN = 8;

    let x = position.x;
    let y = position.y;

    // Not enough space to the right → open to the left of the cursor instead
    if (x + rect.width + MARGIN > viewportWidth) {
      x = Math.max(MARGIN, x - rect.width);
    }
    x = Math.min(x, viewportWidth - rect.width - MARGIN);
    x = Math.max(x, MARGIN);

    // Not enough space below → flip upward
    if (y + rect.height + MARGIN > viewportHeight) {
      y = Math.max(MARGIN, y - rect.height);
    }
    y = Math.min(y, viewportHeight - rect.height - MARGIN);
    y = Math.max(y, MARGIN);

    setAdjustedPos({ x, y, visible: true });
  }, [position]);

  useEffect(() => {
    function handle(e: Event) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    const timer = setTimeout(() => document.addEventListener("pointerdown", handle), 10);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", handle);
    };
  }, [onClose]);

  const content = (
    <div
      ref={menuRef}
      style={{
        left: adjustedPos.x,
        top: adjustedPos.y,
        visibility: adjustedPos.visible ? "visible" : "hidden",
      }}
      className="fixed z-[100] w-48 bg-[hsl(var(--card))] border rounded-xl shadow-xl py-1.5 animate-in-slide-up flex flex-col"
    >
      <button
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          const paths = (selectedNodes && selectedNodes.find(n => n.id === node.id)) 
            ? selectedNodes.map(n => n.relativePath) 
            : [node.relativePath];
          cutToClipboard(paths);
          onClose();
        }}
        className="flex items-center gap-3 w-full text-left px-3 py-2 text-sm text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
      >
        <Scissors size={16} /> Cut
      </button>
      <button
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          const paths = (selectedNodes && selectedNodes.find(n => n.id === node.id)) 
            ? selectedNodes.map(n => n.relativePath) 
            : [node.relativePath];
          copyToClipboard(paths);
          onClose();
        }}
        className="flex items-center gap-3 w-full text-left px-3 py-2 text-sm text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
      >
        <Copy size={16} /> Copy
      </button>

      {node.type === "DIRECTORY" && clipboard.action && clipboard.paths.length > 0 && (
        <button
          onClick={async (e: React.MouseEvent) => {
            e.stopPropagation();
            const action = clipboard.action === "COPY" ? "copy" : "move";
            await fetch(`/api/fs/${action}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sourcePaths: clipboard.paths, destDir: node.relativePath })
            });
            clearClipboard();
            window.dispatchEvent(new CustomEvent("loom-refresh"));
            onClose();
          }}
          className="flex items-center gap-3 w-full text-left px-3 py-2 text-sm text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors border-b border-[hsl(var(--border))]"
        >
          <ClipboardPaste size={16} /> Paste Into
        </button>
      )}

      <button
        onClick={async (e: React.MouseEvent) => {
          e.stopPropagation();
          const newName = window.prompt("Enter new name:", node.name);
          if (newName && newName !== node.name) {
            await fetch("/api/fs/rename", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sourcePath: node.relativePath, newName })
            });
            window.dispatchEvent(new CustomEvent("loom-refresh"));
          }
          onClose();
        }}
        className="flex items-center gap-3 w-full text-left px-3 py-2 text-sm text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
      >
        <Edit2 size={16} /> Rename
      </button>

      <button
        onClick={async (e: React.MouseEvent) => {
          e.stopPropagation();
          const paths = (selectedNodes && selectedNodes.find(n => n.id === node.id)) 
            ? selectedNodes.map(n => n.relativePath) 
            : [node.relativePath];
          const confirmMsg = paths.length > 1 
            ? `Are you sure you want to move ${paths.length} items to Trash?`
            : `Are you sure you want to move "${node.name}" to Trash?`;
          if (window.confirm(confirmMsg)) {
            await fetch("/api/fs/trash", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ paths })
            });
            window.dispatchEvent(new CustomEvent("loom-refresh"));
          }
          onClose();
        }}
        className="flex items-center gap-3 w-full text-left px-3 py-2 text-sm text-red-500 hover:bg-red-500/10 transition-colors border-b border-[hsl(var(--border))]"
      >
        <Trash2 size={16} /> Delete
      </button>

      {node.type === "FILE" && (
        <>
          <button
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); onFavorite?.(node.id); onClose(); }}
            className="flex items-center gap-3 w-full text-left px-3 py-2 text-sm text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
          >
            <Star size={16} className={isFavorite ? "text-amber-500" : ""} fill={isFavorite ? "currentColor" : "none"} />
            {isFavorite ? "Unstar" : "Star"}
          </button>
          <a
            href={`/api/files/serve?path=${encodeURIComponent(node.relativePath)}&download=1`}
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); onClose(); }}
            className="flex items-center gap-3 w-full text-left px-3 py-2 text-sm text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors border-b border-[hsl(var(--border))]"
          >
            <Download size={16} />
            Download
          </a>
        </>
      )}
      {node.type === "DIRECTORY" && (
        <button
          onClick={(e: React.MouseEvent) => { 
            e.stopPropagation(); 
            togglePin({ id: node.id, name: node.name, href: `/files/${node.relativePath}` }); 
            onClose(); 
          }}
          className="flex items-center gap-3 w-full text-left px-3 py-2 text-sm text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors border-b border-[hsl(var(--border))]"
        >
          {isPinned ? <PinOff size={16} /> : <Pin size={16} />}
          {isPinned ? "Unpin" : "Pin"}
        </button>
      )}

      <button
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          // TODO: Open Properties dialog
          window.dispatchEvent(new CustomEvent("loom-properties", { detail: node }));
          onClose();
        }}
        className="flex items-center gap-3 w-full text-left px-3 py-2 text-sm text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
      >
        <Info size={16} /> Properties
      </button>
    </div>
  );

  return createPortal(content, document.body);
}
