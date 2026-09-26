"use client";

/**
 * UploadWidget — floating upload panel (bottom-right).
 *
 * Shows overall progress with speed/ETA, and per-file state:
 * waiting → uploading (with %) → finalizing → done. "Done" means the file is
 * safely stored; a small "preview processing" hint shows while thumbnails
 * are generated in the background. Failed uploads can be retried. Hiding
 * the panel leaves a small pill that brings it back.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useUpload, type UploadEntry } from "./UploadContext";
import { formatBytes } from "@/lib/utils";
import { filesHref, parentOf } from "@/lib/client/api";
import { Upload, X, CheckCircle2, AlertCircle, Loader2, ChevronDown, ChevronUp, Minimize2, RotateCcw, Sparkles } from "lucide-react";

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return `${Math.ceil(seconds)}s left`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min left`;
  return `${(seconds / 3600).toFixed(1)} h left`;
}

function statusIcon(entry: UploadEntry) {
  switch (entry.status) {
    case "done":
      return <CheckCircle2 size={14} className="text-emerald-500 shrink-0" />;
    case "error":
      return <AlertCircle size={14} className="text-red-500 shrink-0" />;
    case "uploading":
    case "finalizing":
      return <Loader2 size={14} className="text-[hsl(var(--primary))] animate-spin shrink-0" />;
    case "cancelled":
      return <X size={14} className="text-[hsl(var(--muted-foreground))] shrink-0" />;
    default:
      return <div className="w-3.5 h-3.5 rounded-full border-2 border-[hsl(var(--muted-foreground)/0.4)] shrink-0" />;
  }
}

/**
 * Uploads the server still has partial data for — after a power cut, a
 * crash or a closed tab. Picking the same files again (same folder) resumes
 * them; Discard frees the space now instead of after 24 hours.
 */
function UnfinishedBanner() {
  const { unfinished, discardUnfinished, setVisible, uploads } = useUpload();
  const [busy, setBusy] = useState(false);
  if (unfinished.length === 0) return null;
  const bytes = unfinished.reduce((s, u) => s + u.received, 0);
  const n = unfinished.length;
  return (
    <div className="px-4 py-3 border-b border-[hsl(var(--border))] bg-amber-500/5 text-xs">
      <p className="font-medium text-[hsl(var(--foreground))]">
        {n} unfinished upload{n === 1 ? "" : "s"} ({formatBytes(bytes)} received)
      </p>
      <p className="mt-0.5 text-[hsl(var(--muted-foreground))] truncate">
        {unfinished
          .slice(0, 2)
          .map((u) => (u.destDir ? `${u.destDir}/${u.relativePath}` : u.relativePath))
          .join(", ")}
        {n > 2 ? ` and ${n - 2} more` : ""}
      </p>
      <p className="mt-0.5 text-[hsl(var(--muted-foreground))]">
        Pick the same files again in the same folder to continue where they stopped. Unfinished files never appear in your folders.
      </p>
      <div className="mt-2 flex gap-2">
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await discardUnfinished();
            setBusy(false);
            if (uploads.length === 0) setVisible(false);
          }}
          className="px-2.5 py-1 rounded-md border hover:bg-[hsl(var(--accent))] disabled:opacity-50"
        >
          Discard {n === 1 ? "it" : "all"}
        </button>
      </div>
    </div>
  );
}

