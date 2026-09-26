"use client";

/** A list of share links with copy / delete actions (used by /shared and Settings → Sharing). */

import Link from "next/link";
import { Copy, Trash2, Lock, Link2 } from "lucide-react";
import { formatDate, cn } from "@/lib/utils";
import { filesHref, parentOf } from "@/lib/client/api";
import { copyText, type ShareLinkRow } from "@/components/files/ShareDialog";

export function LinksTable({ links, onDelete, showCreator }: { links: ShareLinkRow[]; onDelete: (id: string) => void; showCreator?: boolean }) {
  if (links.length === 0) {
    return (
      <div className="flex flex-col items-center py-16 text-[hsl(var(--muted-foreground))]">
        <Link2 size={36} strokeWidth={1.3} className="mb-2 opacity-50" />
        <p className="text-sm">No share links yet. Use “Share link…” on any file or folder.</p>
      </div>
    );
  }
  return (
    <ul className="divide-y border rounded-xl overflow-hidden">
      {links.map((l) => (
        <li key={l.id} className={cn("flex items-center gap-3 px-4 py-3", !l.active && "opacity-60")}>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate flex items-center gap-1.5">
              {l.hasPassword && <Lock size={12} className="shrink-0" />}
              <Link href={filesHref(parentOf(l.fileNode.relativePath))} className="hover:underline truncate">
                {l.fileNode.name}
              </Link>
              {!l.active && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[hsl(var(--muted))]">
                  {l.fileNode.inTrash ? "item in Trash" : l.revokedAt ? "revoked" : "expired"}
                </span>
              )}
            </p>
            <p className="text-xs text-[hsl(var(--muted-foreground))] truncate">
              {showCreator && `${l.createdBy.name} · `}
              {l.expiresAt ? `expires ${formatDate(l.expiresAt)}` : "never expires"}
              {!l.allowDownload && " · view only"} · opened {l.accessCount}×
              {l.lastAccessedAt && ` · last ${formatDate(l.lastAccessedAt)}`}
            </p>
          </div>
          {l.url && l.active && (
            <button onClick={() => copyText(l.url!)} className="p-2 rounded-md hover:bg-[hsl(var(--accent))]" aria-label="Copy link" title="Copy link">
              <Copy size={15} />
            </button>
          )}
          <button onClick={() => onDelete(l.id)} className="p-2 rounded-md hover:bg-red-500/10 text-red-500" aria-label="Delete link" title="Delete link">
            <Trash2 size={15} />
          </button>
        </li>
      ))}
    </ul>
  );
}
