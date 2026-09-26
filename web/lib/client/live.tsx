"use client";

/**
 * Live updates in the browser.
 *
 * One EventSource per tab listens to /api/events. Components subscribe to
 * "this folder changed" with useDirChanges(). Local actions (an upload in
 * this tab finishing, a rename) also announce changes through the same bus,
 * so the UI updates immediately even if a proxy blocks the event stream.
 *
 * The demo build has no server, so it only uses the local bus.
 */

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

type Listener = (dirs: string[], nodeIds: string[], reason?: string) => void;

const listeners = new Set<Listener>();

/** Announce that these folders changed ("*" = everything). */
export function emitDirChange(dirs: string[], nodeIds: string[] = [], reason?: string) {
  for (const l of listeners) {
    try {
      l(dirs, nodeIds, reason);
    } catch {
      /* ignore */
    }
  }
}

const LiveContext = createContext<{ connected: boolean }>({ connected: false });

export function LiveProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_DEMO_MODE === "1" || typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const open = () => {
      es = new EventSource("/api/events");
      es.onopen = () => setConnected(true);
      es.onerror = () => {
        setConnected(false);
        // EventSource retries by itself; if the server returned an error
        // (e.g. signed out) it gives up, so reopen slowly.
        if (es && es.readyState === EventSource.CLOSED && !closed) {
          retry = setTimeout(open, 15_000);
        }
      };
      es.onmessage = (msg) => {
        try {
          const ev = JSON.parse(msg.data);
          if (ev.type === "changed") emitDirChange(ev.dirs ?? ["*"], ev.nodeIds ?? [], ev.reason);
        } catch {
          /* ignore malformed */
        }
      };
    };
    open();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }, []);

  return <LiveContext.Provider value={{ connected }}>{children}</LiveContext.Provider>;
}

export function useLiveConnected(): boolean {
  return useContext(LiveContext).connected;
}

/** Called (not debounced) for every event whose reason matches. */
export function useChangeReason(reason: string, onEvent: (nodeIds: string[]) => void) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    const l: Listener = (_dirs, nodeIds, r) => {
      if (r === reason) cb.current(nodeIds);
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, [reason]);
}

/**
 * Call `onChange` (debounced) when `dir` — or anything, if dir is null —
 * changes. Stable across renders; the latest callback is always used.
 */
export function useDirChanges(dir: string | null, onChange: (nodeIds: string[]) => void, debounceMs = 300) {
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pendingIds: string[] = [];
    const l: Listener = (dirs, nodeIds) => {
      if (dir !== null && !dirs.includes("*") && !dirs.includes(dir)) return;
      pendingIds.push(...nodeIds);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const ids = pendingIds;
        pendingIds = [];
        cb.current(ids);
      }, debounceMs);
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
      if (timer) clearTimeout(timer);
    };
  }, [dir, debounceMs]);
}