export function UploadWidget() {
  const { uploads, isVisible, setVisible, cancelUpload, retryUpload, dismissUpload, clearCompleted, unfinished } = useUpload();
  const [collapsed, setCollapsed] = useState(false);

  if (uploads.length === 0 && unfinished.length === 0) return null;
  if (uploads.length === 0) {
    if (!isVisible) return null;
    return (
      <div
        className="fixed bottom-24 md:bottom-6 right-2 left-2 sm:left-auto sm:right-6 z-50 sm:w-96 rounded-xl shadow-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] overflow-hidden"
        role="region"
        aria-label="Unfinished uploads"
      >
        <div className="flex items-center justify-between px-4 py-2 border-b border-[hsl(var(--border))]">
          <span className="text-sm font-semibold flex items-center gap-2">
            <Upload size={15} className="text-[hsl(var(--primary))]" /> Uploads
          </span>
          <button onClick={() => setVisible(false)} className="p-1.5 rounded-md hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]" aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <UnfinishedBanner />
      </div>
    );
  }

  const active = uploads.filter((u) => u.status === "uploading" || u.status === "pending" || u.status === "finalizing");
  const failed = uploads.filter((u) => u.status === "error");
  const completed = uploads.filter((u) => u.status === "done");
  const totalBytes = active.reduce((s, u) => s + u.file.size, 0);
  const sentBytes = active.reduce((s, u) => s + u.bytesSent, 0);
  const speed = active.reduce((s, u) => s + (u.status === "uploading" ? u.speed : 0), 0);
  const overall = totalBytes ? Math.floor((sentBytes / totalBytes) * 100) : 100;
  const allDone = active.length === 0;

  if (!isVisible) {
    return (
      <button
        onClick={() => setVisible(true)}
        className="fixed bottom-24 md:bottom-6 right-4 md:right-6 z-50 flex items-center gap-2 rounded-full px-4 py-2 shadow-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] text-sm font-medium text-[hsl(var(--foreground))]"
        aria-label="Show uploads"
      >
        {allDone ? <CheckCircle2 size={15} className="text-emerald-500" /> : <Loader2 size={15} className="animate-spin text-[hsl(var(--primary))]" />}
        {allDone ? `${completed.length} uploaded` : `${overall}% · ${active.length} left`}
      </button>
    );
  }

  return (
    <div
      className="fixed bottom-24 md:bottom-6 right-2 left-2 sm:left-auto sm:right-6 z-50 sm:w-96 rounded-xl shadow-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] overflow-hidden"
      role="region"
      aria-label="Uploads"
    >
      <div className="px-4 py-3 border-b border-[hsl(var(--border))]">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Upload size={15} className="text-[hsl(var(--primary))] shrink-0" />
            <span className="text-sm font-semibold text-[hsl(var(--foreground))] truncate">
              {allDone
                ? failed.length
                  ? `${completed.length} uploaded, ${failed.length} failed`
                  : `${completed.length} upload${completed.length !== 1 ? "s" : ""} complete`
                : `Uploading ${active.length} file${active.length !== 1 ? "s" : ""}`}
            </span>
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            {allDone && (
              <button onClick={clearCompleted} className="text-xs px-2 py-1 rounded text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]">
                Clear
              </button>
            )}
            <button
              onClick={() => setCollapsed(!collapsed)}
              className="p-1.5 rounded-md hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]"
              aria-label={collapsed ? "Expand" : "Collapse"}
            >
              {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
            <button
              onClick={() => setVisible(false)}
              className="p-1.5 rounded-md hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]"
              aria-label="Minimize"
            >
              <Minimize2 size={14} />
            </button>
          </div>
        </div>
        {!allDone && (
          <div className="mt-2">
            <div className="relative h-1.5 rounded-full bg-[hsl(var(--muted)/0.6)] overflow-hidden">
              <div className="absolute inset-y-0 left-0 bg-[hsl(var(--primary))] rounded-full transition-all duration-300" style={{ width: `${overall}%` }} />
            </div>
            <p className="mt-1 text-[11px] text-[hsl(var(--muted-foreground))] flex justify-between">
              <span>
                {formatBytes(sentBytes)} of {formatBytes(totalBytes)}
                {speed > 0 && ` · ${formatBytes(speed)}/s`}
              </span>
              <span>{speed > 0 ? formatEta((totalBytes - sentBytes) / speed) : ""}</span>
            </p>
          </div>
        )}
      </div>

      {!collapsed && <UnfinishedBanner />}
      {!collapsed && (
        <div className="max-h-72 overflow-y-auto py-1">
          {uploads.map((entry) => (
            <UploadRow
              key={entry.id}
              entry={entry}
              onCancel={() => cancelUpload(entry.id)}
              onRetry={() => retryUpload(entry.id)}
              onDismiss={() => dismissUpload(entry.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function UploadRow({
  entry,
  onCancel,
  onRetry,
  onDismiss,
}: {
  entry: UploadEntry;
  onCancel: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const router = useRouter();
  const isActive = entry.status === "uploading" || entry.status === "pending" || entry.status === "finalizing";
  const name = entry.finalPath ? entry.finalPath.split("/").pop()! : entry.relativePath.split("/").pop()!;

  return (
    <div className="px-4 py-2.5 hover:bg-[hsl(var(--accent)/0.5)] transition-colors">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5">{statusIcon(entry)}</div>
        <div className="flex-1 min-w-0">
          {entry.status === "done" && entry.finalPath ? (
            <button
              className="block w-full text-left text-xs font-medium truncate text-[hsl(var(--foreground))] hover:underline"
              title={entry.finalPath}
              onClick={() => router.push(filesHref(parentOf(entry.finalPath!)))}
            >
              {name}
              {entry.renamed && <span className="ml-1.5 text-[hsl(var(--muted-foreground))] font-normal">(kept both — saved with a number added)</span>}
              {entry.replaced && <span className="ml-1.5 text-[hsl(var(--muted-foreground))] font-normal">(replaced — the old one is in Trash)</span>}
            </button>
          ) : (
            <p className="text-xs font-medium truncate text-[hsl(var(--foreground))]" title={entry.relativePath}>
              {name}
            </p>
          )}

          {entry.status === "uploading" && (
            <>
              <div className="mt-1.5 relative h-1 rounded-full bg-[hsl(var(--muted)/0.5)] overflow-hidden">
                <div className="absolute inset-y-0 left-0 bg-[hsl(var(--primary))] rounded-full transition-all duration-300" style={{ width: `${entry.progress}%` }} />
              </div>
              <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5">
                {entry.error ?? `${entry.progress}% of ${formatBytes(entry.file.size)}${entry.resumed ? " · resumed" : ""}`}
              </p>
            </>
          )}
          {entry.status === "finalizing" && <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5">Saving…</p>}
          {entry.status === "pending" && <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5">Waiting…</p>}
          {entry.status === "done" && (
            <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5 flex items-center gap-1">
              Uploaded · {formatBytes(entry.file.size)}
              {entry.processing && (
                <span className="inline-flex items-center gap-1">
                  · <Sparkles size={10} /> preview generating in background
                </span>
              )}
            </p>
          )}
          {entry.status === "error" && entry.error && <p className="text-[11px] text-red-500 mt-0.5 break-words">{entry.error}</p>}
          {entry.status === "cancelled" && <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5">Cancelled</p>}
        </div>
        <div className="shrink-0 flex items-center">
          {(entry.status === "error" || entry.status === "cancelled") && (
            <button onClick={onRetry} className="p-1.5 rounded hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]" aria-label="Retry">
              <RotateCcw size={13} />
            </button>
          )}
          {isActive && entry.status !== "finalizing" ? (
            <button onClick={onCancel} className="p-1.5 rounded hover:bg-red-500/10 text-[hsl(var(--muted-foreground))] hover:text-red-500" aria-label="Cancel upload">
              <X size={13} />
            </button>
          ) : !isActive ? (
            <button onClick={onDismiss} className="p-1.5 rounded hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]" aria-label="Dismiss">
              <X size={13} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
