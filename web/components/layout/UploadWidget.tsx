"use client";

/**
 * UploadWidget
 *
 * Floating upload progress panel anchored to the bottom-right corner.
 * Shows per-file progress bars, status icons, and cancel buttons.
 * Collapses to a compact badge when minimized.
 */

import { useUpload, type UploadEntry } from "./UploadContext";
import { useState } from "react";
import {
  Upload,
  X,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
  Minimize2,
} from "lucide-react";

function statusIcon(entry: UploadEntry) {
  switch (entry.status) {
    case "done":
      return <CheckCircle2 size={14} className="text-emerald-500 shrink-0" />;
    case "error":
      return <AlertCircle size={14} className="text-red-500 shrink-0" />;
    case "uploading":
      return (
        <Loader2 size={14} className="text-[hsl(var(--primary))] animate-spin shrink-0" />
      );
    case "cancelled":
      return <X size={14} className="text-[hsl(var(--muted-foreground))] shrink-0" />;
    default:
      return (
        <div className="w-3.5 h-3.5 rounded-full border-2 border-[hsl(var(--muted-foreground)/0.4)] shrink-0" />
      );
  }
}

export function UploadWidget() {
  const {
    uploads,
    isVisible,
    setVisible,
    cancelUpload,
    dismissUpload,
    clearCompleted,
  } = useUpload();

  const [collapsed, setCollapsed] = useState(false);

  const active = uploads.filter(
    (u: UploadEntry) => u.status === "uploading" || u.status === "pending"
  );
  const done = uploads.filter(
    (u: UploadEntry) => u.status === "done" || u.status === "error" || u.status === "cancelled"
  );
  const allDone = active.length === 0;

  if (!isVisible || uploads.length === 0) return null;

  return (
    <div
      className="fixed bottom-6 right-6 z-50 w-80 rounded-xl shadow-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] overflow-hidden"
      style={{ backdropFilter: "blur(12px)" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[hsl(var(--border))]">
        <div className="flex items-center gap-2">
          <Upload size={15} className="text-[hsl(var(--primary))]" />
          <span className="text-sm font-semibold text-[hsl(var(--foreground))]">
            {allDone
              ? `${done.length} upload${done.length !== 1 ? "s" : ""} complete`
              : `Uploading ${active.length} file${active.length !== 1 ? "s" : ""}…`}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {allDone && done.length > 0 && (
            <button
              onClick={clearCompleted}
              className="text-xs px-2 py-1 rounded text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
            >
              Clear
            </button>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="p-1.5 rounded-md hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))] transition-colors"
            title={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          <button
            onClick={() => setVisible(false)}
            className="p-1.5 rounded-md hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))] transition-colors"
            title="Hide"
          >
            <Minimize2 size={14} />
          </button>
        </div>
      </div>

      {/* File list */}
      {!collapsed && (
        <div className="max-h-72 overflow-y-auto py-1">
          {uploads.map((entry) => (
            <UploadRow
              key={entry.id}
              entry={entry}
              onCancel={() => cancelUpload(entry.id)}
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
  onDismiss,
}: {
  entry: UploadEntry;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const isDone = entry.status === "done" || entry.status === "error" || entry.status === "cancelled";
  const isActive = entry.status === "uploading" || entry.status === "pending";

  return (
    <div className="px-4 py-2.5 hover:bg-[hsl(var(--accent)/0.5)] transition-colors group">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5">{statusIcon(entry)}</div>
        <div className="flex-1 min-w-0">
          <p
            className="text-xs font-medium truncate text-[hsl(var(--foreground))]"
            title={entry.relativePath}
          >
            {entry.file.name}
            {entry.renamed && (
              <span className="ml-1.5 text-[hsl(var(--muted-foreground))] font-normal">
                (renamed)
              </span>
            )}
          </p>
          {entry.status === "error" && entry.error && (
            <p className="text-xs text-red-500 mt-0.5 truncate">{entry.error}</p>
          )}
          {entry.status === "uploading" && (
            <div className="mt-1.5 relative h-1 rounded-full bg-[hsl(var(--muted)/0.5)] overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 bg-[hsl(var(--primary))] rounded-full transition-all duration-300"
                style={{ width: `${entry.progress}%` }}
              />
            </div>
          )}
          {entry.status === "pending" && (
            <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">Waiting…</p>
          )}
        </div>
        <div className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {isActive && (
            <button
              onClick={onCancel}
              className="p-1 rounded hover:bg-red-500/10 text-[hsl(var(--muted-foreground))] hover:text-red-500 transition-colors"
              title="Cancel"
            >
              <X size={12} />
            </button>
          )}
          {isDone && (
            <button
              onClick={onDismiss}
              className="p-1 rounded hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))] transition-colors"
              title="Dismiss"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Declare global augmentation for collapsed state (avoids re-render loops)
declare global {
  interface Window {
    _loomUploadCollapsed?: boolean;
  }
}
