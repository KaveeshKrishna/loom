"use client";

/**
 * FileBrowser — the one file view used everywhere (folders, Photos, Videos,
 * Documents, Starred, Recent, search results).
 *
 *  - Grid or list, virtualized: only on-screen rows are rendered, so a
 *    folder with 20,000 files scrolls smoothly.
 *  - Sort (name/date/size/type), type filter, details side panel.
 *  - Selection: click the circle, Ctrl/Cmd-click, Shift-click ranges, long-press
 *    on touch; once something is selected, taps toggle selection.
 *  - Bulk actions bar: download (ZIP), move to, copy to, star, trash.
 *  - Keyboard: arrows, Enter, Space, Delete, F2, Ctrl+A/C/X/V, Esc, Alt+Enter.
 *  - Inline rename, right-click / ⋮ menus.
 *  - Drag items onto folders (or breadcrumbs / pinned folders) to move them
 *    (hold Alt/Ctrl to copy); drop files or folders from the desktop to upload.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Download, FolderInput, Copy, Star, Trash2, X, CheckSquare, Edit2, Scissors, ClipboardPaste, Info, Pin, PinOff,
  FolderOpen, ExternalLink, UploadCloud, FolderUp, FolderPlus, FilePlus, Plus, ArrowUpDown, SlidersHorizontal, Folder,
  AlertTriangle, Search, Share2, FileArchive,
} from "lucide-react";
import { cn, formatBytes, sortNodes, matchesTypeFilter } from "@/lib/utils";
import { filesHref, parentOf } from "@/lib/client/api";
import type { LNode } from "@/lib/client/types";
import { collectDroppedFiles, LOOM_DRAG_TYPE } from "@/lib/client/drop";
import { pickForUpload, hasNative, useNativeLocation } from "@/lib/client/native";
import { useFavoriteIds, useFolderSizes, setFavoriteLocal } from "@/lib/client/hooks";
import { useViewPrefs, useNav, type SortKey, type TypeFilter } from "@/components/layout/TopBarContext";
import { useClipboard } from "@/components/layout/ClipboardContext";
import { useUploadActions } from "@/components/layout/UploadContext";
import { FileTile, FileRow, type TileHandlers } from "./FileTile";
import { Menu, type MenuItem } from "./Menu";
import { DetailsPanel } from "./DetailsPanel";
import { FileGridSkeleton, FileListSkeleton } from "./FileSkeletons";
import { pickFolder } from "./FolderPicker";
import { openShareDialog } from "./ShareDialog";
import {
  moveItems, copyItems, renameItem, trashItems, createFolder, createTextFile, setFavorite, downloadItems,
} from "./actions";

const MediaViewer = dynamic(() => import("@/components/viewer/MediaViewer").then((m) => m.MediaViewer), { ssr: false });

const TILE_MIN: Record<string, number> = { sm: 112, md: 148, lg: 184, xl: 244 };
/** Phones: smaller minimum widths so "Large" still shows two columns. */
const TILE_MIN_PHONE: Record<string, number> = { sm: 84, md: 104, lg: 150, xl: 300 };
const GAP = 12;
const PAD = 16;

export interface FileBrowserProps {
  nodes: LNode[];
  loading: boolean;
  error?: { status: number; message: string } | null;
  /** Set when browsing a folder: enables New/Upload, paste and drop-to-upload here. */
  folderPath?: string | null;
  canWrite?: boolean;
  showPath?: boolean;
  /** Keep the order given (search relevance, recent) until the user picks a sort. */
  preserveOrder?: boolean;
  emptyState?: ReactNode;
  footer?: ReactNode;
  /** Called after local changes that the view can't learn about live (rare). */
  onChanged?: () => void;
  /** Open a file (by id) in the viewer on mount, e.g. from a deep link. */
  openId?: string | null;
  /** Open this file (relative path) in the text editor once it's listed. */
  editPath?: string | null;
}

function useMainScroller() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => setEl(document.getElementById("main-content")), []);
  return el;
}

