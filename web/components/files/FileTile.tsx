"use client";

/**
 * One file/folder in the grid (FileTile) or list (FileRow). Memoized so a
 * selection change or progress tick only re-renders the tiles that changed.
 * Tiles are divs with role="button" (not <button>) so the checkbox and menu
 * buttons inside them are valid HTML.
 */

import { memo, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Folder, MoreVertical, Check, Star, ChevronRight, Loader2, AlertTriangle } from "lucide-react";
import { cn, formatBytes, formatDate } from "@/lib/utils";
import type { LNode } from "@/lib/client/types";
import { thumbUrl } from "@/lib/client/types";
import { FileIcon } from "./FileIcon";

export interface TileHandlers {
  onActivate: (node: LNode, e: React.MouseEvent | KeyboardEvent) => void;
  onToggleSelect: (node: LNode, e: { shiftKey: boolean; ctrlOrMeta: boolean }) => void;
  onMenu: (node: LNode, x: number, y: number) => void;
  onRenameCommit: (node: LNode, name: string | null) => void;
  onDragStart: (node: LNode, e: React.DragEvent) => void;
  onDropOnFolder: (folder: LNode, e: React.DragEvent) => void;
}

interface TileProps {
  node: LNode;
  selected: boolean;
  focused: boolean;
  favorite: boolean;
  renaming: boolean;
  selectionMode: boolean;
  showPath?: boolean;
  folderSize?: string;
  cut?: boolean;
  h: TileHandlers;
}

function useLongPress(onLongPress: (x: number, y: number) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  return {
    fired,
    handlers: {
      onTouchStart: (e: React.TouchEvent) => {
        fired.current = false;
        const t = e.touches[0];
        timer.current = setTimeout(() => {
          fired.current = true;
          navigator.vibrate?.(15);
          onLongPress(t.clientX, t.clientY);
        }, 480);
      },
      onTouchMove: () => {
        if (timer.current) clearTimeout(timer.current);
      },
      onTouchEnd: (e: React.TouchEvent) => {
        if (timer.current) clearTimeout(timer.current);
        if (fired.current && e.cancelable) e.preventDefault();
      },
    },
  };
}

function RenameInput({ node, onDone }: { node: LNode; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(node.name);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = node.type === "FILE" ? node.name.lastIndexOf(".") : -1;
    el.setSelectionRange(0, dot > 0 ? dot : node.name.length);
  }, [node]);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      ref={ref}
      value={value}
      aria-label="New name"
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(value);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(value)}
      className="w-full text-xs px-1.5 py-1 rounded border border-[hsl(var(--primary))] bg-[hsl(var(--background))] focus:outline-none"
    />
  );
}

function dragProps(node: LNode, h: TileHandlers, setOver: (v: boolean) => void) {
  const isDir = node.type === "DIRECTORY";
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => h.onDragStart(node, e),
    ...(isDir
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (e.dataTransfer.types.includes("application/x-loom-paths") || e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = e.dataTransfer.types.includes("Files") || e.altKey || e.ctrlKey ? "copy" : "move";
              setOver(true);
            }
          },
          onDragLeave: () => setOver(false),
          onDrop: (e: React.DragEvent) => {
            setOver(false);
            h.onDropOnFolder(node, e);
          },
        }
      : {}),
  };
}

