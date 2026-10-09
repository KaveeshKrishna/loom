"use client";

/**
 * A slim bar at the top when Loom can't be reached ("Reconnecting…"), and
 * when it came back running a newer version: the page reloads itself then,
 * unless uploads from this page are still running (it asks instead).
 */

import { useEffect } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useLiveStatus } from "@/lib/client/live";
import { useUpload } from "./UploadContext";

export function ConnectionBanner() {
  const { lost, updated } = useLiveStatus();
  const { uploads } = useUpload();
  const busy = uploads.some((u) => u.status === "uploading" || u.status === "pending" || u.status === "finalizing");

  useEffect(() => {
    if (updated && !busy) window.location.reload();
  }, [updated, busy]);

  if (updated && busy) {
    return (
      <div role="status" className="flex items-center justify-center gap-3 px-4 py-1.5 text-xs bg-[hsl(var(--primary)/0.1)] text-[hsl(var(--foreground))] border-b">
        <span>Loom was updated. This page reloads when your uploads finish.</span>
        <button onClick={() => window.location.reload()} className="inline-flex items-center gap-1 font-medium text-[hsl(var(--primary))] hover:underline">
          <RefreshCw size={12} /> Reload now
        </button>
      </div>
    );
  }
  if (!lost) return null;
  return (
    <div role="status" className="flex items-center justify-center gap-2 px-4 py-1.5 text-xs bg-amber-500/10 text-amber-700 dark:text-amber-300 border-b border-amber-500/20">
      <Loader2 size={12} className="animate-spin" />
      <span>Can&apos;t reach Loom. Reconnecting…</span>
    </div>
  );
}