export function FileBrowser({
  nodes,
  loading,
  error,
  folderPath = null,
  canWrite = true,
  showPath,
  preserveOrder,
  emptyState,
  footer,
  openId,
  editPath,
}: FileBrowserProps) {
  const router = useRouter();
  const { viewMode, gridSize, sortKey, sortDir, setSort, typeFilter, setTypeFilter, detailsOpen, setDetailsOpen } = useViewPrefs();
  const { pins, togglePin } = useNav();
  const { clipboard, copyToClipboard, cutToClipboard, clearClipboard } = useClipboard();
  const { enqueueFiles } = useUploadActions();
  const favoriteIds = useFavoriteIds();
  const folderSizes = useFolderSizes(folderPath, !loading);
  const scroller = useMainScroller();
  const isFolder = folderPath !== null;

  // ── ordering ──
  const [userSorted, setUserSorted] = useState(false);
  const display = useMemo(() => {
    const filtered = typeFilter === "all" ? nodes : nodes.filter((n) => matchesTypeFilter(n, typeFilter));
    return preserveOrder && !userSorted ? filtered : sortNodes(filtered, sortKey, sortDir);
  }, [nodes, typeFilter, sortKey, sortDir, preserveOrder, userSorted]);
  const indexById = useMemo(() => new Map(display.map((n, i) => [n.id, i])), [display]);

  // ── selection & focus ──
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusIdx, setFocusIdx] = useState(0);
  const anchor = useRef<number | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const selectionMode = selected.size > 0;

  // Drop selection entries that no longer exist; reset on folder change.
  useEffect(() => {
    setSelected(new Set());
    anchor.current = null;
    setFocusIdx(0);
  }, [folderPath]);
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter((id) => indexById.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [indexById]);

  const selectedNodes = useMemo(() => display.filter((n) => selected.has(n.id)), [display, selected]);
  const cutSet = useMemo(() => (clipboard.action === "CUT" ? new Set(clipboard.paths) : null), [clipboard]);

  // ── viewer ──
  const [viewerId, setViewerId] = useState<string | null>(openId ?? null);
  const [viewerEdit, setViewerEdit] = useState(false);
  useEffect(() => {
    if (openId) setViewerId(openId);
  }, [openId]);
  const viewerFiles = useMemo(() => display.filter((n) => n.type === "FILE"), [display]);
  const viewerIndex = viewerId ? viewerFiles.findIndex((n) => n.id === viewerId) : -1;
  const handledEdit = useRef<string | null>(null);
  useEffect(() => {
    if (!editPath || handledEdit.current === editPath) return;
    const n = nodes.find((x) => x.relativePath === editPath);
    if (!n) return;
    handledEdit.current = editPath;
    setViewerEdit(true);
    setViewerId(n.id);
  }, [editPath, nodes]);

  // ── menus ──
  const [menu, setMenu] = useState<{ x: number; y: number; node: LNode | null } | null>(null);
  const [newMenu, setNewMenu] = useState<{ x: number; y: number } | null>(null);
  const [sortMenu, setSortMenu] = useState<{ x: number; y: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  // Inside a Loom app, its own picker replaces the page's file inputs.
  const chooseUploadFiles = useCallback(() => {
    pickForUpload(folderPath ?? "", "files", () => fileInput.current?.click());
  }, [folderPath]);
  const chooseUploadFolder = useCallback(() => {
    pickForUpload(folderPath ?? "", "folder", () => folderInput.current?.click());
  }, [folderPath]);
  useNativeLocation(folderPath, folderPath != null && canWrite);

  const open = useCallback(
    (node: LNode) => {
      if (node.type === "DIRECTORY") router.push(filesHref(node.relativePath));
      else setViewerId(node.id);
    },
    [router]
  );

  // Details for one item: focus it (without selecting, so clicks still open things).
  const showDetailsFor = useCallback(
    (node: LNode) => {
      setSelected(new Set());
      const i = display.findIndex((n) => n.id === node.id);
      if (i >= 0) setFocusIdx(i);
      setDetailsOpen(true);
    },
    [display, setDetailsOpen]
  );

  const targetsFor = useCallback(
    (node: LNode | null) => (node && selected.has(node.id) ? selectedNodes : node ? [node] : selectedNodes),
    [selected, selectedNodes]
  );

  const toggleFav = useCallback(
    async (targets: LNode[]) => {
      const makeFav = targets.some((t) => !favoriteIds.has(t.id));
      for (const t of targets) {
        setFavoriteLocal(t.id, makeFav);
        const r = await setFavorite(t.id, makeFav);
        if (r !== makeFav) setFavoriteLocal(t.id, r);
      }
    },
    [favoriteIds]
  );

  const doMoveTo = useCallback(async (targets: LNode[], copy: boolean) => {
    const dest = await pickFolder({
      title: `${copy ? "Copy" : "Move"} ${targets.length === 1 ? `"${targets[0].name}"` : `${targets.length} items`} to…`,
      confirmLabel: copy ? "Copy" : "Move",
      start: parentOf(targets[0].relativePath),
      exclude: copy ? targets.filter((t) => t.type === "DIRECTORY").map((t) => t.relativePath) : targets.map((t) => t.relativePath),
    });
    if (dest === null) return;
    if (copy) await copyItems(targets.map((t) => t.relativePath), dest);
    else await moveItems(targets.map((t) => t.relativePath), dest);
  }, []);

  const paste = useCallback(
    async (dest: string) => {
      if (!clipboard.action || clipboard.paths.length === 0) return;
      if (clipboard.action === "COPY") await copyItems(clipboard.paths, dest);
      else {
        await moveItems(clipboard.paths, dest);
        clearClipboard();
      }
    },
    [clipboard, clearClipboard]
  );

  const menuItems = useCallback(
    (node: LNode | null): MenuItem[] => {
      if (!node) {
        // Empty-space menu (folder views only)
        if (!isFolder) return [];
        return [
          { label: "Upload files", icon: <UploadCloud size={15} />, onClick: chooseUploadFiles, disabled: !canWrite },
          { label: "Upload folder", icon: <FolderUp size={15} />, onClick: chooseUploadFolder, disabled: !canWrite },
          { label: "New folder", icon: <FolderPlus size={15} />, onClick: () => createFolder(folderPath!), disabled: !canWrite, separatorBefore: true },
          { label: "New text file", icon: <FilePlus size={15} />, onClick: () => createTextFile(folderPath!).then((p) => p && router.push(`${filesHref(folderPath!)}?edit=${encodeURIComponent(p)}`)), disabled: !canWrite },
          ...(clipboard.action
            ? [{ label: `Paste ${clipboard.paths.length} item${clipboard.paths.length === 1 ? "" : "s"}`, icon: <ClipboardPaste size={15} />, onClick: () => paste(folderPath!), separatorBefore: true, shortcut: "Ctrl+V" }]
            : []),
          { label: "Select all", icon: <CheckSquare size={15} />, onClick: () => setSelected(new Set(display.map((n) => n.id))), separatorBefore: true, shortcut: "Ctrl+A" },
        ];
      }
      const targets = targetsFor(node);
      const multi = targets.length > 1;
      const isDir = node.type === "DIRECTORY";
      const allFav = targets.every((t) => favoriteIds.has(t.id));
      const pinned = pins.some((p) => p.id === node.id);
      const items: MenuItem[] = [];
      if (!multi) items.push({ label: isDir ? "Open" : "Open preview", icon: <FolderOpen size={15} />, onClick: () => open(node) });
      if (!multi && showPath) items.push({ label: "Show in folder", icon: <ExternalLink size={15} />, onClick: () => router.push(filesHref(parentOf(node.relativePath))) });
      if (hasNative("downloads")) {
        // Inside an app: its download manager (resumable, folders stay folders), or one ZIP.
        items.push({ label: "Download", icon: <Download size={15} />, onClick: () => downloadItems(targets) });
        if (multi || isDir) items.push({ label: "Download as ZIP", icon: <FileArchive size={15} />, onClick: () => downloadItems(targets, { zip: true }) });
      } else {
        items.push({
          label: multi || isDir ? "Download as ZIP" : "Download",
          icon: <Download size={15} />,
          onClick: () => downloadItems(targets),
        });
      }
      if (!multi) items.push({ label: "Share link…", icon: <Share2 size={15} />, onClick: () => openShareDialog(node) });
      if (!multi) items.push({ label: "Rename", icon: <Edit2 size={15} />, onClick: () => setRenamingId(node.id), shortcut: "F2", separatorBefore: true });
      items.push(
        { label: "Move to…", icon: <FolderInput size={15} />, onClick: () => doMoveTo(targets, false), separatorBefore: multi },
        { label: "Copy to…", icon: <Copy size={15} />, onClick: () => doMoveTo(targets, true) },
        { label: "Cut", icon: <Scissors size={15} />, onClick: () => cutToClipboard(targets.map((t) => t.relativePath)), shortcut: "Ctrl+X", separatorBefore: true },
        { label: "Copy", icon: <Copy size={15} />, onClick: () => copyToClipboard(targets.map((t) => t.relativePath)), shortcut: "Ctrl+C" }
      );
      if (!multi && isDir && clipboard.action) {
        items.push({ label: "Paste into folder", icon: <ClipboardPaste size={15} />, onClick: () => paste(node.relativePath) });
      }
      items.push({
        label: allFav ? "Remove star" : "Star",
        icon: <Star size={15} className={allFav ? "text-amber-500" : ""} fill={allFav ? "currentColor" : "none"} />,
        onClick: () => toggleFav(targets),
        separatorBefore: true,
      });
      if (!multi && isDir) {
        items.push({
          label: pinned ? "Unpin from sidebar" : "Pin to sidebar",
          icon: pinned ? <PinOff size={15} /> : <Pin size={15} />,
          onClick: () => togglePin({ id: node.id, name: node.name, href: filesHref(node.relativePath), path: node.relativePath }),
        });
      }
      if (!multi) items.push({ label: "Details", icon: <Info size={15} />, onClick: () => showDetailsFor(node), shortcut: "Alt+Enter" });
      items.push({ label: "Move to Trash", icon: <Trash2 size={15} />, danger: true, onClick: () => trashItems(targets, { confirm: true }), shortcut: "Del", separatorBefore: true });
      return items;
    },
    [isFolder, canWrite, folderPath, clipboard, paste, display, targetsFor, favoriteIds, pins, open, showPath, router, doMoveTo, cutToClipboard, copyToClipboard, toggleFav, togglePin, showDetailsFor, chooseUploadFiles, chooseUploadFolder]
  );

  // ── drag & drop ──
  const [dropActive, setDropActive] = useState(false);
  const dragDepth = useRef(0);

  const handlers: TileHandlers = useMemo(
    () => ({
      onActivate: (node) => open(node),
      onToggleSelect: (node, e) => {
        const idx = indexById.get(node.id) ?? 0;
        setFocusIdx(idx);
        setSelected((prev) => {
          const next = new Set(e.ctrlOrMeta || e.shiftKey ? prev : []);
          if (e.shiftKey && anchor.current !== null) {
            const [a, b] = [Math.min(anchor.current, idx), Math.max(anchor.current, idx)];
            for (let i = a; i <= b; i++) next.add(display[i].id);
          } else if (next.has(node.id)) next.delete(node.id);
          else next.add(node.id);
          return next;
        });
        if (!e.shiftKey) anchor.current = idx;
      },
      onMenu: (node, x, y) => {
        setFocusIdx(indexById.get(node.id) ?? 0);
        setMenu({ x, y, node });
      },
      onRenameCommit: async (node, name) => {
        setRenamingId(null);
        if (name && name !== node.name) await renameItem(node, name);
      },
      onDragStart: (node, e) => {
        const targets = selected.has(node.id) ? display.filter((n) => selected.has(n.id)) : [node];
        e.dataTransfer.setData(LOOM_DRAG_TYPE, JSON.stringify(targets.map((t) => t.relativePath)));
        e.dataTransfer.setData("text/plain", targets.map((t) => t.name).join("\n"));
        e.dataTransfer.effectAllowed = "copyMove";
      },
      onDropOnFolder: async (folder, e) => {
        e.preventDefault();
        e.stopPropagation();
        dragDepth.current = 0;
        setDropActive(false);
        const raw = e.dataTransfer.getData(LOOM_DRAG_TYPE);
        if (raw) {
          const paths: string[] = JSON.parse(raw).filter((p: string) => p !== folder.relativePath);
          if (paths.length === 0) return;
          if (e.altKey || e.ctrlKey) await copyItems(paths, folder.relativePath);
          else await moveItems(paths, folder.relativePath);
        } else if (e.dataTransfer.types.includes("Files")) {
          enqueueFiles(await collectDroppedFiles(e.dataTransfer), folder.relativePath);
        }
      },
    }),
    [open, indexById, display, selected, enqueueFiles]
  );

  // ── keyboard ──
  const colsRef = useRef(1);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu]") || viewerId) return;
      if (document.querySelector("[role=dialog]")) return;
      const mod = e.ctrlKey || e.metaKey;
      const n = display.length;
      const cur = display[focusIdx];
      const move = (to: number) => {
        e.preventDefault();
        const idx = Math.max(0, Math.min(n - 1, to));
        setFocusIdx(idx);
        if (e.shiftKey) {
          if (anchor.current === null) anchor.current = focusIdx;
          const [a, b] = [Math.min(anchor.current, idx), Math.max(anchor.current, idx)];
          setSelected(new Set(display.slice(a, b + 1).map((x) => x.id)));
        }
      };
      const step = viewMode === "grid" ? colsRef.current : 1;
      switch (e.key) {
        case "ArrowRight":
          if (viewMode === "grid") move(focusIdx + 1);
          break;
        case "ArrowLeft":
          if (viewMode === "grid") move(focusIdx - 1);
          break;
        case "ArrowDown":
          move(focusIdx + step);
          break;
        case "ArrowUp":
          move(focusIdx - step);
          break;
        case "Home":
          move(0);
          break;
        case "End":
          move(n - 1);
          break;
        case "Enter":
          if (!cur) return;
          e.preventDefault();
          if (e.altKey) showDetailsFor(cur);
          else open(cur);
          break;
        case " ":
          if (!cur) return;
          e.preventDefault();
          handlers.onToggleSelect(cur, { shiftKey: false, ctrlOrMeta: true });
          break;
        case "Escape":
          if (selected.size) setSelected(new Set());
          else if (clipboard.action) clearClipboard();
          break;
        case "Delete":
        case "Backspace":
          if (e.key === "Backspace" && !mod) return;
          if (selectedNodes.length || cur) {
            e.preventDefault();
            trashItems(selectedNodes.length ? selectedNodes : [cur], { confirm: true });
          }
          break;
        case "F2":
          if (cur && selected.size <= 1) {
            e.preventDefault();
            setRenamingId(cur.id);
          }
          break;
        default:
          if (!mod) return;
          if (e.key === "a" || e.key === "A") {
            e.preventDefault();
            setSelected(new Set(display.map((x) => x.id)));
          } else if (e.key === "c" || e.key === "x") {
            const tg = selectedNodes.length ? selectedNodes : cur ? [cur] : [];
            if (!tg.length) return;
            e.preventDefault();
            (e.key === "c" ? copyToClipboard : cutToClipboard)(tg.map((x) => x.relativePath));
          } else if (e.key === "v" && isFolder && clipboard.action) {
            e.preventDefault();
            paste(folderPath!);
          }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [display, focusIdx, viewMode, selected, selectedNodes, clipboard, isFolder, folderPath, viewerId, handlers, open, paste, copyToClipboard, cutToClipboard, clearClipboard, showDetailsFor]);

  // Keep keyboard focus on the focused tile.
  useEffect(() => {
    const node = display[focusIdx];
    if (!node) return;
    const el = document.querySelector<HTMLElement>(`[data-node-id="${node.id}"]`);
    if (el && document.activeElement && (document.activeElement as HTMLElement).dataset?.nodeId) el.focus({ preventScroll: false });
  }, [focusIdx, display]);

  // ── layout / virtualization ──
  const listRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
      setScrollMargin(el.offsetTop);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    setScrollMargin(el.offsetTop);
  }, [loading, viewMode, display.length, selectionMode]);

  const minTile = (width > 0 && width < 640 ? TILE_MIN_PHONE : TILE_MIN)[gridSize] ?? 184;
  const cols = viewMode === "grid" ? Math.max(1, Math.floor((Math.max(width, 200) - PAD * 2 + GAP) / (minTile + GAP))) : 1;
  colsRef.current = cols;
  const tileW = (Math.max(width, 200) - PAD * 2 - GAP * (cols - 1)) / cols;
  const rowCount = viewMode === "grid" ? Math.ceil(display.length / cols) : display.length;
  const rowHeight = viewMode === "grid" ? tileW + (showPath ? 70 : 56) + GAP : 48;

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scroller,
    estimateSize: () => rowHeight,
    overscan: 6,
    scrollMargin,
  });
  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, cols, virtualizer]);
  useEffect(() => {
    if (display.length === 0) return;
    virtualizer.scrollToIndex(viewMode === "grid" ? Math.floor(focusIdx / cols) : focusIdx, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusIdx]);

  // ── container drop (upload into the current folder) ──
  const containerDrop = isFolder
    ? {
        onDragEnter: (e: React.DragEvent) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          dragDepth.current++;
          setDropActive(true);
        },
        onDragLeave: () => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDropActive(false);
        },
        onDragOver: (e: React.DragEvent) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }
        },
        onDrop: async (e: React.DragEvent) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDropActive(false);
          if (!canWrite) return;
          enqueueFiles(await collectDroppedFiles(e.dataTransfer), folderPath!);
        },
      }
    : {};

  const onFilesPicked = (e: React.ChangeEvent<HTMLInputElement>, keepStructure: boolean) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length && folderPath !== null) {
      enqueueFiles(
        files.map((file) => ({
          file,
          relativePath: keepStructure ? (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name : file.name,
        })),
        folderPath
      );
    }
    e.target.value = "";
  };

  const detailsNode = selectedNodes.length === 1 ? selectedNodes[0] : selectedNodes.length === 0 ? display[focusIdx] ?? null : null;
  const sortLabel: Record<SortKey, string> = { name: "Name", modified: "Date modified", size: "Size", type: "Type" };
  const filters: { key: TypeFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "folders", label: "Folders" },
    { key: "image", label: "Photos" },
    { key: "video", label: "Videos" },
    { key: "audio", label: "Audio" },
    { key: "document", label: "Documents" },
  ];

  // ── render ──
  let body: ReactNode;
  if (loading) {
    body = viewMode === "grid" ? <FileGridSkeleton /> : <FileListSkeleton />;
  } else if (error) {
    body = (
      <div className="flex flex-col items-center justify-center py-24 text-center px-6 text-[hsl(var(--muted-foreground))]">
        <AlertTriangle size={40} strokeWidth={1.4} className="mb-3 text-amber-500" />
        <p className="text-base font-medium text-[hsl(var(--foreground))]">
          {error.status === 403 ? "You don't have access to this folder" : error.status === 404 ? "This folder doesn't exist" : "Couldn't load this folder"}
        </p>
        <p className="text-sm mt-1">{error.status === 404 ? "It may have been moved, renamed or deleted." : error.message}</p>
        <button onClick={() => router.push("/files")} className="mt-4 text-sm text-[hsl(var(--primary))] hover:underline">
          Go to Home
        </button>
      </div>
    );
  } else if (display.length === 0) {
    body =
      nodes.length > 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-[hsl(var(--muted-foreground))]">
          <Search size={40} strokeWidth={1.2} className="mb-3 opacity-50" />
          <p className="text-sm">Nothing matches this filter</p>
          <button onClick={() => setTypeFilter("all")} className="mt-2 text-sm text-[hsl(var(--primary))] hover:underline">
            Show everything
          </button>
        </div>
      ) : (
        emptyState ?? (
          <div className="flex flex-col items-center justify-center py-24 text-[hsl(var(--muted-foreground))] text-center px-6">
            <Folder size={48} strokeWidth={1} className="mb-3 opacity-40" />
            <p className="text-sm font-medium text-[hsl(var(--foreground))]">This folder is empty</p>
            {isFolder && canWrite && (
              <>
                <p className="text-sm mt-1">Drop files here, or</p>
                <div className="flex gap-2 mt-3">
                  <button onClick={chooseUploadFiles} className="px-3 py-1.5 rounded-lg bg-[hsl(var(--primary))] text-white text-sm">
                    Upload files
                  </button>
                  <button onClick={() => createFolder(folderPath!)} className="px-3 py-1.5 rounded-lg border text-sm hover:bg-[hsl(var(--accent))]">
                    New folder
                  </button>
                </div>
              </>
            )}
          </div>
        )
      );
  } else if (viewMode === "grid") {
    body = (
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((row) => {
          const start = row.index * cols;
          const items = display.slice(start, start + cols);
          return (
            <div
              key={row.key}
              className="absolute left-0 right-0 grid"
              style={{
                transform: `translateY(${row.start - scrollMargin}px)`,
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                gap: GAP,
                padding: `0 ${PAD}px`,
              }}
            >
              {items.map((n, i) => (
                <FileTile
                  key={n.id}
                  node={n}
                  selected={selected.has(n.id)}
                  focused={focusIdx === start + i}
                  favorite={favoriteIds.has(n.id)}
                  renaming={renamingId === n.id}
                  selectionMode={selectionMode}
                  showPath={showPath}
                  cut={cutSet?.has(n.relativePath)}
                  folderSize={n.type === "DIRECTORY" ? (folderSizes[n.name] ? formatBytes(folderSizes[n.name].size) : isFolder ? "—" : undefined) : undefined}
                  h={handlers}
                />
              ))}
            </div>
          );
        })}
      </div>
    );
  } else {
    body = (
      <>
        <div role="row" className="flex items-center px-4 h-9 gap-3 text-xs font-medium text-[hsl(var(--muted-foreground))] border-b sticky top-0 bg-[hsl(var(--background))] z-10">
          <span className="w-5" />
          <span className="w-8" />
          {(["name", "modified", "size"] as SortKey[]).map((k) => (
            <button
              key={k}
              onClick={() => {
                setUserSorted(true);
                setSort(k);
              }}
              className={cn(
                "flex items-center gap-1 hover:text-[hsl(var(--foreground))]",
                k === "name" && "flex-1 min-w-0",
                k === "modified" && "w-32 hidden md:flex",
                k === "size" && "w-20 justify-end",
                sortKey === k && (!preserveOrder || userSorted) && "text-[hsl(var(--foreground))]"
              )}
            >
              {sortLabel[k]}
              {sortKey === k && (!preserveOrder || userSorted) && <span>{sortDir === "asc" ? "↑" : "↓"}</span>}
            </button>
          ))}
          <span className="w-7" />
        </div>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((row) => {
            const n = display[row.index];
            return (
              <div key={n.id} className="absolute left-0 right-0" style={{ transform: `translateY(${row.start - scrollMargin}px)`, height: 48 }}>
                <FileRow
                  node={n}
                  selected={selected.has(n.id)}
                  focused={focusIdx === row.index}
                  favorite={favoriteIds.has(n.id)}
                  renaming={renamingId === n.id}
                  selectionMode={selectionMode}
                  showPath={showPath}
                  cut={cutSet?.has(n.relativePath)}
                  folderSize={n.type === "DIRECTORY" ? (folderSizes[n.name] ? formatBytes(folderSizes[n.name].size) : undefined) : undefined}
                  h={handlers}
                />
              </div>
            );
          })}
        </div>
      </>
    );
  }

  return (
    <div className="flex min-h-full">
      <div
        className="flex-1 min-w-0 relative flex flex-col"
        onClick={() => {
          setSelected(new Set());
          anchor.current = null;
        }}
        onContextMenu={(e) => {
          if (!isFolder) return;
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, node: null });
        }}
        {...containerDrop}
      >
        {/* Toolbar / selection bar */}
        <div className="sticky top-0 z-20 bg-[hsl(var(--background)/0.95)] backdrop-blur-sm border-b" onClick={(e) => e.stopPropagation()}>
          {selectionMode ? (
            <div className="flex items-center gap-1 px-3 h-12">
              <button onClick={() => setSelected(new Set())} className="p-2 rounded-md hover:bg-[hsl(var(--accent))]" aria-label="Clear selection">
                <X size={17} />
              </button>
              <span className="text-sm font-medium mr-2">{selected.size} selected</span>
              <div className="flex items-center gap-0.5 ml-auto overflow-x-auto no-scrollbar">
                <BarBtn icon={<Download size={16} />} label="Download" onClick={() => downloadItems(selectedNodes)} />
                <BarBtn icon={<FolderInput size={16} />} label="Move to" onClick={() => doMoveTo(selectedNodes, false)} />
                <BarBtn icon={<Copy size={16} />} label="Copy to" onClick={() => doMoveTo(selectedNodes, true)} />
                <BarBtn icon={<Star size={16} />} label="Star" onClick={() => toggleFav(selectedNodes)} />
                <BarBtn icon={<Info size={16} />} label="Details" onClick={() => setDetailsOpen(!detailsOpen)} />
                <BarBtn icon={<CheckSquare size={16} />} label="Select all" onClick={() => setSelected(new Set(display.map((n) => n.id)))} />
                <BarBtn icon={<Trash2 size={16} />} label="Trash" danger onClick={() => trashItems(selectedNodes, { confirm: true })} />
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 h-12">
              {isFolder && (
                <button
                  disabled={!canWrite}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setNewMenu({ x: r.left, y: r.bottom + 4 });
                  }}
                  className="flex items-center gap-1.5 pl-2.5 pr-3.5 py-1.5 rounded-full bg-[hsl(var(--primary))] text-white text-sm font-medium shadow-sm hover:bg-[hsl(var(--primary)/0.9)] disabled:opacity-50 shrink-0"
                >
                  <Plus size={16} /> New
                </button>
              )}
              <div className="flex items-center gap-1 overflow-x-auto no-scrollbar min-w-0">
                {filters.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setTypeFilter(f.key)}
                    className={cn(
                      "px-2.5 py-1 rounded-full text-xs border whitespace-nowrap transition-colors",
                      typeFilter === f.key ? "bg-[hsl(var(--primary)/0.12)] border-[hsl(var(--primary)/0.4)] text-[hsl(var(--primary))] font-medium" : "hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]"
                    )}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <div className="ml-auto flex items-center gap-1 shrink-0">
                <span className="hidden sm:inline text-xs text-[hsl(var(--muted-foreground))] mr-1">{loading ? "" : `${display.length} item${display.length === 1 ? "" : "s"}`}</span>
                <button
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setSortMenu({ x: r.right - 200, y: r.bottom + 4 });
                  }}
                  className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]"
                  aria-label="Sort"
                >
                  <ArrowUpDown size={14} />
                  <span className="hidden sm:inline">{preserveOrder && !userSorted ? "Relevance" : sortLabel[sortKey]}</span>
                </button>
                <button
                  onClick={() => setDetailsOpen(!detailsOpen)}
                  className={cn("p-1.5 rounded-md hover:bg-[hsl(var(--accent))]", detailsOpen ? "text-[hsl(var(--primary))]" : "text-[hsl(var(--muted-foreground))]")}
                  aria-label="Toggle details panel"
                  title="Details (Alt+Enter)"
                >
                  <SlidersHorizontal size={15} />
                </button>
              </div>
            </div>
          )}
        </div>

        <div ref={listRef} className="flex-1 pt-3 pb-6" role={viewMode === "list" ? "grid" : "list"} aria-label="Files">
          {body}
          {footer}
        </div>

        {dropActive && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-[hsl(var(--primary)/0.06)] border-2 border-dashed border-[hsl(var(--primary))] rounded-lg pointer-events-none">
            <div className="flex flex-col items-center gap-2 p-6 bg-[hsl(var(--card))] rounded-2xl shadow-xl border">
              <UploadCloud size={32} className="text-[hsl(var(--primary))]" />
              <p className="text-base font-semibold">Drop to upload</p>
              <p className="text-sm text-[hsl(var(--muted-foreground))]">to {folderPath ? folderPath.split("/").pop() : "Home"} — folders keep their structure</p>
            </div>
          </div>
        )}

        <input ref={fileInput} type="file" multiple hidden onChange={(e) => onFilesPicked(e, false)} />
        {/* @ts-expect-error webkitdirectory isn't in React's types */}
        <input ref={folderInput} type="file" multiple hidden webkitdirectory="" onChange={(e) => onFilesPicked(e, true)} />
      </div>

      {detailsOpen && (
        <div className="hidden lg:block w-80 shrink-0 sticky top-0 h-[calc(100svh-3.5rem)]">
          <DetailsPanel node={detailsNode} selectionCount={selected.size} onClose={() => setDetailsOpen(false)} />
        </div>
      )}

      {menu && <Menu x={menu.x} y={menu.y} items={menuItems(menu.node)} onClose={() => setMenu(null)} header={menu.node && selected.has(menu.node.id) && selected.size > 1 ? `${selected.size} items` : menu.node?.name} />}
      {newMenu && (
        <Menu
          x={newMenu.x}
          y={newMenu.y}
          onClose={() => setNewMenu(null)}
          items={[
            { label: "Upload files", icon: <UploadCloud size={15} />, onClick: chooseUploadFiles },
            { label: "Upload folder", icon: <FolderUp size={15} />, onClick: chooseUploadFolder },
            { label: "New folder", icon: <FolderPlus size={15} />, onClick: () => createFolder(folderPath!), separatorBefore: true },
            { label: "New text file", icon: <FilePlus size={15} />, onClick: () => createTextFile(folderPath!).then((p) => p && router.push(`${filesHref(folderPath!)}?edit=${encodeURIComponent(p)}`)) },
          ]}
        />
      )}
      {sortMenu && (
        <Menu
          x={sortMenu.x}
          y={sortMenu.y}
          width={200}
          onClose={() => setSortMenu(null)}
          items={[
            ...(["name", "modified", "size", "type"] as SortKey[]).map((k) => ({
              label: sortLabel[k],
              checked: sortKey === k && (!preserveOrder || userSorted),
              onClick: () => {
                setUserSorted(true);
                setSort(k, sortKey === k ? undefined : k === "name" || k === "type" ? "asc" : "desc");
              },
            })),
            { label: "Ascending", checked: sortDir === "asc", separatorBefore: true, onClick: () => { setUserSorted(true); setSort(sortKey, "asc"); } },
            { label: "Descending", checked: sortDir === "desc", onClick: () => { setUserSorted(true); setSort(sortKey, "desc"); } },
          ]}
        />
      )}

      {viewerIndex >= 0 && (
        <MediaViewer
          nodes={viewerFiles}
          index={viewerIndex}
          startEditing={viewerEdit}
          onIndexChange={(i) => {
            setViewerEdit(false);
            setViewerId(viewerFiles[i].id);
          }}
          onClose={() => {
            setViewerId(null);
            setViewerEdit(false);
            if (editPath) router.replace(filesHref(folderPath ?? ""));
          }}
          onShowDetails={(n) => {
            setViewerId(null);
            showDetailsFor(n);
          }}
        />
      )}
    </div>
  );
}

function BarBtn({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={cn(
        "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm whitespace-nowrap transition-colors",
        danger ? "text-red-500 hover:bg-red-500/10" : "hover:bg-[hsl(var(--accent))]"
      )}
    >
      {icon}
      <span className="hidden md:inline">{label}</span>
    </button>
  );
}
