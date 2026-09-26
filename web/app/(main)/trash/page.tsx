"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Trash2, RotateCcw, X, AlertTriangle, FolderInput, History, Search } from "lucide-react";
import { useNav } from "@/components/layout/TopBarContext";
import { formatBytes, cn } from "@/lib/utils";
import { FileIcon } from "@/components/files/FileIcon";
import { restoreItems } from "@/components/files/actions";
import { pickFolder } from "@/components/files/FolderPicker";
import { dialogs } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toaster";
import { api, parentOf } from "@/lib/client/api";
import { useDirChanges } from "@/lib/client/live";
import { thumbUrl, type LNode } from "@/lib/client/types";

interface TrashEntry {
  id: string;
  fileNodeId: string;
  originalPath: string;
  deletedAt: string;
  expiresAt: string;
  kind: string;
  user: { name: string } | null;
  fileNode: LNode;
}

function daysLeft(expires: string) {
  return Math.max(0, Math.ceil((new Date(expires).getTime() - Date.now()) / 86_400_000));
}

export default function TrashPage() {
  const { setBreadcrumbs } = useNav();
  const [items, setItems] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => setBreadcrumbs([{ label: "Trash", href: "/trash" }]), [setBreadcrumbs]);

  const load = useCallback(async () => {
    try {
      const d = await api<{ trashItems: TrashEntry[] }>("/api/fs/trash");
      setItems(d.trashItems);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useDirChanges(".LoomTrash", () => load());
  useDirChanges(null, () => load(), 2000);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? items.filter((i) => i.originalPath.toLowerCase().includes(q)) : items;
  }, [items, filter]);

  const restore = async (item: TrashEntry, dest?: string) => {
    setBusy(item.id);
    await restoreItems([item.fileNodeId], dest);
    setBusy(null);
    load();
  };

  const deleteForever = async (item: TrashEntry) => {
    const ok = await dialogs.confirm({
      title: `Delete "${item.fileNode.name}" forever?`,
      message: "This can't be undone.",
      confirmLabel: "Delete forever",
      danger: true,
    });
    if (!ok) return;
    setBusy(item.id);
    try {
      await api(`/api/fs/trash/${item.id}`, { method: "DELETE" });
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const emptyTrash = async () => {
    const ok = await dialogs.confirm({
      title: "Empty Trash?",
      message: `All ${items.length} item(s) will be permanently deleted. This can't be undone.`,
      confirmLabel: "Empty Trash",
      danger: true,
    });
    if (!ok) return;
    setLoading(true);
    try {
      const r = await api<{ deletedCount: number }>("/api/fs/trash", { method: "DELETE" });
      toast.success(`Permanently deleted ${r.deletedCount} item(s)`);
    } catch (e) {
      toast.error((e as Error).message);
    }
    await load();
  };

  return (
    <div className="max-w-5xl mx-auto">
      <div className="px-4 sm:px-6 py-5 border-b flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[200px]">
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <Trash2 size={19} /> Trash
          </h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">Items are permanently deleted 15 days after they were moved here.</p>
        </div>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter"
            className="pl-8 pr-3 py-1.5 text-sm rounded-lg bg-[hsl(var(--accent))] border border-transparent focus:border-[hsl(var(--primary)/0.4)] focus:outline-none w-44"
          />
        </div>
        {items.length > 0 && (
          <button onClick={emptyTrash} className="px-3 py-1.5 rounded-lg text-sm font-medium text-red-600 border border-red-500/30 hover:bg-red-500/10">
            Empty Trash
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-20 text-[hsl(var(--muted-foreground))]">
          <Loader2 className="animate-spin" />
        </div>
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-[hsl(var(--muted-foreground))]">
          <Trash2 size={44} strokeWidth={1.2} className="mb-3 opacity-40" />
          <p className="text-sm">{items.length ? "Nothing matches" : "Trash is empty"}</p>
        </div>
      ) : (
        <ul className="divide-y">
          {shown.map((item) => {
            const t = thumbUrl(item.fileNode);
            const left = daysLeft(item.expiresAt);
            return (
              <li key={item.id} className="flex items-center gap-3 px-4 sm:px-6 py-3 hover:bg-[hsl(var(--accent)/0.4)]">
                <div className="w-10 h-10 rounded-md bg-[hsl(var(--accent))] overflow-hidden flex items-center justify-center shrink-0">
                  {t ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={t} alt="" className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <FileIcon mimeType={item.fileNode.mimeType} type={item.fileNode.type} size={20} name={item.fileNode.name} />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate flex items-center gap-2">
                    {item.fileNode.name}
                    {item.kind === "VERSION" && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400">
                        <History size={10} /> previous version
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-[hsl(var(--muted-foreground))] truncate">
                    {item.kind === "VERSION" ? "Saved from" : "From"} {parentOf(item.originalPath) || "Home"}
                    {item.fileNode.size != null && ` · ${formatBytes(Number(item.fileNode.size))}`}
                    {item.user && ` · by ${item.user.name}`} · {new Date(item.deletedAt).toLocaleDateString()}
                  </p>
                </div>
                <span className={cn("hidden sm:flex items-center gap-1 text-xs shrink-0", left <= 2 ? "text-red-500" : "text-[hsl(var(--muted-foreground))]")}>
                  {left <= 2 && <AlertTriangle size={12} />}
                  {left === 0 ? "Deleting soon" : `${left} day${left === 1 ? "" : "s"} left`}
                </span>
                <div className="flex items-center gap-0.5 shrink-0">
                  {busy === item.id ? (
                    <Loader2 size={16} className="animate-spin text-[hsl(var(--muted-foreground))] mx-2" />
                  ) : (
                    <>
                      <button onClick={() => restore(item)} className="p-2 rounded-md hover:bg-[hsl(var(--accent))]" title={item.kind === "VERSION" ? "Restore (asks before replacing the current file)" : "Restore"} aria-label="Restore">
                        <RotateCcw size={16} />
                      </button>
                      <button
                        onClick={async () => {
                          const dest = await pickFolder({ title: `Restore "${item.fileNode.name}" to…`, confirmLabel: "Restore", start: parentOf(item.originalPath) });
                          if (dest !== null) restore(item, dest);
                        }}
                        className="p-2 rounded-md hover:bg-[hsl(var(--accent))]"
                        title="Restore to a different folder"
                        aria-label="Restore to"
                      >
                        <FolderInput size={16} />
                      </button>
                      <button onClick={() => deleteForever(item)} className="p-2 rounded-md hover:bg-red-500/10 text-red-500" title="Delete forever" aria-label="Delete forever">
                        <X size={16} />
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
