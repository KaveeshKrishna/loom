"use client";

/**
 * The DEMO badge + explanatory popup — only ever rendered in the demo
 * build (see MainShell/LoginForm swaps in loom-demo/build.sh). Modeled
 * directly on the equivalent component in the Sentinel project's own
 * public demo, adapted to Loom's visual language.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, Info, X } from "lucide-react";
import { resetDemo } from "@/lib/demo/state";

export function DemoModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="alertdialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="bg-[hsl(var(--background))] border border-[hsl(var(--border))] rounded-2xl shadow-xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-200"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b bg-[hsl(var(--muted))]">
          <div className="flex items-center gap-2 text-[hsl(var(--foreground))]">
            <AlertTriangle size={17} className="text-amber-500" />
            <h2 className="text-sm font-semibold">Important — please read</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded-md text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-3">
          <p className="text-sm font-semibold">You&apos;re viewing the DEMO version of Loom</p>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            <strong className="text-[hsl(var(--foreground))]">Every file, photo, video, user, and log entry here is completely fabricated.</strong>{" "}
            Loom normally manages someone&apos;s real private files, so this build has{" "}
            <strong className="text-[hsl(var(--foreground))]">no backend at all</strong> — everything is generated and stored entirely in your browser.
          </p>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            Try any feature — upload, rename, move to trash, star a favorite, manage users and
            permissions. Changes you make are saved only in this browser, and never affect
            anyone else viewing this demo.
          </p>

          <div className="flex gap-2 justify-end pt-2">
            <button
              onClick={() => { onClose(); resetDemo(); window.location.reload(); }}
              className="px-3 py-1.5 text-sm font-medium rounded-lg hover:bg-[hsl(var(--accent))] transition-colors"
            >
              Reset demo
            </button>
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm font-medium bg-[hsl(var(--primary))] text-white rounded-lg hover:opacity-90 transition-opacity"
            >
              I understand
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function DemoBadge({ autoOpen }: { autoOpen?: boolean }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="About this demo"
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold tracking-wide bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 hover:bg-amber-500/25 transition-colors"
      >
        <Info size={11} /> DEMO
      </button>
      <DemoModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
