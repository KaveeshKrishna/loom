"use client";

/**
 * UploadContext — the browser side of Loom's chunked upload protocol
 * (server side: web/lib/uploads.ts).
 *
 *  - Each file is sent in chunks (size chosen by the server, 32 MB by
 *    default) so uploads work behind proxies with request-size limits and
 *    memory stays flat for huge videos.
 *  - Every chunk carries its SHA-256 (when the browser allows it — Web
 *    Crypto needs HTTPS or localhost); the server rejects corrupted chunks
 *    and they are re-sent automatically.
 *  - Network errors retry with backoff. If the tab is reloaded, choosing
 *    the same file again resumes from the last acknowledged byte.
 *  - An upload is "done" the moment its last byte is stored. Thumbnails and
 *    previews are generated afterwards in the background and appear on
 *    their own via live updates.
 *
 * State and actions live in separate contexts so pages that only need
 * enqueueFiles() don't re-render on every progress tick.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { emitDirChange, useChangeReason } from "@/lib/client/live";
import { parentOf } from "@/lib/client/api";
import { resolveConflicts, type ConflictInfo } from "@/components/files/CollisionDialog";
import { toast } from "@/components/ui/Toaster";

export type UploadStatus = "pending" | "uploading" | "finalizing" | "done" | "error" | "cancelled";

export interface UploadEntry {
  id: string;
  file: File;
  /** Path inside the destination (folder uploads include sub-folders) */
  relativePath: string;
  destDir: string;
  status: UploadStatus;
  progress: number; // 0–100
  bytesSent: number;
  /** Bytes per second, smoothed */
  speed: number;
  error?: string;
  finalPath?: string;
  renamed?: boolean;
  /** Thumbnail/preview is being generated in the background */
  processing?: boolean;
  nodeId?: string;
  resumed?: boolean;
  /** What to do if the name is taken when it finishes (asked beforehand). */
  conflict?: "replace" | "keep_both";
  replaced?: boolean;
}

/** An upload the server still has partial data for (e.g. after a crash or a closed tab). */
export interface UnfinishedUpload {
  id: string;
  destDir: string;
  relativePath: string;
  size: number;
  received: number;
}

interface UploadActions {
  enqueueFiles: (files: { file: File; relativePath: string }[], destDir: string) => void;
  cancelUpload: (id: string) => void;
  retryUpload: (id: string) => void;
  dismissUpload: (id: string) => void;
  clearCompleted: () => void;
  setVisible: (v: boolean) => void;
  /** Throw away the partial data of every unfinished upload (frees the disk space now). */
  discardUnfinished: () => Promise<void>;
}

interface UploadState {
  uploads: UploadEntry[];
  isVisible: boolean;
  unfinished: UnfinishedUpload[];
}

const ActionsContext = createContext<UploadActions | null>(null);
const StateContext = createContext<UploadState | null>(null);

const MAX_PARALLEL = 3;
const MAX_RETRIES = 8;
const RESUME_KEY = "loom-upload-resume";

function sessionKey(destDir: string, relativePath: string, size: number) {
  return `${destDir}\n${relativePath}\n${size}`;
}

function resumeKey(e: { destDir: string; relativePath: string; file: File }) {
  return `${e.destDir}|${e.relativePath}|${e.file.size}|${e.file.lastModified}`;
}

function loadResumeMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(RESUME_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveResume(key: string, sessionId: string | null) {
  try {
    const map = loadResumeMap();
    if (sessionId) map[key] = sessionId;
    else delete map[key];
    localStorage.setItem(RESUME_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable */
  }
}

class UploadError extends Error {
  constructor(message: string, public status: number, public body: Record<string, unknown> = {}) {
    super(message);
  }
}

async function jsonRequest(url: string, init: RequestInit, signal: AbortSignal) {
  const res = await fetch(url, { ...init, signal });
  let body: Record<string, unknown> = {};
  try {
    body = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) throw new UploadError((body.error as string) || `Server error ${res.status}`, res.status, body);
  return body;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string | null> {
  if (typeof crypto === "undefined" || !crypto.subtle) return null;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** PUT one chunk with XHR so we get byte-level progress. */
function putChunk(
  url: string,
  body: ArrayBuffer,
  sha: string | null,
  signal: AbortSignal,
  onProgress: (loaded: number) => void
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    if (sha) xhr.setRequestHeader("X-Chunk-SHA256", sha);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(xhr.responseText || "{}");
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(parsed);
      else reject(new UploadError((parsed.error as string) || `Server error ${xhr.status}`, xhr.status, parsed));
    };
    xhr.onerror = () => reject(new UploadError("Network error", 0));
    xhr.ontimeout = () => reject(new UploadError("Timed out", 0));
    const abort = () => {
      xhr.abort();
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    xhr.send(body);
  });
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });

function isRetryable(err: unknown): boolean {
  if (!(err instanceof UploadError)) return false;
  return err.status === 0 || err.status === 408 || err.status === 429 || err.status >= 500 && err.status !== 507;
}

export function UploadProvider({ children }: { children: ReactNode }) {
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const [isVisible, setVisible] = useState(false);
  const [unfinished, setUnfinished] = useState<UnfinishedUpload[]>([]);
  /** Server-side sessions by destDir + path + size, so a re-picked file resumes even without local storage. */
  const serverSessions = useRef(new Map<string, string>());
  const activeSessions = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  const entries = useRef(new Map<string, UploadEntry>());
  const controllers = useRef(new Map<string, AbortController>());
  const active = useRef(0);
  const changedDirs = useRef(new Set<string>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const update = useCallback((id: string, patch: Partial<UploadEntry>) => {
    const cur = entries.current.get(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    entries.current.set(id, next);
    setUploads((prev) => prev.map((u) => (u.id === id ? next : u)));
  }, []);

  const announce = useCallback((dir: string) => {
    changedDirs.current.add(dir);
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => {
      const dirs = [...changedDirs.current];
      changedDirs.current.clear();
      emitDirChange(dirs);
    }, 250);
  }, []);

  const runOne = useCallback(
    async (id: string) => {
      const entry = entries.current.get(id);
      if (!entry) return;
      const ctrl = new AbortController();
      controllers.current.set(id, ctrl);
      const { file } = entry;
      const key = resumeKey(entry);
      update(id, { status: "uploading", error: undefined });
      let activeSid: string | null = null;

      try {
        // Resume an earlier session for this exact file, if the server still has it.
        let session: { id: string; chunkSize: number; received: number } | null = null;
        const previous = loadResumeMap()[key] ?? serverSessions.current.get(sessionKey(entry.destDir, entry.relativePath, file.size));
        if (previous) {
          try {
            const s = await jsonRequest(`/api/upload/sessions/${previous}`, { method: "GET" }, ctrl.signal);
            session = { id: String(s.id), chunkSize: Number(s.chunkSize), received: Number(s.received) };
            if (session.received > 0) update(id, { resumed: true });
          } catch {
            saveResume(key, null);
          }
        }
        if (!session) {
          const s = await jsonRequest(
            "/api/upload/sessions",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                destDir: entry.destDir,
                relativePath: entry.relativePath,
                size: file.size,
                lastModified: file.lastModified,
                mimeType: file.type,
              }),
            },
            ctrl.signal
          );
          session = { id: String(s.id), chunkSize: Number(s.chunkSize), received: 0 };
          saveResume(key, session.id);
        }
        const sid = session.id;
        activeSid = sid;
        activeSessions.current.add(sid);
        setUnfinished((prev) => prev.filter((u) => u.id !== sid));
        const conflictQs = entry.conflict ? `&conflict=${entry.conflict}` : "";

        let offset = session.received;
        let retries = 0;
        let lastTick = performance.now();
        let lastBytes = offset;
        let speed = 0;
        let result: Record<string, unknown> | null = null;

        while (!result) {
          const end = Math.min(offset + session.chunkSize, file.size);
          const final = end >= file.size;
          try {
            const buf = await file.slice(offset, end).arrayBuffer();
            const sha = await sha256Hex(buf);
            const chunkStart = offset;
            const resp = await putChunk(
              `/api/upload/sessions/${session.id}?offset=${offset}${final ? `&final=1${conflictQs}` : ""}`,
              buf,
              sha,
              ctrl.signal,
              (loaded) => {
                const sent = chunkStart + loaded;
                const now = performance.now();
                if (now - lastTick > 500) {
                  const inst = ((sent - lastBytes) * 1000) / (now - lastTick);
                  speed = speed ? speed * 0.7 + inst * 0.3 : inst;
                  lastTick = now;
                  lastBytes = sent;
                }
                if (final && loaded >= buf.byteLength) {
                  update(id, { status: "finalizing", bytesSent: file.size, progress: 100, speed });
                } else {
                  update(id, {
                    bytesSent: sent,
                    progress: file.size ? Math.min(99, Math.floor((sent / file.size) * 100)) : 99,
                    speed,
                  });
                }
              }
            );
            retries = 0;
            if (final && resp.success) {
              result = resp;
            } else {
              offset = Number(resp.received);
              if (final && offset >= file.size) {
                result = await jsonRequest(`/api/upload/sessions/${session.id}/complete?${conflictQs.slice(1)}`, { method: "POST" }, ctrl.signal);
              }
            }
          } catch (err) {
            if ((err as Error).name === "AbortError") throw err;
            if (err instanceof UploadError && err.status === 409 && typeof err.body.received === "number") {
              offset = err.body.received as number; // server tells us where to continue
              continue;
            }
            if (err instanceof UploadError && err.status === 422) {
              if (++retries > MAX_RETRIES) throw err;
              continue; // corrupted in transit — send the chunk again
            }
            if (isRetryable(err) && ++retries <= MAX_RETRIES) {
              update(id, { error: `Connection problem — retrying (${retries}/${MAX_RETRIES})…` });
              await sleep(Math.min(30_000, 1000 * 2 ** (retries - 1)), ctrl.signal);
              // Ask the server how much it really has before continuing.
              try {
                const s = await jsonRequest(`/api/upload/sessions/${session.id}`, { method: "GET" }, ctrl.signal);
                offset = Number(s.received);
              } catch {
                /* try the chunk again */
              }
              update(id, { error: undefined });
              continue;
            }
            throw err;
          }
        }

        saveResume(key, null);
        update(id, {
          status: "done",
          progress: 100,
          bytesSent: file.size,
          finalPath: String(result.path),
          renamed: Boolean(result.renamed),
          replaced: Boolean(result.replaced),
          processing: Boolean(result.processing),
          nodeId: result.nodeId ? String(result.nodeId) : undefined,
          error: undefined,
        });
        announce(parentOf(String(result.path)));
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          update(id, { status: "cancelled", error: undefined });
        } else {
          update(id, { status: "error", error: (err as Error).message || "Upload failed" });
        }
      } finally {
        controllers.current.delete(id);
        if (activeSid) activeSessions.current.delete(activeSid);
      }
    },
    [update, announce]
  );

  const pump = useCallback(() => {
    while (active.current < MAX_PARALLEL && queue.current.length > 0) {
      const id = queue.current.shift()!;
      const e = entries.current.get(id);
      if (!e || e.status !== "pending") continue;
      active.current++;
      runOne(id).finally(() => {
        active.current--;
        pump();
      });
    }
  }, [runOne]);

  const refreshUnfinished = useCallback(async () => {
    try {
      const r = await fetch("/api/upload/sessions", { credentials: "same-origin" });
      if (!r.ok) return [];
      const { sessions } = (await r.json()) as { sessions: UnfinishedUpload[] };
      serverSessions.current = new Map(sessions.map((u) => [sessionKey(u.destDir, u.relativePath, u.size), u.id]));
      const idle = sessions.filter((u) => !activeSessions.current.has(u.id));
      setUnfinished(idle);
      return idle;
    } catch {
      return []; // offline: nothing to show
    }
  }, []);

  // After a crash or a closed tab, show what's unfinished so it can be resumed or discarded.
  useEffect(() => {
    refreshUnfinished().then((list) => {
      if (list.length) setVisible(true);
    });
  }, [refreshUnfinished]);

  const discardUnfinished = useCallback(async () => {
    const list = unfinished;
    setUnfinished([]);
    await Promise.all(list.map((u) => fetch(`/api/upload/sessions/${u.id}`, { method: "DELETE", credentials: "same-origin" }).catch(() => {})));
    const map = loadResumeMap();
    const gone = new Set(list.map((u) => u.id));
    for (const [k, v] of Object.entries(map)) if (gone.has(v)) saveResume(k, null);
    serverSessions.current = new Map([...serverSessions.current].filter(([, id]) => !gone.has(id)));
  }, [unfinished]);

  const enqueueFiles = useCallback(
    (files: { file: File; relativePath: string }[], destDir: string) => {
      if (files.length === 0) return;
      void (async () => {
        // Ask first about files that already exist there (Replace / Skip /
        // Keep both, "do this for all"). If the check itself fails, upload
        // anyway: the server never overwrites, it adds a number instead.
        const list = files.map((f) => ({ ...f, relativePath: f.relativePath || f.file.name }));
        let decisions: Record<string, "skip" | "replace" | "keep_both"> = {};
        let fallback: "replace" | "keep_both" = "keep_both";
        try {
          await refreshUnfinished();
          const conflicts: ConflictInfo[] = [];
          for (let i = 0; i < list.length; i += 5000) {
            const r = await fetch("/api/fs/conflicts", {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                op: "upload",
                destDir,
                files: list.slice(i, i + 5000).map((f) => ({ path: f.relativePath, size: f.file.size, lastModified: f.file.lastModified })),
              }),
            });
            if (!r.ok) throw new Error(String(r.status));
            conflicts.push(...((await r.json()) as { conflicts: ConflictInfo[] }).conflicts);
          }
          if (conflicts.length) {
            const res = await resolveConflicts(conflicts, destDir ? destDir.split("/").pop()! : "Home");
            if (!res) return; // cancelled: upload nothing
            decisions = res.decisions;
            if (res.defaultAction === "replace") fallback = "replace";
          }
        } catch {
          /* see above */
        }
        const chosen = list.filter((f) => decisions[f.relativePath] !== "skip");
        const skipped = list.length - chosen.length;
        if (skipped) toast.info(`Skipped ${skipped} file${skipped === 1 ? "" : "s"} that already exist${skipped === 1 ? "s" : ""}.`);
        if (chosen.length === 0) return;
        const added: UploadEntry[] = chosen.map((f) => {
          const d = decisions[f.relativePath];
          return {
            id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2),
            file: f.file,
            relativePath: f.relativePath,
            destDir,
            status: "pending",
            progress: 0,
            bytesSent: 0,
            speed: 0,
            conflict: d === "replace" || d === "keep_both" ? d : fallback,
          };
        });
        for (const e of added) entries.current.set(e.id, e);
        setUploads((prev) => [...prev, ...added]);
        queue.current.push(...added.map((e) => e.id));
        setVisible(true);
        pump();
      })();
    },
    [pump, refreshUnfinished]
  );

  const cancelUpload = useCallback((id: string) => {
    const e = entries.current.get(id);
    if (!e) return;
    controllers.current.get(id)?.abort();
    queue.current = queue.current.filter((q) => q !== id);
    if (e.status === "pending") update(id, { status: "cancelled" });
    // Tell the server to discard the partial data.
    const sid = loadResumeMap()[resumeKey(e)];
    if (sid) {
      saveResume(resumeKey(e), null);
      fetch(`/api/upload/sessions/${sid}`, { method: "DELETE" }).catch(() => {});
    }
  }, [update]);

  const retryUpload = useCallback(
    (id: string) => {
      const e = entries.current.get(id);
      if (!e || (e.status !== "error" && e.status !== "cancelled")) return;
      update(id, { status: "pending", error: undefined, progress: 0, bytesSent: 0, speed: 0 });
      queue.current.push(id);
      pump();
    },
    [update, pump]
  );

  const dismissUpload = useCallback((id: string) => {
    entries.current.delete(id);
    setUploads((prev) => prev.filter((u) => u.id !== id));
  }, []);

  const clearCompleted = useCallback(() => {
    setUploads((prev) => {
      const keep = prev.filter((u) => u.status === "uploading" || u.status === "pending" || u.status === "finalizing");
      for (const u of prev) if (!keep.includes(u)) entries.current.delete(u.id);
      return keep;
    });
  }, []);

  // Clear the "preview generating" hint once the scanner reports the file done.
  useChangeReason("processed", (nodeIds) => {
    const ids = new Set(nodeIds);
    for (const e of entries.current.values()) {
      if (e.processing && e.nodeId && ids.has(e.nodeId)) update(e.id, { processing: false });
    }
  });

  // Warn before closing the tab while bytes are still being sent.
  const busy = uploads.some((u) => u.status === "uploading" || u.status === "pending" || u.status === "finalizing");
  useEffect(() => {
    if (!busy) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [busy]);

  const actions = useMemo<UploadActions>(
    () => ({ enqueueFiles, cancelUpload, retryUpload, dismissUpload, clearCompleted, setVisible, discardUnfinished }),
    [enqueueFiles, cancelUpload, retryUpload, dismissUpload, clearCompleted, discardUnfinished]
  );
  const state = useMemo<UploadState>(() => ({ uploads, isVisible, unfinished }), [uploads, isVisible, unfinished]);

  return (
    <ActionsContext.Provider value={actions}>
      <StateContext.Provider value={state}>{children}</StateContext.Provider>
    </ActionsContext.Provider>
  );
}

/** Actions only — never re-renders on progress. */
export function useUploadActions(): UploadActions {
  const ctx = useContext(ActionsContext);
  if (!ctx) throw new Error("useUploadActions must be used within UploadProvider");
  return ctx;
}

/** State + actions (re-renders on every progress update). */
export function useUpload(): UploadActions & UploadState {
  const actions = useUploadActions();
  const state = useContext(StateContext);
  if (!state) throw new Error("useUpload must be used within UploadProvider");
  return { ...actions, ...state };
}
