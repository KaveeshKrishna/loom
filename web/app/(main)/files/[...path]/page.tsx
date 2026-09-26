"use client";

/**
 * A folder. Breadcrumbs come from the live URL (usePathname), not route
 * params — in the demo's static export route params are frozen at build
 * time, while the pathname always tracks the address bar.
 */

import { Suspense, useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { FileBrowser } from "@/components/files/FileBrowser";
import { useNav, useSearch } from "@/components/layout/TopBarContext";
import { useFolder } from "@/lib/client/hooks";
import { api, filesHref } from "@/lib/client/api";
import type { LNode } from "@/lib/client/types";

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export default function FilesPage() {
  // useSearchParams needs a Suspense boundary for static rendering.
  return (
    <Suspense fallback={null}>
      <FolderView />
    </Suspense>
  );
}

function FolderView() {
  const pathname = usePathname();
  const params = useSearchParams();
  const segments = useMemo(() => {
    const rel = pathname.replace(/^\/files(?:\.html)?\/?/, "");
    return rel ? rel.split("/").filter(Boolean).map(safeDecode) : [];
  }, [pathname]);
  const currentPath = segments.join("/");

  const { setBreadcrumbs } = useNav();
  const { debouncedQuery, searchGlobal } = useSearch();

  useEffect(() => {
    const crumbs = [{ label: "Home", href: "/files", path: "" }];
    segments.forEach((seg, i) => {
      const p = segments.slice(0, i + 1).join("/");
      crumbs.push({ label: seg, href: filesHref(p), path: p });
    });
    setBreadcrumbs(crumbs);
  }, [segments, setBreadcrumbs]);

  const folder = useFolder(currentPath);

  // Search inside this folder (and its sub-folders)
  const [results, setResults] = useState<LNode[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchHere = !!debouncedQuery && !searchGlobal;
  useEffect(() => {
    if (!searchHere) {
      setResults(null);
      return;
    }
    const ctrl = new AbortController();
    setSearching(true);
    api<{ results: LNode[] }>(`/api/search?q=${encodeURIComponent(debouncedQuery)}&folder=${encodeURIComponent(currentPath)}&limit=200`, { signal: ctrl.signal })
      .then((d) => setResults(d.results))
      .catch(() => {})
      .finally(() => !ctrl.signal.aborted && setSearching(false));
    return () => ctrl.abort();
  }, [searchHere, debouncedQuery, currentPath]);

  if (searchHere) {
    return (
      <FileBrowser
        nodes={results ?? []}
        loading={searching && !results}
        showPath
        preserveOrder
        emptyState={<p className="py-24 text-center text-sm text-[hsl(var(--muted-foreground))]">No matches for “{debouncedQuery}” in this folder</p>}
      />
    );
  }

  return (
    <FileBrowser
      nodes={folder.nodes}
      loading={folder.loading}
      error={folder.error}
      folderPath={currentPath}
      canWrite={folder.canWrite}
      openId={params.get("open")}
      editPath={params.get("edit")}
    />
  );
}
