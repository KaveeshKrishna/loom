"use client";

import { useEffect, useState } from "react";
import { useTopBar } from "@/components/layout/TopBarContext";
import { Loader2, Trash2, RefreshCw, X, AlertTriangle } from "lucide-react";
import type { FileNode, TrashItem, Thumbnail, Preview } from "@prisma/client";
import { formatBytes } from "@/lib/utils";
import { FileIcon } from "@/components/files/FileIcon";

type FileNodeWithThumbnail = FileNode & { contentIdentity?: { thumbnail: Thumbnail | null; preview: Preview | null } | null };
type TrashItemPopulated = TrashItem & { fileNode: FileNodeWithThumbnail };

export default function TrashPage() {
  const { setBreadcrumbs } = useTopBar();
  const [items, setItems] = useState<TrashItemPopulated[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Trash", href: "/trash" }]);
    fetchTrash();
  }, [setBreadcrumbs]);

  const fetchTrash = async () => {
    try {
      const res = await fetch("/api/fs/trash");
      const data = await res.json();
      if (data.trashItems) {
        setItems(data.trashItems);
      }
    } catch (err) {
      console.error("Failed to fetch trash", err);
    } finally {
      setLoading(false);
    }
  };

  const handleRestore = async (id: string, fileNodeId: string) => {
    setProcessing(id);
    try {
      const res = await fetch("/api/fs/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileNodeIds: [fileNodeId] }),
      });
      const data = await res.json();
      if (data.results?.[0]?.success) {
        setItems((prev) => prev.filter((i) => i.id !== id));
      } else {
        alert(data.results?.[0]?.error || "Failed to restore");
      }
    } catch (err) {
      console.error(err);
    } finally {
      setProcessing(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to permanently delete this item?")) return;
    setProcessing(id);
    try {
      const res = await fetch(`/api/fs/trash/${id}`, { method: "DELETE" });
      if (res.ok) {
        setItems((prev) => prev.filter((i) => i.id !== id));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setProcessing(null);
    }
  };

  const handleEmptyTrash = async () => {
    if (!confirm("Are you sure you want to empty the trash? This cannot be undone.")) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/fs/trash`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        setItems([]);
      } else {
        alert(data.error || "Failed to empty trash");
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="px-6 py-5 border-b flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Trash2 size={20} className="text-red-500" />
            <h1 className="text-lg font-semibold">Trash</h1>
          </div>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">
            Items are permanently deleted after 15 days.
          </p>
        </div>
        {items.length > 0 && (
          <button
            onClick={handleEmptyTrash}
            className="px-4 py-2 bg-red-50 text-red-600 hover:bg-red-100 rounded-md text-sm font-medium transition-colors flex items-center gap-2 dark:bg-red-500/10 dark:hover:bg-red-500/20"
          >
            <AlertTriangle size={16} />
            Empty Trash
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 size={24} className="animate-spin text-[hsl(var(--muted-foreground))]" />
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-[hsl(var(--muted-foreground))]">
          <Trash2 size={48} className="mb-4 opacity-20" />
          <p>Your trash is empty.</p>
        </div>
      ) : (
        <div className="divide-y">
          {items.map((item) => (
            <div key={item.id} className="flex items-center justify-between px-6 py-4 hover:bg-[hsl(var(--accent))] transition-colors group">
              <div className="flex items-center gap-4 min-w-0 flex-1">
                <FileIcon type={item.fileNode.type} mimeType={item.fileNode.mimeType} className="w-10 h-10 shrink-0" />
                <div className="min-w-0">
                  <p className="font-medium truncate">{item.fileNode.name}</p>
                  <p className="text-xs text-[hsl(var(--muted-foreground))] truncate">
                    Original location: {item.originalPath} • {formatBytes(Number(item.fileNode.size))}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-6 shrink-0 ml-4">
                <div className="text-right">
                  <p className="text-sm">Expires in {Math.max(0, Math.ceil((new Date(item.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))} days</p>
                </div>
                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleRestore(item.id, item.fileNodeId)}
                    disabled={processing === item.id}
                    className="p-2 rounded-md hover:bg-blue-50 text-blue-600 transition-colors disabled:opacity-50 dark:hover:bg-blue-500/20"
                    title="Restore"
                  >
                    {processing === item.id ? <Loader2 size={18} className="animate-spin" /> : <RefreshCw size={18} />}
                  </button>
                  <button
                    onClick={() => handleDelete(item.id)}
                    disabled={processing === item.id}
                    className="p-2 rounded-md hover:bg-red-50 text-red-600 transition-colors disabled:opacity-50 dark:hover:bg-red-500/20"
                    title="Delete permanently"
                  >
                    {processing === item.id ? <Loader2 size={18} className="animate-spin" /> : <X size={18} />}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
