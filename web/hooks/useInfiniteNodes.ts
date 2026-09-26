"use client";

/**
 * useInfiniteNodes — cursor-paginated lists (Photos, Videos, Documents,
 * Starred). Loads the first page, then more as the sentinel scrolls into
 * view. Every request is abortable, errors are surfaced, and the list
 * reloads itself (quietly) when live updates say something changed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useDirChanges } from "@/lib/client/live";

export interface InfiniteNodesResult<T> {
  nodes: T[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: { status: number; message: string } | null;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  reload: () => void;
}

export function useInfiniteNodes<T>(fetchUrl: string, nodesKey = "nodes", pageSize = 150, map?: (item: unknown) => T): InfiniteNodesResult<T> {
  const [nodes, setNodes] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const mapRef = useRef(map);
  mapRef.current = map;
  const sep = fetchUrl.includes("?") ? "&" : "?";

  const fetchPage = useCallback(
    async (after: string | null, signal: AbortSignal) => {
      const res = await fetch(`${fetchUrl}${sep}limit=${pageSize}${after ? `&cursor=${encodeURIComponent(after)}` : ""}`, { signal });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
      const raw: unknown[] = data[nodesKey] ?? [];
      return { items: (mapRef.current ? raw.map(mapRef.current) : raw) as T[], next: (data.nextCursor as string | null) ?? null };
    },
    [fetchUrl, sep, pageSize, nodesKey]
  );

  const loadFirst = useCallback(
    async (silent: boolean) => {
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      if (!silent) {
        setLoading(true);
        setNodes([]);
      }
      try {
        const { items, next } = await fetchPage(null, c.signal);
        setNodes((prev) => (silent && prev.length > items.length ? [...items, ...prev.slice(items.length)] : items));
        setCursor(next);
        setError(null);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        if (!silent) setError({ status: (err as { status?: number }).status ?? 0, message: (err as Error).message });
      } finally {
        if (!c.signal.aborted) setLoading(false);
      }
    },
    [fetchPage]
  );

  useEffect(() => {
    loadFirst(false);
    return () => ctrl.current?.abort();
  }, [loadFirst]);

  useDirChanges(null, () => loadFirst(true), 1500);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    const c = new AbortController();
    ctrl.current = c;
    setLoadingMore(true);
    try {
      const { items, next } = await fetchPage(cursor, c.signal);
      setNodes((prev) => [...prev, ...items]);
      setCursor(next);
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError({ status: 0, message: (err as Error).message });
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, fetchPage]);

  useEffect(() => {
    if (loading || !cursor) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && loadMore(), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loading, cursor, loadMore]);

  return { nodes, loading, loadingMore, hasMore: !!cursor, error, sentinelRef, reload: () => loadFirst(true) };
}
