"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Star, Download, Pin, PinOff } from "lucide-react";
import type { FileNode } from "@prisma/client";
import { useTopBar } from "../layout/TopBarContext";
import { ContextMenuPosition } from "@/hooks/useContextMenu";

interface ContextMenuProps {
  node: FileNode;
  position: ContextMenuPosition;
  onClose: () => void;
  onFavorite?: (nodeId: string) => void;
  isFavorite?: boolean;
}

export function ContextMenu({ node, position, onClose, onFavorite, isFavorite }: ContextMenuProps) {
  const { pins, togglePin } = useTopBar();
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
      className="fixed z-[100] w-48 bg-[hsl(var(--card))] border rounded-xl shadow-xl py-1.5 animate-in-slide-up"
    >
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
            className="flex items-center gap-3 w-full text-left px-3 py-2 text-sm text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
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
          className="flex items-center gap-3 w-full text-left px-3 py-2 text-sm text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
        >
          {isPinned ? <PinOff size={16} /> : <Pin size={16} />}
          {isPinned ? "Unpin" : "Pin"}
        </button>
      )}
    </div>
  );

  return createPortal(content, document.body);
}
