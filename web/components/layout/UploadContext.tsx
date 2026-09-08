"use client";

/**
 * UploadContext
 *
 * Manages client-side upload state across the entire app.
 * Provides:
 *   - A queue of active and completed uploads with per-file progress
 *   - Methods to enqueue files for upload to a destination directory
 *   - Support for cancellation via AbortController
 *   - Auto-refresh of the file list after all uploads in a batch complete
 */

import {
  createContext,
  useContext,
  useCallback,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type UploadStatus = "pending" | "uploading" | "done" | "error" | "cancelled";

export interface UploadEntry {
  id: string;
  file: File;
  /** The relative upload path (for folder uploads: subdir/filename, else: filename) */
  relativePath: string;
  /** Destination directory relative path */
  destDir: string;
  status: UploadStatus;
  progress: number; // 0–100
  error?: string;
  finalPath?: string;
  renamed?: boolean;
  abortController?: AbortController;
}

interface UploadContextType {
  uploads: UploadEntry[];
  isVisible: boolean;
  setVisible: (v: boolean) => void;
  /**
   * Enqueue files for upload to a destination directory.
   * For folder uploads, pass entries with relativePath set.
   */
  enqueueFiles: (
    files: { file: File; relativePath: string }[],
    destDir: string
  ) => void;
  /** Cancel an in-progress upload */
  cancelUpload: (id: string) => void;
  /** Remove a completed/errored entry from the list */
  dismissUpload: (id: string) => void;
  /** Clear all completed/errored entries */
  clearCompleted: () => void;
}

const UploadContext = createContext<UploadContextType | null>(null);

export function UploadProvider({ children }: { children: ReactNode }) {
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const [isVisible, setVisible] = useState(false);
  // Prevent concurrent parallel uploads from exceeding the limit
  const activeCount = useRef(0);
  const MAX_PARALLEL = 3;
  const queue = useRef<UploadEntry[]>([]);

  const updateEntry = useCallback(
    (id: string, patch: Partial<UploadEntry>) => {
      setUploads((prev) =>
        prev.map((u) => (u.id === id ? { ...u, ...patch } : u))
      );
    },
    []
  );

  const processQueue = useCallback(async () => {
    while (activeCount.current < MAX_PARALLEL && queue.current.length > 0) {
      const entry = queue.current.shift()!;
      activeCount.current++;

      updateEntry(entry.id, { status: "uploading" });

      const abortController = new AbortController();
      updateEntry(entry.id, { abortController });

      try {
        const formData = new FormData();
        formData.append("file", entry.file);
        formData.append("destDir", entry.destDir);
        if (entry.relativePath !== entry.file.name) {
          formData.append("relativePath", entry.relativePath);
        }

        // Note: fetch doesn't support upload progress natively.
        // For large files we use XMLHttpRequest to get progress events.
        const result = await uploadWithProgress(
          formData,
          abortController.signal,
          (progress) => updateEntry(entry.id, { progress })
        );

        updateEntry(entry.id, {
          status: "done",
          progress: 100,
          finalPath: result.path,
          renamed: result.renamed,
          abortController: undefined,
        });
      } catch (err: unknown) {
        const error = err as Error;
        if (error.name === "AbortError") {
          updateEntry(entry.id, { status: "cancelled", abortController: undefined });
        } else {
          updateEntry(entry.id, {
            status: "error",
            error: error.message || "Upload failed",
            abortController: undefined,
          });
        }
      } finally {
        activeCount.current--;
        // Trigger file list refresh
        window.dispatchEvent(new Event("loom-refresh"));
        // Continue processing queue
        processQueue();
      }
    }
  }, [updateEntry]);

  const enqueueFiles = useCallback(
    (files: { file: File; relativePath: string }[], destDir: string) => {
      const entries: UploadEntry[] = files.map((f) => ({
        id: Math.random().toString(36).slice(2),
        file: f.file,
        relativePath: f.relativePath,
        destDir,
        status: "pending",
        progress: 0,
      }));

      setUploads((prev) => [...prev, ...entries]);
      queue.current.push(...entries);
      setVisible(true);

      // Start processing
      processQueue();
    },
    [processQueue]
  );

  const cancelUpload = useCallback(
    (id: string) => {
      setUploads((prev) => {
        const entry = prev.find((u) => u.id === id);
        if (entry?.abortController) {
          entry.abortController.abort();
        }
        // Remove from queue if still pending
        queue.current = queue.current.filter((u) => u.id !== id);
        return prev.map((u) =>
          u.id === id && u.status === "pending"
            ? { ...u, status: "cancelled" }
            : u
        );
      });
    },
    []
  );

  const dismissUpload = useCallback((id: string) => {
    setUploads((prev) => prev.filter((u) => u.id !== id));
  }, []);

  const clearCompleted = useCallback(() => {
    setUploads((prev) =>
      prev.filter((u) => u.status === "uploading" || u.status === "pending")
    );
  }, []);

  return (
    <UploadContext.Provider
      value={{
        uploads,
        isVisible,
        setVisible,
        enqueueFiles,
        cancelUpload,
        dismissUpload,
        clearCompleted,
      }}
    >
      {children}
    </UploadContext.Provider>
  );
}

export function useUpload() {
  const ctx = useContext(UploadContext);
  if (!ctx) throw new Error("useUpload must be used within UploadProvider");
  return ctx;
}

/** Upload with XMLHttpRequest for progress tracking */
function uploadWithProgress(
  formData: FormData,
  signal: AbortSignal,
  onProgress: (pct: number) => void
): Promise<{ path: string; name: string; renamed: boolean }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error("Invalid server response"));
        }
      } else {
        try {
          const body = JSON.parse(xhr.responseText);
          reject(new Error(body.error || `Server error ${xhr.status}`));
        } catch {
          reject(new Error(`Server error ${xhr.status}`));
        }
      }
    });

    xhr.addEventListener("error", () => reject(new Error("Network error")));

    signal.addEventListener("abort", () => {
      xhr.abort();
      reject(new DOMException("Aborted", "AbortError"));
    });

    xhr.open("POST", "/api/upload");
    xhr.send(formData);
  });
}