export const FileTile = memo(function FileTile({ node, selected, focused, favorite, renaming, selectionMode, showPath, folderSize, cut, h }: TileProps) {
  const [over, setOver] = useState(false);
  const lp = useLongPress((x, y) => h.onMenu(node, x, y));
  const thumb = thumbUrl(node);
  const [imgFailed, setImgFailed] = useState(false);

  return (
    <div
      role="button"
      tabIndex={focused ? 0 : -1}
      data-node-id={node.id}
      aria-pressed={selected}
      aria-label={node.name}
      onClick={(e) => {
        e.stopPropagation();
        if (lp.fired.current) return;
        if (e.shiftKey || e.metaKey || e.ctrlKey || selectionMode) {
          h.onToggleSelect(node, { shiftKey: e.shiftKey, ctrlOrMeta: e.metaKey || e.ctrlKey || selectionMode });
          return;
        }
        h.onActivate(node, e);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        h.onMenu(node, e.clientX, e.clientY);
      }}
      {...lp.handlers}
      {...dragProps(node, h, setOver)}
      className={cn(
        "group relative flex flex-col gap-2 p-2.5 rounded-xl border bg-[hsl(var(--card))] hover:shadow-md transition-all duration-150 text-left cursor-pointer select-none outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]",
        selected ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.06)] ring-1 ring-[hsl(var(--primary)/0.35)]" : "hover:border-[hsl(var(--primary)/0.3)]",
        over && "ring-2 ring-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.08)]",
        cut && "opacity-50"
      )}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={selected ? "Deselect" : "Select"}
        onClick={(e) => {
          e.stopPropagation();
          h.onToggleSelect(node, { shiftKey: e.shiftKey, ctrlOrMeta: true });
        }}
        className={cn(
          "absolute top-2 left-2 z-10 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-opacity",
          selected
            ? "opacity-100 bg-[hsl(var(--primary))] border-[hsl(var(--primary))] text-white"
            : "bg-[hsl(var(--background)/0.85)] border-[hsl(var(--muted-foreground)/0.5)] text-transparent opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-70",
          selectionMode && "opacity-100"
        )}
      >
        <Check size={14} strokeWidth={3} />
      </button>

      <div className={cn("aspect-square rounded-lg bg-[hsl(var(--accent))] flex items-center justify-center overflow-hidden relative", node.processing && !thumb && "processing-shimmer")}>
        {thumb && !imgFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" draggable={false} onError={() => setImgFailed(true)} />
        ) : node.type === "DIRECTORY" ? (
          <Folder size={44} strokeWidth={1.4} className="text-[hsl(var(--primary))]" fill="hsl(var(--primary) / 0.12)" />
        ) : (
          <FileIcon mimeType={node.mimeType} type={node.type} size={34} name={node.name} />
        )}
        {node.processing && !thumb && (
          <span className="absolute bottom-1.5 right-1.5 text-[hsl(var(--muted-foreground))]" title="Generating preview">
            <Loader2 size={13} className="animate-spin" />
          </span>
        )}
        {node.healthStatus && node.healthStatus !== "HEALTHY" && (
          <span className="absolute bottom-1.5 left-1.5 text-amber-500" title={node.healthStatus === "CORRUPT" ? "This file looks damaged" : "Preview not supported"}>
            <AlertTriangle size={13} />
          </span>
        )}
        {node.mimeType?.startsWith("video/") && thumb && (
          <span className="absolute bottom-1.5 right-1.5 bg-black/60 text-white rounded px-1 text-[10px]">▶</span>
        )}
      </div>

      <div className="flex flex-col min-w-0 px-0.5">
        {renaming ? (
          <RenameInput node={node} onDone={(v) => h.onRenameCommit(node, v)} />
        ) : (
          <p className="text-xs font-medium truncate leading-snug flex items-center gap-1" title={node.name}>
            {favorite && <Star size={11} className="text-amber-500 shrink-0" fill="currentColor" />}
            <span className="truncate">{node.name}</span>
          </p>
        )}
        {showPath && <p className="text-[10px] text-[hsl(var(--muted-foreground))] truncate mt-0.5">{node.relativePath.split("/").slice(0, -1).join("/") || "Home"}</p>}
        <p className="text-[10px] sm:text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5">
          {node.type === "FILE" ? (node.size != null ? formatBytes(Number(node.size)) : "") : folderSize ?? ""}
        </p>
      </div>

      <button
        type="button"
        tabIndex={-1}
        aria-label="More actions"
        onClick={(e) => {
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          h.onMenu(node, r.right, r.bottom);
        }}
        className="absolute top-2 right-2 p-1.5 rounded-md shadow-sm text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] bg-[hsl(var(--background)/0.85)] opacity-100 lg:opacity-0 lg:group-hover:opacity-100 focus:opacity-100"
      >
        <MoreVertical size={16} />
      </button>
    </div>
  );
});

