"use client";

/** Settings → Sharing: turn public links on/off and manage everyone's links. */

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/client/api";
import { toast } from "@/components/ui/Toaster";
import { dialogs } from "@/components/ui/Dialog";
import { LinksTable } from "@/components/share/LinksTable";
import type { ShareLinkRow } from "@/components/files/ShareDialog";

export function SharingPanel() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [links, setLinks] = useState<ShareLinkRow[]>([]);
  const load = useCallback(async () => {
    const d = await api<{ enabled: boolean; links: ShareLinkRow[] }>("/api/shares?all=1");
    setEnabled(d.enabled);
    setLinks(d.links);
  }, []);
  useEffect(() => {
    load().catch((e) => toast.error((e as Error).message));
  }, [load]);

  const toggle = async (on: boolean) => {
    if (on) {
      const ok = await dialogs.confirm({
        title: "Turn on share links?",
        message:
          "Users will be able to create public links to files and folders they can access. Anyone who has a link can open it without an account (optionally protected by a password and expiry). You can delete any link here at any time, and turning sharing off disables all links at once.",
        confirmLabel: "Turn on",
      });
      if (!ok) return;
    }
    try {
      await api("/api/settings/sharing", { method: "PUT", json: { enabled: on } });
      setEnabled(on);
      toast.success(on ? "Share links are on" : "Share links are off — all links stopped working");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (enabled === null) return <Loader2 className="animate-spin text-[hsl(var(--muted-foreground))]" />;
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-base font-semibold">Sharing</h2>
        <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">Public links let people without an account view (and optionally download) a file or folder.</p>
      </div>
      <div className="bg-[hsl(var(--card))] border rounded-xl p-4 flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Allow share links</p>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">
            {enabled ? "On — users can create links. Turning this off disables every link immediately." : "Off — no link works, and nobody can create new ones."}
          </p>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          onClick={() => toggle(!enabled)}
          className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${enabled ? "bg-[hsl(var(--primary))]" : "bg-[hsl(var(--muted-foreground)/0.4)]"}`}
        >
          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${enabled ? "left-[22px]" : "left-0.5"}`} />
        </button>
      </div>
      <div>
        <p className="text-sm font-medium mb-2">All links ({links.length})</p>
        <LinksTable
          links={links}
          showCreator
          onDelete={async (id) => {
            if (!(await dialogs.confirm({ title: "Delete this link?", message: "Anyone using it will lose access.", confirmLabel: "Delete", danger: true }))) return;
            await api(`/api/shares/${id}`, { method: "DELETE" }).catch((e) => toast.error((e as Error).message));
            load();
          }}
        />
      </div>
    </div>
  );
}
