"use client";

import { useCallback, useEffect, useState } from "react";
import { Link2, Loader2 } from "lucide-react";
import { useNav } from "@/components/layout/TopBarContext";
import { api } from "@/lib/client/api";
import { toast } from "@/components/ui/Toaster";
import { dialogs } from "@/components/ui/Dialog";
import { LinksTable } from "@/components/share/LinksTable";
import type { ShareLinkRow } from "@/components/files/ShareDialog";

export default function SharedPage() {
  const { setBreadcrumbs } = useNav();
  const [links, setLinks] = useState<ShareLinkRow[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  useEffect(() => setBreadcrumbs([{ label: "Shared links", href: "/shared" }]), [setBreadcrumbs]);
  const load = useCallback(async () => {
    try {
      const d = await api<{ enabled: boolean; links: ShareLinkRow[] }>("/api/shares");
      setLinks(d.links);
      setEnabled(d.enabled);
    } catch (e) {
      toast.error((e as Error).message);
      setLinks([]);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-4">
      <div>
        <h1 className="text-lg font-semibold flex items-center gap-2"><Link2 size={19} /> Shared links</h1>
        <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">Links you&apos;ve created. Deleting a link makes it stop working immediately.</p>
        {!enabled && <p className="text-sm text-amber-600 mt-2">Sharing is currently turned off by the Owner, so none of these links work right now.</p>}
      </div>
      {!links ? (
        <div className="flex justify-center py-16"><Loader2 className="animate-spin text-[hsl(var(--muted-foreground))]" /></div>
      ) : (
        <LinksTable
          links={links}
          onDelete={async (id) => {
            if (!(await dialogs.confirm({ title: "Delete this link?", message: "Anyone using it will lose access.", confirmLabel: "Delete", danger: true }))) return;
            await api(`/api/shares/${id}`, { method: "DELETE" }).catch((e) => toast.error((e as Error).message));
            load();
          }}
        />
      )}
    </div>
  );
}