export const FileRow = memo(function FileRow({ node, selected, focused, favorite, renaming, selectionMode, showPath, folderSize, cut, h }: TileProps) {
  const [over, setOver] = useState(false);
  const lp = useLongPress((x, y) => h.onMenu(node, x, y));
  const thumb = thumbUrl(node);
  return (
    <div
      role="row"
      tabIndex={focused ? 0 : -1}
      data-node-id={node.id}
      aria-selected={selected}
      onClick={(e) => {
        e.stopPropagation();
        if (lp.fired.current) return;
        if (e.shiftKey || e.metaKey || e.ctrlKey || selectionMode) {
          h.onToggleSelect(node, { shiftKey: e.shiftKey, ctrlOrMeta: e.metaKey || e.ctrlKey || selectionMode });
          return;
        }
        h.onActivate(node, e);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        h.onMenu(node, e.clientX, e.clientY);
      }}
      {...lp.handlers}
      {...dragProps(node, h, setOver)}
      className={cn(
        "group flex items-center px-4 h-12 gap-3 hover:bg-[hsl(var(--accent)/0.6)] transition-colors cursor-pointer select-none border-b outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[hsl(var(--ring))]",
        selected && "bg-[hsl(var(--primary)/0.08)]",
        over && "bg-[hsl(var(--primary)/0.12)] ring-2 ring-inset ring-[hsl(var(--primary))]",
        cut && "opacity-50"
      )}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={selected ? "Deselect" : "Select"}
        onClick={(e) => {
          e.stopPropagation();
          h.onToggleSelect(node, { shiftKey: e.shiftKey, ctrlOrMeta: true });
        }}
        className={cn(
          "w-5 h-5 shrink-0 rounded-full border-2 flex items-center justify-center",
          selected ? "bg-[hsl(var(--primary))] border-[hsl(var(--primary))] text-white" : "border-[hsl(var(--muted-foreground)/0.5)] text-transparent opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-60",
          selectionMode && "opacity-100"
        )}
      >
        <Check size={12} strokeWidth={3} />
      </button>
      <div className="w-8 h-8 shrink-0 rounded-md overflow-hidden flex items-center justify-center bg-[hsl(var(--accent)/0.6)]">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" draggable={false} />
        ) : (
          <FileIcon mimeType={node.mimeType} type={node.type} size={18} name={node.name} />
        )}
      </div>
      <div className="flex flex-col min-w-0 flex-1">
        {renaming ? (
          <RenameInput node={node} onDone={(v) => h.onRenameCommit(node, v)} />
        ) : (
          <span className="text-sm truncate flex items-center gap-1.5" title={node.name}>
            {favorite && <Star size={12} className="text-amber-500 shrink-0" fill="currentColor" />}
            <span className="truncate">{node.name}</span>
            {node.processing && !thumb && <Loader2 size={12} className="animate-spin text-[hsl(var(--muted-foreground))] shrink-0" />}
          </span>
        )}
        {showPath && <span className="text-xs text-[hsl(var(--muted-foreground))] truncate">{node.relativePath.split("/").slice(0, -1).join("/") || "Home"}</span>}
      </div>
      <span className="w-32 shrink-0 hidden md:block text-xs text-[hsl(var(--muted-foreground))] truncate">{formatDate(node.modifiedAt)}</span>
      <span className="w-20 shrink-0 text-right text-xs text-[hsl(var(--muted-foreground))]">
        {node.type === "FILE" ? (node.size != null ? formatBytes(Number(node.size)) : "—") : folderSize ?? "—"}
      </span>
      <button
        type="button"
        tabIndex={-1}
        aria-label="More actions"
        onClick={(e) => {
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          h.onMenu(node, r.right, r.bottom);
        }}
        className="w-7 shrink-0 flex items-center justify-center p-1 rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] lg:opacity-0 lg:group-hover:opacity-100 focus:opacity-100"
      >
        {node.type === "DIRECTORY" ? <ChevronRight size={16} className="lg:hidden" /> : null}
        <MoreVertical size={16} className={node.type === "DIRECTORY" ? "hidden lg:block" : ""} />
      </button>
    </div>
  );
});
