"use client";

/** Data hooks shared by the file views. */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { useDirChanges, useLiveConnected } from "./live";
import type { LNode } from "./types";

/** Children of a folder, kept fresh by live updates (no spinner on refresh). */
export function useFolder(path: string) {
  const [nodes, setNodes] = useState<LNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [canWrite, setCanWrite] = useState(true);
  const seq = useRef(0);

  const load = useCallback(
    async (silent: boolean) => {
      const my = ++seq.current;
      if (!silent) setLoading(true);
      try {
        const data = await api<{ children: LNode[]; canWrite?: boolean }>(`/api/files?path=${encodeURIComponent(path)}`);
        if (my !== seq.current) return;
        setNodes(data.children);
        setCanWrite(data.canWrite !== false);
        setError(null);
      } catch (err) {
        if (my !== seq.current) return;
        if (!silent) {
          setNodes([]);
          setError({ status: err instanceof ApiError ? err.status : 0, message: (err as Error).message });
        }
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    [path]
  );

  useEffect(() => {
    setNodes([]);
    load(false);
  }, [load]);

  useEffect(() => {
    const h = () => load(true);
    window.addEventListener("loom-refresh", h);
    return () => window.removeEventListener("loom-refresh", h);
  }, [load]);

  useDirChanges(path, () => load(true));

  // Without a live connection, poll while thumbnails are still being made.
  const connected = useLiveConnected();
  const processing = nodes.some((n) => n.processing);
  useEffect(() => {
    if (connected || !processing) return;
    const t = setInterval(() => load(true), 4000);
    return () => clearInterval(t);
  }, [connected, processing, load]);

  return { nodes, loading, error, canWrite, reload: () => load(true) };
}

/** Sizes of the sub-folders of `path` (one request for all tiles). */
export function useFolderSizes(path: string | null, enabled: boolean) {
  const [sizes, setSizes] = useState<Record<string, { size: string; files: number }>>({});
  const load = useCallback(async () => {
    if (path === null || !enabled) return;
    try {
      const d = await api<{ sizes: Record<string, { size: string; files: number }> }>(`/api/files/folder-sizes?path=${encodeURIComponent(path)}`);
      setSizes(d.sizes);
    } catch {
      /* sizes are decorative */
    }
  }, [path, enabled]);
  useEffect(() => {
    setSizes({});
    load();
  }, [load]);
  useDirChanges(path, () => load(), 1500);
  return sizes;
}

/** The user's starred item ids, shared by every view. */
let favCache: Set<string> | null = null;
const favSubs = new Set<(s: Set<string>) => void>();
let favLoading: Promise<void> | null = null;

async function loadFavs() {
  try {
    const d = await api<{ ids: string[] }>("/api/favorites?ids=1");
    favCache = new Set(d.ids);
    favSubs.forEach((s) => s(favCache!));
  } catch {
    /* ignore */
  }
}

export function setFavoriteLocal(id: string, fav: boolean) {
  const next = new Set(favCache ?? []);
  if (fav) next.add(id);
  else next.delete(id);
  favCache = next;
  favSubs.forEach((s) => s(next));
}

export function useFavoriteIds(): Set<string> {
  const [ids, setIds] = useState<Set<string>>(favCache ?? new Set());
  useEffect(() => {
    favSubs.add(setIds);
    if (!favCache && !favLoading) favLoading = loadFavs().finally(() => (favLoading = null));
    else if (favCache) setIds(favCache);
    return () => {
      favSubs.delete(setIds);
    };
  }, []);
  return ids;
}
