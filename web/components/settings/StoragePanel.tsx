"use client";

/** Settings → Storage: drive usage and what the library is made of. */

import { useEffect, useState } from "react";
import { HardDrive, Loader2 } from "lucide-react";
import { formatBytes } from "@/lib/utils";

interface Disk {
  total: number;
  free: number;
  used: number;
}
interface Storage {
  media: Disk | null;
  cache: Disk | null;
  breakdown?: Record<string, { bytes: string; files: number }>;
  trashBytes?: string;
}

const LABELS: Record<string, { label: string; color: string }> = {
  image: { label: "Photos", color: "bg-violet-500" },
  video: { label: "Videos", color: "bg-rose-500" },
  audio: { label: "Audio", color: "bg-amber-500" },
  document: { label: "Documents", color: "bg-blue-500" },
  other: { label: "Other", color: "bg-slate-400" },
};

function DiskCard({ title, disk, note }: { title: string; disk: Disk | null; note: string }) {
  if (!disk) return null;
  const pct = disk.total ? Math.round((disk.used / disk.total) * 100) : 0;
  return (
    <div className="bg-[hsl(var(--card))] border rounded-xl p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium flex items-center gap-2">
          <HardDrive size={15} /> {title}
        </p>
        <p className="text-xs text-[hsl(var(--muted-foreground))]">{formatBytes(disk.free)} free</p>
      </div>
      <div className="mt-3 h-2 rounded-full bg-[hsl(var(--muted))] overflow-hidden">
        <div className={pct > 90 ? "h-full bg-red-500" : pct > 75 ? "h-full bg-amber-500" : "h-full bg-[hsl(var(--primary))]"} style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-[hsl(var(--muted-foreground))] mt-2">
        {formatBytes(disk.used)} of {formatBytes(disk.total)} used ({pct}%) · {note}
      </p>
    </div>
  );
}

export function StoragePanel() {
  const [s, setS] = useState<Storage | null>(null);
  useEffect(() => {
    fetch("/api/storage")
      .then((r) => r.json())
      .then(setS)
      .catch(() => {});
  }, []);
  if (!s) return <Loader2 className="animate-spin text-[hsl(var(--muted-foreground))]" />;
  const entries = Object.entries(s.breakdown ?? {}).sort((a, b) => Number(b[1].bytes) - Number(a[1].bytes));
  const total = entries.reduce((acc, [, v]) => acc + Number(v.bytes), 0);
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-base font-semibold">Storage</h2>
        <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">How full your drives are and what your library is made of.</p>
      </div>
      <DiskCard title="Media drive" disk={s.media} note="your files (LOOM_MEDIA_PATH)" />
      <DiskCard title="Cache drive" disk={s.cache} note="thumbnails, previews and converted video (LOOM_CACHE_PATH)" />
      {entries.length > 0 && (
        <div className="bg-[hsl(var(--card))] border rounded-xl p-4">
          <p className="text-sm font-medium mb-3">Library by type · {formatBytes(total)}</p>
          <div className="flex h-3 rounded-full overflow-hidden bg-[hsl(var(--muted))]">
            {entries.map(([k, v]) => (
              <div key={k} className={LABELS[k]?.color ?? "bg-slate-400"} style={{ width: `${total ? (Number(v.bytes) / total) * 100 : 0}%` }} title={LABELS[k]?.label ?? k} />
            ))}
          </div>
          <ul className="mt-3 space-y-1.5">
            {entries.map(([k, v]) => (
              <li key={k} className="flex items-center gap-2 text-sm">
                <span className={`w-2.5 h-2.5 rounded-full ${LABELS[k]?.color ?? "bg-slate-400"}`} />
                <span className="flex-1">{LABELS[k]?.label ?? k}</span>
                <span className="text-[hsl(var(--muted-foreground))] text-xs">{v.files.toLocaleString()} files</span>
                <span className="w-20 text-right">{formatBytes(v.bytes)}</span>
              </li>
            ))}
            {s.trashBytes && Number(s.trashBytes) > 0 && (
              <li className="flex items-center gap-2 text-sm pt-1.5 border-t">
                <span className="w-2.5 h-2.5 rounded-full bg-transparent border" />
                <span className="flex-1">In Trash</span>
                <span className="w-20 text-right">{formatBytes(s.trashBytes)}</span>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
