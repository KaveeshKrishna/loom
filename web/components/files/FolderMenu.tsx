"use client";
import React from "react";

import { useState, useRef, useEffect } from "react";
import { MoreVertical, Pin, PinOff } from "lucide-react";
import type { FileNode } from "@prisma/client";
import { useTopBar } from "../layout/TopBarContext";

export function FolderMenu({ node }: { node: FileNode }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const { pins, togglePin } = useTopBar();
  const isPinned = pins.some((p) => p.id === node.id);

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handle);
      return () => document.removeEventListener("mousedown", handle);
    }
  }, [open]);

  const handleTogglePin = () => {
    togglePin({ id: node.id, name: node.name, href: `/files/${node.relativePath}` });
    setOpen(false);
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        id={`folder-menu-btn-${node.id}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="p-1 rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--background)/0.8)] transition-all bg-[hsl(var(--background)/0.5)]"
      >
        <MoreVertical size={16} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-40 bg-[hsl(var(--card))] border rounded-xl shadow-lg py-1 animate-in-slide-up z-50">
          <button
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleTogglePin(); }}
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-sm text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
          >
            {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
            {isPinned ? "Unpin" : "Pin"}
          </button>
        </div>
      )}
    </div>
  );
}
