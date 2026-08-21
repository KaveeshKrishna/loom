"use client";

import { useEffect, useState } from "react";
import { Wifi, WifiOff, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type ArchiveStatus = "Online" | "Busy" | "Offline";

export function ArchiveStatusBadge({ className }: { className?: string }) {
  const [status, setStatus] = useState<ArchiveStatus | null>(null);

  useEffect(() => {
    const fetch_ = async () => {
      try {
        const res = await fetch("/api/archive");
        if (res.ok) {
          const data = await res.json();
          setStatus(data.status);
        }
      } catch {}
    };

    fetch_();
    const interval = setInterval(fetch_, 30000);
    return () => clearInterval(interval);
  }, []);

  if (!status) return null;

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full",
        status === "Online" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        status === "Busy" && "bg-amber-500/10 text-amber-600 dark:text-amber-400",
        status === "Offline" && "bg-rose-500/10 text-rose-600 dark:text-rose-400",
        className
      )}
      title={`Archive: ${status}`}
    >
      {status === "Online" && <Wifi size={12} />}
      {status === "Busy" && <Loader2 size={12} className="animate-spin" />}
      {status === "Offline" && <WifiOff size={12} />}
      <span>{status}</span>
    </div>
  );
}
