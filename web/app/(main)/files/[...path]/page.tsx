"use client";

import { useCallback, useEffect, useState, useMemo, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { FileGrid } from "@/components/files/FileGrid";
import { FileList } from "@/components/files/FileList";
import { FileGridSkeleton, FileListSkeleton } from "@/components/files/FileSkeletons";
import { MediaViewer, type MediaSibling } from "@/components/viewer/MediaViewer";
import type { FileNode, Thumbnail, Preview } from "@prisma/client";
import { useTopBar } from "@/components/layout/TopBarContext";
import { useContextMenu } from "@/hooks/useContextMenu";
import { EmptySpaceContextMenu } from "@/components/files/EmptySpaceContextMenu";
import { useUpload } from "@/components/layout/UploadContext";
import { useSelection } from "@/hooks/useSelection";
import { Trash, CheckSquare } from "lucide-react";

import { sortNodes } from "@/lib/utils";

type FileNodeWithThumbnail = FileNode & { contentIdentity: ({ thumbnail: Thumbnail | null; preview: Preview | null }) | null };

export default function FilesPage() {
  // Derived from the live URL rather than useParams(): the latter reflects
  // whatever params this route instance was matched/rendered with, which in
  // a fully static export (the public demo build's `output: "export"`) is
  // fixed at build time to a single placeholder value and never updates —
  // not on client-side navigation, and not even across a hard reload of a
  // deep-linked folder URL. usePathname() always tracks the real address
  // bar in both the real server-rendered app and the demo, so this works
  // identically in both.
  const pathname = usePathname();
  const router = useRouter();
  const pathSegments = useMemo(() => {
    const rel = pathname.replace(/^\/files\/?/, "");
    return rel ? rel.split("/").map(decodeURIComponent) : [];
  }, [pathname]);
  const currentPath = pathSegments.join("/");

  const [nodes, setNodes] = useState<FileNodeWithThumbnail[]>([]);
  const [searchNodes, setSearchNodes] = useState<FileNodeWithThumbnail[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const { viewMode, setBreadcrumbs, searchQuery, searchGlobal } = useTopBar();
  const emptySpaceContextMenu = useContextMenu();
  const { enqueueFiles } = useUpload();
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  
  
  const sortedNodes = useMemo(() => sortNodes(nodes), [nodes]);
  const sortedSearchNodes = useMemo(() => searchNodes ? sortNodes(searchNodes) : null, [searchNodes]);

  const { selectedIds, toggleSelection, clearSelection, selectAll } = useSelection(nodes.map(n => n.id));

  useEffect(() => {
    const crumbs = [{ label: "Home", href: "/files" }];
    let current = "/files";
    for (const segment of pathSegments) {
      if (!segment) continue;
      current += `/${segment}`;
      crumbs.push({ label: segment, href: current });
    }
    setBreadcrumbs(crumbs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath, setBreadcrumbs]);

  const [viewer, setViewer] = useState<{
    node: FileNodeWithThumbnail;
    siblings: MediaSibling[];
  } | null>(null);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const controller = new AbortController();
    const fetchFiles = () => {
      setLoading(true);
      fetch(`/api/files?path=${encodeURIComponent(currentPath)}`, { signal: controller.signal })
        .then((r) => r.json())
        .then((data) => {
          setNodes(data.children ?? []);
          setLoading(false);
        })
        .catch((err) => { if (err.name !== "AbortError") setLoading(false); });

      fetch("/api/favorites", { signal: controller.signal })
        .then((r) => r.json())
        .then((data) => {
          const ids = (data.favorites ?? []).map(
            (f: { fileNodeId: string }) => f.fileNodeId
          );
          setFavoriteIds(new Set(ids));
        })
        .catch(() => {});
    };

    fetchFiles();

    const handleRefresh = () => fetchFiles();
    window.addEventListener("loom-refresh", handleRefresh);

    return () => {
      window.removeEventListener("loom-refresh", handleRefresh);
      controller.abort();
    };
  }, [currentPath]);

  useEffect(() => {
    const controller = new AbortController();
    if (searchQuery && !searchGlobal) {
      setSearching(true);
      fetch(`/api/search?q=${encodeURIComponent(searchQuery)}&folder=${encodeURIComponent(currentPath)}`, { signal: controller.signal })
        .then((r) => r.json())
        .then((data) => {
          setSearchNodes(data.results ?? []);
          setSearching(false);
        })
        .catch((err) => { if (err.name !== "AbortError") setSearching(false); });
    } else {
      setSearchNodes(null);
    }
    return () => controller.abort();
  }, [searchQuery, searchGlobal, currentPath]);

  const navigate = useCallback(
    (node: FileNodeWithThumbnail) => {
      if (node.type === "DIRECTORY") {
        router.push(`/files/${node.relativePath}`);
      } else {
        const displayNodes = sortedSearchNodes ?? sortedNodes;
        const siblings: MediaSibling[] = displayNodes
          .filter((n) => n.type === "FILE")
          .map((n) => ({
            id: n.id,
            name: n.name,
            relativePath: n.relativePath,
            mimeType: n.mimeType,
            cachePath: n.contentIdentity?.preview?.cachePath ?? n.contentIdentity?.thumbnail?.cachePath,
          }));
        setViewer({ node, siblings });
      }
    },
    [sortedNodes, sortedSearchNodes, router]
  );

  const toggleFavorite = async (nodeId: string) => {
    const res = await fetch("/api/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileNodeId: nodeId }),
    });
    const data = await res.json();
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      if (data.favorited) next.add(nodeId);
      else next.delete(nodeId);
      return next;
    });
  };

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes("Files")) setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setIsDragOver(false); }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    const entries = files.map((file) => ({
      file,
      relativePath: file.name,
    }));
    enqueueFiles(entries, currentPath || "");
  }, [enqueueFiles, currentPath]);

  const handleBulkTrash = async () => {
    if (selectedIds.size === 0) return;
    try {
      const sourceNodes = searchNodes ?? nodes;
      const pathsToTrash = sourceNodes
        .filter(n => selectedIds.has(n.id))
        .map(n => n.relativePath);

      await fetch("/api/fs/trash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: pathsToTrash })
      });
      window.dispatchEvent(new Event("loom-refresh"));
      clearSelection();
    } catch (e) {
      console.error(e);
    }
  };

  if (loading || (searching && !searchNodes)) {
    return viewMode === "grid" ? <FileGridSkeleton /> : <FileListSkeleton />;
  }

  const displayNodes = sortedSearchNodes ?? sortedNodes;
  const filteredNodes = searchGlobal ? sortedNodes : displayNodes;
  const isSearchActive = !searchGlobal && !!searchQuery;

  return (
    <div 
      className="min-h-full relative" 
      onClick={() => clearSelection()}
      onContextMenu={(e) => {
        e.preventDefault();
        emptySpaceContextMenu.open(e, null);
      }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {selectedIds.size > 0 && (
        <div className="sticky top-0 z-20 bg-[hsl(var(--accent))] border-b px-4 py-2 flex items-center justify-between shadow-sm">
          <div className="flex items-center gap-4 text-sm font-medium">
            <span className="bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] px-2 py-0.5 rounded-full text-xs">{selectedIds.size}</span>
            items selected
          </div>
          <div className="flex items-center gap-2">
            <button onClick={(e) => { e.stopPropagation(); selectAll(); }} className="p-2 hover:bg-[hsl(var(--background))] rounded-md text-sm flex items-center gap-1">
              <CheckSquare size={16} /> Select All
            </button>
            <button onClick={(e) => { e.stopPropagation(); handleBulkTrash(); }} className="p-2 hover:bg-red-500 hover:text-white text-red-500 rounded-md text-sm flex items-center gap-1 transition-colors">
              <Trash size={16} /> Trash
            </button>
          </div>
        </div>
      )}

      {isDragOver && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-[hsl(var(--primary)/0.06)] border-2 border-dashed border-[hsl(var(--primary))] rounded-lg pointer-events-none">
          <div className="flex flex-col items-center gap-3 p-8 bg-[hsl(var(--card))] rounded-2xl shadow-xl border border-[hsl(var(--border))]">
            <div className="w-16 h-16 rounded-full bg-[hsl(var(--primary)/0.1)] flex items-center justify-center">
              <svg className="w-8 h-8 text-[hsl(var(--primary))]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>
            <div className="text-center">
              <p className="text-base font-semibold text-[hsl(var(--foreground))]">Drop files to upload</p>
              <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">to <span className="font-medium">{currentPath || "Home"}</span></p>
            </div>
          </div>
        </div>
      )}

      {viewMode === "grid" ? (
        <FileGrid
          nodes={filteredNodes}
          onNavigate={navigate}
          onFavorite={toggleFavorite}
          favoriteIds={favoriteIds}
          showPath={isSearchActive}
          selectedIds={selectedIds}
          onSelect={toggleSelection}
        />
      ) : (
        <FileList
          nodes={filteredNodes}
          onNavigate={navigate}
          onFavorite={toggleFavorite}
          favoriteIds={favoriteIds}
          showPath={isSearchActive}
          selectedIds={selectedIds}
          onSelect={toggleSelection}
        />
      )}

      {emptySpaceContextMenu.isOpen && emptySpaceContextMenu.position && (
        <EmptySpaceContextMenu 
          position={emptySpaceContextMenu.position} 
          currentPath={currentPath}
          onClose={emptySpaceContextMenu.close} 
        />
      )}

      {viewer && (
        <MediaViewer
          relativePath={viewer.node.relativePath}
          cachePath={viewer.node.contentIdentity?.preview?.cachePath || viewer.node.contentIdentity?.thumbnail?.cachePath}
          name={viewer.node.name}
          mimeType={viewer.node.mimeType}
          onClose={() => setViewer(null)}
          siblings={viewer.siblings}
          currentId={viewer.node.id}
          onNavigateTo={(s) => {
            const fullNode = nodes.find((n) => n.id === s.id)
              ?? searchNodes?.find((n) => n.id === s.id);
            if (fullNode) setViewer((v) => v ? { ...v, node: fullNode } : null);
          }}
        />
      )}
    </div>
  );
}
