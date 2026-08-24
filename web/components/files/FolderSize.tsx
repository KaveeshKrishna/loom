"use client";

import { useEffect, useState } from "react";
import { formatBytes } from "@/lib/utils";

interface FolderSizeProps {
  path: string;
}

export function FolderSize({ path }: FolderSizeProps) {
  const [size, setSize] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    const fetchSize = async () => {
      try {
        const res = await fetch(`/api/files/size?path=${encodeURIComponent(path)}`);
        if (!res.ok) throw new Error("Failed to fetch folder size");
        const data = await res.json();
        if (mounted) {
          setSize(data.size);
          setLoading(false);
        }
      } catch {
        if (mounted) {
          setLoading(false);
        }
      }
    };
    fetchSize();
    return () => {
      mounted = false;
    };
  }, [path]);

  if (loading) {
    return <span className="text-muted-foreground tracking-widest leading-none">...</span>;
  }

  if (size === null) {
    return null;
  }

  return <span>{formatBytes(BigInt(size))}</span>;
}
