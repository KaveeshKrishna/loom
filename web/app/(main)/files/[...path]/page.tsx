"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { FileGrid } from "@/components/files/FileGrid";
import { FileList } from "@/components/files/FileList";
import { MediaViewer, type MediaSibling } from "@/components/viewer/MediaViewer";
import { Loader2 } from "lucide-react";
import type { FileNode, Thumbnail, Preview } from "@prisma/client";
import { useTopBar } from "@/components/layout/TopBarContext";

type FileNodeWithThumbnail = FileNode & { thumbnail: Thumbnail | null, preview: Preview | null };

export default function FilesPage() {
  const params = useParams();
  const router = useRouter();
  const pathSegments = Array.isArray(params.path)
    ? params.path.map(decodeURIComponent)
    : params.path
    ? [decodeURIComponent(params.path as string)]
    : [];
  const currentPath = pathSegments.join("/");

  const [nodes, setNodes] = useState<FileNodeWithThumbnail[]>([]);
  const [searchNodes, setSearchNodes] = useState<FileNodeWithThumbnail[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const { viewMode, setBreadcrumbs, searchQuery, searchGlobal } = useTopBar();
  
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
    setLoading(true);
    fetch(`/api/files?path=${encodeURIComponent(currentPath)}`)
      .then((r) => r.json())
      .then((data) => {
        setNodes(data.children ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));

    fetch("/api/favorites")
      .then((r) => r.json())
      .then((data) => {
        const ids = (data.favorites ?? []).map(
          (f: { fileNodeId: string }) => f.fileNodeId
        );
        setFavoriteIds(new Set(ids));
      })
      .catch(() => {});
  }, [currentPath]);

  useEffect(() => {
    if (searchQuery && !searchGlobal) {
      setSearching(true);
      fetch(`/api/search?q=${encodeURIComponent(searchQuery)}&folder=${encodeURIComponent(currentPath)}`)
        .then((r) => r.json())
        .then((data) => {
          setSearchNodes(data.results ?? []);
          setSearching(false);
        })
        .catch(() => setSearching(false));
    } else {
      setSearchNodes(null);
    }
  }, [searchQuery, searchGlobal, currentPath]);

  const navigate = useCallback(
    (node: FileNodeWithThumbnail) => {
      if (node.type === "DIRECTORY") {
        router.push(`/files/${node.relativePath}`);
      } else {
      const siblings: MediaSibling[] = nodes
        .filter((n) => n.type === "FILE")
        .map((n) => ({
          id: n.id,
          name: n.name,
          relativePath: n.relativePath,
          mimeType: n.mimeType,
          cachePath: n.preview?.cachePath || n.thumbnail?.cachePath,
        }));
      setViewer({ node, siblings });
      }
    },
    [nodes, router]
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



  if (loading || (searching && !searchNodes)) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 size={24} className="animate-spin text-[hsl(var(--muted-foreground))]" />
      </div>
    );
  }

  const displayNodes = searchNodes ?? nodes;
  const filteredNodes = searchGlobal ? nodes : displayNodes;
  const isSearchActive = !searchGlobal && !!searchQuery;

  return (
    <>
      {viewMode === "grid" ? (
        <FileGrid
          nodes={filteredNodes}
          onNavigate={navigate}
          onFavorite={toggleFavorite}
          favoriteIds={favoriteIds}
          showPath={isSearchActive}
        />
      ) : (
        <FileList
          nodes={filteredNodes}
          onNavigate={navigate}
          onFavorite={toggleFavorite}
          favoriteIds={favoriteIds}
          showPath={isSearchActive}
        />
      )}

      {viewer && (
        <MediaViewer
          relativePath={viewer.node.relativePath}
          cachePath={viewer.node.preview?.cachePath || viewer.node.thumbnail?.cachePath}
          name={viewer.node.name}
          mimeType={viewer.node.mimeType}
          onClose={() => setViewer(null)}
          siblings={viewer.siblings}
          currentId={viewer.node.id}
          onNavigateTo={(s) => {
            const fullNode = nodes.find((n) => n.id === s.id);
            if (fullNode) setViewer((v) => v ? { ...v, node: fullNode } : null);
          }}
        />
      )}
    </>
  );
}
