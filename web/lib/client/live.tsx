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

// ─── background jobs (e.g. copies) ───────────────────────────────────────────

export interface JobEvent {
  id: string;
  kind: string;
  status: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | string;
  progress?: number;
  bytesDone?: number;
  bytesTotal?: number;
  filesDone?: number;
  filesTotal?: number;
  summary?: { done: number; skipped: number; failed: number; errors: { path: string; error: string }[] };
  error?: string;
}

const jobListeners = new Set<(ev: JobEvent) => void>();

/** Listen for background job progress. Returns an unsubscribe function. */
export function onJobEvent(fn: (ev: JobEvent) => void): () => void {
  jobListeners.add(fn);
  return () => {
    jobListeners.delete(fn);
  };
}

interface LiveState {
  connected: boolean;
  /** The connection has been down for a few seconds (Loom restarting or offline) */
  lost: boolean;
  /** Loom came back running different code: this page is out of date */
  updated: boolean;
}

const LiveContext = createContext<LiveState>({ connected: false, lost: false, updated: false });

/** Loom's build id, or null when it can't be reached. */
async function serverBuild(): Promise<string | null> {
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    if (!r.ok) return null;
    return ((await r.json()) as { build?: string }).build ?? null;
  } catch {
    return null;
  }
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [lost, setLost] = useState(false);
  const [updated, setUpdated] = useState(false);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_DEMO_MODE === "1" || typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let lostTimer: ReturnType<typeof setTimeout> | null = null;
    let wasLost = false;
    let closed = false;

    const checkBuild = async () => {
      const mine = process.env.NEXT_PUBLIC_LOOM_BUILD;
      const theirs = await serverBuild();
      if (mine && theirs && theirs !== mine && theirs !== "dev") setUpdated(true);
    };

    // While the stream is down, ask /api/health every few seconds and reconnect as soon as it answers.
    let lastOpen = 0;
    const waitForServer = async () => {
      if (closed) return;
      if ((await serverBuild()) == null) {
        retry = setTimeout(waitForServer, 4000);
      } else if (Date.now() - lastOpen < 10_000) {
        // Loom is up but refuses the stream (e.g. signed out): don't hammer it.
        retry = setTimeout(open, 15_000);
      } else {
        open();
      }
    };

    const open = () => {
      if (closed) return;
      lastOpen = Date.now();
      es?.close();
      es = new EventSource("/api/events");
      es.onopen = () => {
        setConnected(true);
        if (lostTimer) clearTimeout(lostTimer);
        lostTimer = null;
        setLost(false);
        if (wasLost) void checkBuild();
        wasLost = false;
      };
      es.onerror = () => {
        setConnected(false);
        wasLost = true;
        lostTimer ??= setTimeout(() => setLost(true), 4000);
        // EventSource retries by itself, but gives up when the server answered
        // with an error (e.g. a proxy's 502 while Loom restarts): take over.
        if (es && es.readyState === EventSource.CLOSED && !closed) {
          if (retry) clearTimeout(retry);
          retry = setTimeout(waitForServer, 2000);
        }
      };
      es.onmessage = (msg) => {
        try {
          const ev = JSON.parse(msg.data);
          if (ev.type === "changed") emitDirChange(ev.dirs ?? ["*"], ev.nodeIds ?? [], ev.reason);
          else if (ev.type === "job" && ev.job) jobListeners.forEach((l) => l(ev.job));
        } catch {
          /* ignore malformed */
        }
      };
    };
    open();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (lostTimer) clearTimeout(lostTimer);
      es?.close();
    };
  }, []);

  return <LiveContext.Provider value={{ connected, lost, updated }}>{children}</LiveContext.Provider>;
}

/** Whether Loom is reachable, and whether it was updated since this page loaded. */
export function useLiveStatus(): LiveState {
  return useContext(LiveContext);
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
 * A steady stream of changes (a long upload into this folder) still calls
 * it at least every `maxWaitMs`.
 */
export function useDirChanges(dir: string | null, onChange: (nodeIds: string[]) => void, debounceMs = 300, maxWaitMs = 1500) {
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pendingIds: string[] = [];
    let firstPending = 0;
    const fire = () => {
      timer = null;
      firstPending = 0;
      const ids = pendingIds;
      pendingIds = [];
      cb.current(ids);
    };
    const l: Listener = (dirs, nodeIds) => {
      if (dir !== null && !dirs.includes("*") && !dirs.includes(dir)) return;
      pendingIds.push(...nodeIds);
      const now = Date.now();
      if (!firstPending) firstPending = now;
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, Math.max(0, Math.min(debounceMs, firstPending + maxWaitMs - now)));
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
      if (timer) clearTimeout(timer);
    };
  }, [dir, debounceMs, maxWaitMs]);
}
