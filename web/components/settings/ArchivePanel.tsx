"use client";

import { useState } from "react";
import { HardDrive, Loader2, RefreshCcw } from "lucide-react";

export function ArchivePanel() {
  const [operating, setOperating] = useState(false);
  const [message, setMessage] = useState("");

  const rescan = async () => {
    setOperating(true); 
    setMessage("");
    try {
      const res = await fetch("/api/archive", {
        method: "POST", 
        headers: { "Content-Type": "application/json" }, 
        body: JSON.stringify({ action: "rescan" }),
      });
      const data = await res.json();
      setMessage(data.success ? `Rescan initiated. Check scanner logs for progress.` : (data.error ?? "Operation failed."));
    } catch {
      setMessage("Operation failed.");
    }
    setOperating(false);
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-base font-semibold">Archive</h2>
        <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">Manage the Samsung T7 external drive.</p>
      </div>

      <div className="bg-[hsl(var(--card))] border rounded-xl p-5">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-[hsl(var(--accent))] flex items-center justify-center shrink-0">
            <HardDrive size={22} className="text-[hsl(var(--muted-foreground))]" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">Samsung T7 Portable SSD</p>
            <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">Mounted at /media &middot; exFAT</p>
            <div className="flex items-center gap-1.5 mt-2">
              <span className={`text-sm font-medium text-emerald-500`}>Online (USB Managed)</span>
            </div>
          </div>
        </div>

        <div className="mt-5 flex items-center gap-3">
          <button
            id="archive-rescan"
            onClick={rescan}
            disabled={operating}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-[hsl(var(--primary))] text-white rounded-lg hover:opacity-90 disabled:opacity-50 transition-colors"
          >
            {operating ? <Loader2 size={14} className="animate-spin" /> : <RefreshCcw size={14} />}
            Rescan Library
          </button>
        </div>

        {message && (
          <p className="mt-3 text-xs text-[hsl(var(--muted-foreground))] bg-[hsl(var(--accent))] px-3 py-2 rounded-lg">{message}</p>
        )}
      </div>

      <div className="bg-blue-500/8 border border-blue-500/20 rounded-xl p-4">
        <p className="text-sm font-medium text-blue-700 dark:text-blue-400">How indexing works</p>
        <p className="text-xs text-blue-600 dark:text-blue-500 mt-1.5 leading-relaxed">
          The scanner runs as a passive job worker — it does not watch the filesystem.
          Files added through Loom&apos;s upload feature are indexed automatically after the upload completes.
          Files added externally (e.g. by connecting the T7 to another computer) will appear
          after you click <strong>Rescan Library</strong>.
          When no scan is running, the T7 is completely idle and the OS can suspend the USB device.
        </p>
      </div>
    </div>
  );
}
