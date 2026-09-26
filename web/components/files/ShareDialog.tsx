"use client";

/**
 * "Share link…" dialog: create a public link to a file or folder, with an
 * optional expiry and password, and see/copy/revoke the item's existing links.
 * Promise-free: call openShareDialog(node); <ShareHost/> renders it.
 */

import { useCallback, useEffect, useState } from "react";
import { Copy, Link2, Loader2, Lock, Trash2, Clock, Download, AlertTriangle } from "lucide-react";
import { Dialog, Button } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toaster";
import { api } from "@/lib/client/api";
import type { LNode } from "@/lib/client/types";
import { formatDate } from "@/lib/utils";

export interface ShareLinkRow {
  id: string;
  url: string | null;
  fileNode: { id: string; name: string; relativePath: string; type: string; inTrash: boolean };
  createdBy: { id: string; name: string };
  hasPassword: boolean;
  allowDownload: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  lastAccessedAt: string | null;
  accessCount: number;
  active: boolean;
}

type Target = Pick<LNode, "id" | "name" | "type">;
const subs = new Set<(t: Target | null) => void>();

export function openShareDialog(node: Target) {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "1") {
    toast.info("Share links need a real Loom server — they aren't available in the demo.");
    return;
  }
  subs.forEach((s) => s(node));
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs HTTPS; fall back to a hidden textarea.
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast.success("Link copied");
}

export function ShareHost() {
  const [node, setNode] = useState<Target | null>(null);
  useEffect(() => {
    subs.add(setNode);
    return () => {
      subs.delete(setNode);
    };
  }, []);
  if (!node) return null;
  return (
    <ShareDialogBody
      node={node}
      onClose={() => setNode(null)}
    />
  );
}

function ShareDialogBody({ node, onClose }: { node: Target; onClose: () => void }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [links, setLinks] = useState<ShareLinkRow[]>([]);
  const [expiry, setExpiry] = useState("7");
  const [password, setPassword] = useState("");
  const [allowDownload, setAllowDownload] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const d = await api<{ enabled: boolean; links: ShareLinkRow[] }>(`/api/shares?fileNodeId=${encodeURIComponent(node.id)}`);
    setEnabled(d.enabled);
    setLinks(d.links);
  }, [node.id]);
  useEffect(() => {
    load().catch((e) => toast.error((e as Error).message));
  }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      const r = await api<{ link: ShareLinkRow }>("/api/shares", {
        method: "POST",
        json: { fileNodeId: node.id, expiresInDays: expiry === "never" ? null : Number(expiry), password: password || undefined, allowDownload },
      });
      if (r.link.url) await copyText(r.link.url);
      setPassword("");
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    try {
      await api(`/api/shares/${id}`, { method: "DELETE" });
      await load();
      toast.success("Link deleted — it no longer works");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const active = links.filter((l) => l.active);

  return (
    <Dialog open onClose={onClose} title={<span className="flex items-center gap-2"><Link2 size={17} /> Share “{node.name}”</span>}>
      {enabled === null ? (
        <div className="flex justify-center py-8"><Loader2 className="animate-spin text-[hsl(var(--muted-foreground))]" /></div>
      ) : !enabled ? (
        <div className="flex gap-3 text-sm">
          <AlertTriangle size={18} className="text-amber-500 shrink-0 mt-0.5" />
          <p className="text-[hsl(var(--muted-foreground))]">
            Share links are turned off on this server. The Owner can enable them in <span className="font-medium text-[hsl(var(--foreground))]">Settings → Sharing</span>.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="space-y-3">
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              Anyone with the link can view {node.type === "DIRECTORY" ? "this folder and everything in it" : "this file"} — no account needed.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs font-medium space-y-1">
                <span className="flex items-center gap-1"><Clock size={12} /> Expires</span>
                <select value={expiry} onChange={(e) => setExpiry(e.target.value)} className="w-full px-2.5 py-2 rounded-lg border bg-[hsl(var(--background))] text-sm">
                  <option value="1">In 1 day</option>
                  <option value="7">In 7 days</option>
                  <option value="30">In 30 days</option>
                  <option value="365">In 1 year</option>
                  <option value="never">Never</option>
                </select>
              </label>
              <label className="text-xs font-medium space-y-1">
                <span className="flex items-center gap-1"><Lock size={12} /> Password (optional)</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="No password"
                  className="w-full px-2.5 py-2 rounded-lg border bg-[hsl(var(--background))] text-sm"
                />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={allowDownload} onChange={(e) => setAllowDownload(e.target.checked)} />
              <Download size={14} /> Allow downloading
            </label>
            <Button variant="primary" onClick={create} disabled={busy || (password.length > 0 && password.length < 4)} className="w-full flex items-center justify-center gap-2">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Link2 size={15} />} Create link & copy
            </Button>
          </div>

          {active.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))] mb-2">Active links</p>
              <ul className="space-y-2">
                {active.map((l) => (
                  <li key={l.id} className="flex items-center gap-2 border rounded-lg px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-mono truncate">{l.url ?? "(link can't be shown — create a new one)"}</p>
                      <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
                        {l.expiresAt ? `Expires ${formatDate(l.expiresAt)}` : "Never expires"}
                        {l.hasPassword && " · password"}
                        {!l.allowDownload && " · view only"} · opened {l.accessCount}×
                      </p>
                    </div>
                    {l.url && (
                      <button onClick={() => copyText(l.url!)} className="p-1.5 rounded-md hover:bg-[hsl(var(--accent))]" aria-label="Copy link">
                        <Copy size={15} />
                      </button>
                    )}
                    <button onClick={() => revoke(l.id)} className="p-1.5 rounded-md hover:bg-red-500/10 text-red-500" aria-label="Delete link">
                      <Trash2 size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
