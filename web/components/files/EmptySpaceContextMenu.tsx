"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { UploadCloud, FolderUp, ClipboardPaste, FolderPlus } from "lucide-react";
import { useClipboard } from "../layout/ClipboardContext";
import { useUpload } from "../layout/UploadContext";
import { ContextMenuPosition } from "@/hooks/useContextMenu";

interface EmptySpaceContextMenuProps {
  currentPath: string;
  position: ContextMenuPosition;
  onClose: () => void;
}

export function EmptySpaceContextMenu({ currentPath, position, onClose }: EmptySpaceContextMenuProps) {
  const { clipboard, clearClipboard } = useClipboard();
  const { enqueueFiles } = useUpload();
  const menuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

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
    if (x + rect.width + MARGIN > viewportWidth) x = Math.max(MARGIN, x - rect.width);
    x = Math.min(x, viewportWidth - rect.width - MARGIN);
    x = Math.max(x, MARGIN);
    if (y + rect.height + MARGIN > viewportHeight) y = Math.max(MARGIN, y - rect.height);
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

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const entries = Array.from(files).map((file) => ({
      file,
      relativePath: file.name, // flat upload — just filename
    }));

    enqueueFiles(entries, currentPath || "");
    onClose();
    // Reset input so the same file can be re-selected
    e.target.value = "";
  };

  const handleFolderSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const entries = Array.from(files).map((file) => ({
      file,
      // webkitRelativePath preserves the full folder structure (e.g. "MyFolder/sub/photo.jpg")
      relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    }));

    enqueueFiles(entries, currentPath || "");
    onClose();
    e.target.value = "";
  };

  const content = (
    <div
      ref={menuRef}
      style={{ left: adjustedPos.x, top: adjustedPos.y, visibility: adjustedPos.visible ? "visible" : "hidden" }}
      className="fixed z-[100] w-52 bg-[hsl(var(--card))] border rounded-xl shadow-xl py-1.5 animate-in-slide-up flex flex-col"
    >
      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFilesSelected}
      />
      <input
        ref={folderInputRef}
        type="file"
        // @ts-expect-error — webkitdirectory is not in the standard TS types
        webkitdirectory=""
        multiple
        className="hidden"
        onChange={handleFolderSelected}
      />

      <button
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          fileInputRef.current?.click();
        }}
        className="flex items-center gap-3 w-full text-left px-3 py-2 text-sm text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
      >
        <UploadCloud size={16} /> Upload Files
      </button>

      <button
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          folderInputRef.current?.click();
        }}
        className="flex items-center gap-3 w-full text-left px-3 py-2 text-sm text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
      >
        <FolderUp size={16} /> Upload Folder
      </button>

      {clipboard.action && clipboard.paths.length > 0 && (
        <button
          onClick={async (e: React.MouseEvent) => {
            e.stopPropagation();
            const action = clipboard.action === "COPY" ? "copy" : "move";
            await fetch(`/api/fs/${action}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sourcePaths: clipboard.paths, destDir: currentPath || "" })
            });
            clearClipboard();
            window.dispatchEvent(new CustomEvent("loom-refresh"));
            onClose();
          }}
          className="flex items-center gap-3 w-full text-left px-3 py-2 text-sm text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors border-t border-[hsl(var(--border))]"
        >
          <ClipboardPaste size={16} /> Paste
        </button>
      )}

      <button
        onClick={async (e: React.MouseEvent) => {
          e.stopPropagation();
          const folderName = window.prompt("New Folder Name:");
          if (folderName) {
            await fetch("/api/fs/mkdir", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ parentPath: currentPath || "", name: folderName })
            });
            window.dispatchEvent(new CustomEvent("loom-refresh"));
          }
          onClose();
        }}
        className="flex items-center gap-3 w-full text-left px-3 py-2 text-sm text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors border-t border-[hsl(var(--border))]"
      >
        <FolderPlus size={16} /> Create Folder
      </button>
    </div>
  );

  return createPortal(content, document.body);
}
