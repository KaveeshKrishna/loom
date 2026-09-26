"use client";

/** Library-wide views (Photos, Videos, Documents, Starred, Recent) built on FileBrowser. */

import { useEffect, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useInfiniteNodes } from "@/hooks/useInfiniteNodes";
import { useNav, useSearch } from "@/components/layout/TopBarContext";
import type { LNode } from "@/lib/client/types";
import { FileBrowser } from "./FileBrowser";

export function CollectionView({
  title,
  href,
  url,
  nodesKey = "nodes",
  map,
  empty,
}: {
  title: string;
  href: string;
  url: string;
  nodesKey?: string;
  map?: (item: unknown) => LNode;
  empty: ReactNode;
}) {
  const { setBreadcrumbs } = useNav();
  const { searchQuery, searchGlobal } = useSearch();
  useEffect(() => setBreadcrumbs([{ label: title, href }]), [setBreadcrumbs, title, href]);

  const { nodes, loading, loadingMore, hasMore, error, sentinelRef } = useInfiniteNodes<LNode>(url, nodesKey, 150, map);
  const q = !searchGlobal ? searchQuery.trim().toLowerCase() : "";
  const shown = q ? nodes.filter((n) => n.name.toLowerCase().includes(q)) : nodes;

  return (
    <FileBrowser
      nodes={shown}
      loading={loading}
      error={error}
      showPath
      preserveOrder
      emptyState={empty}
      footer={
        hasMore ? (
          <div ref={sentinelRef} className="flex justify-center py-6">
            {loadingMore && <Loader2 size={20} className="animate-spin text-[hsl(var(--muted-foreground))]" />}
          </div>
        ) : null
      }
    />
  );
}

export function EmptyCollection({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center px-6 text-[hsl(var(--muted-foreground))]">
      <div className="mb-3 opacity-50">{icon}</div>
      <p className="text-sm font-medium text-[hsl(var(--foreground))]">{title}</p>
      <p className="text-sm mt-1 max-w-sm">{text}</p>
    </div>
  );
}
