"use client";

/** Small "x GB of y GB used" meter at the bottom of the sidebar. */

import { useEffect, useState } from "react";
import Link from "next/link";
import { HardDrive } from "lucide-react";
import { formatBytes } from "@/lib/utils";

interface Disk {
  total: number;
  free: number;
  used: number;
}

export function StorageMeter({ isOwner }: { isOwner: boolean }) {
  const [media, setMedia] = useState<Disk | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/storage")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => alive && d?.media && setMedia(d.media))
        .catch(() => {});
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!media || !media.total) return null;
  const pct = Math.min(100, Math.round((media.used / media.total) * 100));
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    isOwner ? (
      <Link href="/settings?tab=storage" className="block px-4 py-3 border-t border-[hsl(var(--sidebar-border))] hover:bg-[hsl(var(--sidebar-item-hover))]">
        {children}
      </Link>
    ) : (
      <div className="px-4 py-3 border-t border-[hsl(var(--sidebar-border))]">{children}</div>
    );
  return (
    <Wrapper>
      <div className="flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))] mb-1.5">
        <HardDrive size={13} /> Storage
      </div>
      <div className="h-1.5 rounded-full bg-[hsl(var(--muted))] overflow-hidden">
        <div className={pct > 90 ? "h-full bg-red-500" : pct > 75 ? "h-full bg-amber-500" : "h-full bg-[hsl(var(--primary))]"} style={{ width: `${pct}%` }} />
      </div>
      <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-1.5">
        {formatBytes(media.used)} of {formatBytes(media.total)} used
      </p>
    </Wrapper>
  );
}
