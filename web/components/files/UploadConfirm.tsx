"use client";

/**
 * "Upload to Photos?" — asked before anything dropped on the page is
 * uploaded, so a stray drop never starts an upload by itself.
 *
 * Promise-based: `if (await confirmUpload({...})) …`.
 * <UploadConfirmHost/> is mounted once in MainShell.
 */

import { useEffect, useState } from "react";
import { UploadCloud, Folder, File as FileIcon } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { formatBytes } from "@/lib/utils";

export interface UploadSummary {
  destLabel: string;
  /** What was dropped (top level) */
  names: { name: string; folder: boolean }[];
  /** Files in total (or top-level files, when folder contents aren't counted) */
  files: number;
  folders: number;
  bytes: number;
  /** False when folders weren't looked into (the app counts them) */
  folderSizesKnown: boolean;
  /** `files` includes the files inside the dropped folders */
  filesInFolders?: boolean;
}

interface Request extends UploadSummary {
  resolve: (ok: boolean) => void;
}

const subs = new Set<(r: Request | null) => void>();

export function confirmUpload(summary: UploadSummary): Promise<boolean> {
  return new Promise((resolve) => {
    if (subs.size === 0) return resolve(true); // no host mounted (shouldn't happen)
    const req = { ...summary, resolve };
    subs.forEach((s) => s(req));
  });
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

function describe(r: UploadSummary): string {
  if (r.filesInFolders) {
    return `${plural(r.files, "file")} in ${plural(r.folders, "folder")} · ${formatBytes(r.bytes)}`;
  }
  const parts = [];
  if (r.folders) parts.push(plural(r.folders, "folder"));
  if (r.files) parts.push(plural(r.files, "file"));
  const what = parts.join(" and ");
  if (!r.folderSizesKnown) return r.files ? `${what} · ${formatBytes(r.bytes)} plus the folders' contents` : what;
  return `${what} · ${formatBytes(r.bytes)}`;
}

export function UploadConfirmHost() {
  const [req, setReq] = useState<Request | null>(null);
  useEffect(() => {
    subs.add(setReq);
    return () => {
      subs.delete(setReq);
    };
  }, []);
  if (!req) return null;
  const done = (ok: boolean) => {
    setReq(null);
    req.resolve(ok);
  };
  const shown = req.names.slice(0, 5);
  const more = req.names.length - shown.length;
  return (
    <Dialog
      open
      onClose={() => done(false)}
      title={
        <span className="flex items-center gap-2 min-w-0">
          <UploadCloud size={17} className="text-[hsl(var(--primary))] shrink-0" />
          <span className="truncate">Upload to {req.destLabel}?</span>
        </span>
      }
    >
      <p className="text-sm text-[hsl(var(--muted-foreground))]">{describe(req)}</p>
      <ul className="mt-3 rounded-lg border divide-y text-sm" aria-label="Items to upload">
        {shown.map((n, i) => (
          <li key={`${n.name}-${i}`} className="flex items-center gap-2.5 px-3 py-2 min-w-0">
            {n.folder ? <Folder size={15} className="text-[hsl(var(--primary))] shrink-0" /> : <FileIcon size={15} className="text-[hsl(var(--muted-foreground))] shrink-0" />}
            <span className="truncate">{n.name}</span>
          </li>
        ))}
        {more > 0 && <li className="px-3 py-2 text-xs text-[hsl(var(--muted-foreground))]">and {more.toLocaleString()} more</li>}
      </ul>
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={() => done(false)} className="text-sm px-3 py-1.5 rounded-md border hover:bg-[hsl(var(--accent))]">
          Cancel
        </button>
        <button
          autoFocus
          onClick={() => done(true)}
          className="text-sm px-3 py-1.5 rounded-md bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] font-medium hover:opacity-90"
        >
          Upload
        </button>
      </div>
    </Dialog>
  );
}
