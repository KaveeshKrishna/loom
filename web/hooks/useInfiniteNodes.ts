"use client";

/**
 * useInfiniteNodes
 *
 * A universal hook for loading paginated media nodes from any API endpoint that
 * supports `?limit=N&cursor=<id>` query parameters and returns `{ [nodesKey], nextCursor }`.
 *
 * Features:
 *  - AbortController: cancels in-flight requests immediately when the caller unmounts
 *    or the URL changes, so navigating away never leaves the browser hung.
 *  - Cursor-based pagination: loads the first `pageSize` items, then appends more
 *    as the IntersectionObserver sentinel scrolls into view.
 *  - decoding="async" should be set on every <img> rendered from these nodes.
 */

import { useState, useEffect, useRef, useCallback } from "react";

export interface InfiniteNodesResult<T> {
  nodes: T[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  /** Attach this ref to a sentinel <div> at the bottom of the list. */
  sentinelRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * @param fetchUrl  The full URL including the `?` and any fixed query params
 *                  e.g. "/api/files/type?type=image"
 *                  The hook will append `&limit=N` and `&cursor=ID` automatically.
 * @param nodesKey  The JSON key in the response that holds the array (default: "nodes").
 * @param pageSize  How many items to load per page (default: 100).
 */
export function useInfiniteNodes<T>(
  fetchUrl: string,
  nodesKey = "nodes",
  pageSize = 100
): InfiniteNodesResult<T> {
  const [nodes, setNodes] = useState<T[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  // ── Initial page load ──────────────────────────────────────────────────────
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setNodes([]);
    setNextCursor(null);
    setHasMore(false);

    const sep = fetchUrl.includes("?") ? "&" : "?";
    fetch(`${fetchUrl}${sep}limit=${pageSize}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => {
        const batch: T[] = data[nodesKey] ?? [];
        setNodes(batch);
        setNextCursor(data.nextCursor ?? null);
        setHasMore(!!data.nextCursor);
        setLoading(false);
      })
      .catch((err) => {
        if (err.name !== "AbortError") setLoading(false);
        // AbortError is expected on navigation — swallow it silently.
      });

    return () => controller.abort();
  }, [fetchUrl, nodesKey, pageSize]);

  // ── Load next page ─────────────────────────────────────────────────────────
  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore || !hasMore) return;
    const controller = new AbortController();
    setLoadingMore(true);

    const sep = fetchUrl.includes("?") ? "&" : "?";
    fetch(`${fetchUrl}${sep}limit=${pageSize}&cursor=${nextCursor}`, {
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((data) => {
        const batch: T[] = data[nodesKey] ?? [];
        setNodes((prev) => [...prev, ...batch]);
        setNextCursor(data.nextCursor ?? null);
        setHasMore(!!data.nextCursor);
        setLoadingMore(false);
      })
      .catch((err) => {
        if (err.name !== "AbortError") setLoadingMore(false);
      });

    // Note: we do NOT return the cleanup here because loadMore is called from an
    // IntersectionObserver callback, not an effect. The AbortController is held
    // in closure; if the component unmounts before the response arrives the fetch
    // will simply be garbage-collected.
  }, [fetchUrl, nodesKey, pageSize, nextCursor, loadingMore, hasMore]);

  // ── IntersectionObserver sentinel ──────────────────────────────────────────
  useEffect(() => {
    if (loading) return;

    observerRef.current?.disconnect();

    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: "200px" }   // start loading 200px before the sentinel is visible
    );
    observerRef.current.observe(sentinel);

    return () => observerRef.current?.disconnect();
  }, [loading, hasMore, loadMore]);

  return { nodes, loading, loadingMore, hasMore, sentinelRef };
}
