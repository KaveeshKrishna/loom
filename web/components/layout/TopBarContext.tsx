"use client";

/**
 * App-wide UI state, split into small contexts so that typing in the search
 * box doesn't re-render every file tile (and vice versa):
 *
 *   useViewPrefs() — grid/list, grid size, sort, type filter, details panel
 *                    (persisted per user in localStorage)
 *   useSearch()    — search text (debounced for queries) + scope
 *   useNav()       — breadcrumbs and pinned folders
 *
 * useTopBar() returns everything, for components that genuinely need it.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Breadcrumb = { label: string; href: string; path?: string };
export type ViewMode = "grid" | "list";
export type GridSize = "sm" | "md" | "lg" | "xl";
export type SortKey = "name" | "modified" | "size" | "type";
export type SortDir = "asc" | "desc";
export type TypeFilter = "all" | "folders" | "image" | "video" | "audio" | "document" | "other";
export interface Pin {
  id: string;
  name: string;
  href: string;
  path?: string;
}

interface ViewPrefs {
  viewMode: ViewMode;
  setViewMode: (m: ViewMode) => void;
  gridSize: GridSize;
  setGridSize: (s: GridSize) => void;
  sortKey: SortKey;
  sortDir: SortDir;
  setSort: (key: SortKey, dir?: SortDir) => void;
  typeFilter: TypeFilter;
  setTypeFilter: (f: TypeFilter) => void;
  detailsOpen: boolean;
  setDetailsOpen: (v: boolean) => void;
}

interface SearchState {
  searchQuery: string;
  /** searchQuery after the user stopped typing for 250 ms — use this for requests */
  debouncedQuery: string;
  setSearchQuery: (q: string) => void;
  searchGlobal: boolean;
  setSearchGlobal: (b: boolean) => void;
}

interface NavState {
  breadcrumbs: Breadcrumb[];
  setBreadcrumbs: (crumbs: Breadcrumb[]) => void;
  pins: Pin[];
  togglePin: (pin: Pin) => void;
  /** Keep pins pointing at the right place after a folder is renamed/moved/deleted. */
  updatePinsForMove: (oldPath: string, newPath: string | null) => void;
}

const ViewPrefsContext = createContext<ViewPrefs | null>(null);
const SearchContext = createContext<SearchState | null>(null);
const NavContext = createContext<NavState | null>(null);

function read<T>(key: string, fallback: T, valid?: (v: unknown) => boolean): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const v = JSON.parse(raw);
    return valid && !valid(v) ? fallback : (v as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

export function TopBarProvider({ children, userEmail }: { children: ReactNode; userEmail: string }) {
  const k = (name: string) => `loom-${name}-${userEmail}`;

  // ── view prefs ──
  const [viewMode, setViewModeState] = useState<ViewMode>("grid");
  const [gridSize, setGridSizeState] = useState<GridSize>("lg");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [typeFilter, setTypeFilterState] = useState<TypeFilter>("all");
  const [detailsOpen, setDetailsOpenState] = useState(false);

  // ── nav ──
  const [pins, setPins] = useState<Pin[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);

  useEffect(() => {
    setViewModeState(read(k("view-mode"), "grid", (v) => v === "grid" || v === "list"));
    // grid size used to be stored as a bare string
    const legacy = (() => {
      try {
        return localStorage.getItem(`loom-grid-size-${userEmail}`);
      } catch {
        return null;
      }
    })();
    const gs = legacy && ["sm", "md", "lg", "xl"].includes(legacy) ? legacy : read(k("grid"), "lg");
    setGridSizeState(gs as GridSize);
    const sort = read<{ key: SortKey; dir: SortDir }>(k("sort"), { key: "name", dir: "asc" });
    setSortKey(sort.key);
    setSortDir(sort.dir);
    setDetailsOpenState(read(k("details"), false));
    setPins(read<Pin[]>(`loom-pins-${userEmail}`, [], Array.isArray));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userEmail]);

  const setViewMode = useCallback((m: ViewMode) => {
    setViewModeState(m);
    write(k("view-mode"), m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userEmail]);
  const setGridSize = useCallback((s: GridSize) => {
    setGridSizeState(s);
    try {
      localStorage.setItem(`loom-grid-size-${userEmail}`, s);
    } catch {
      /* ignore */
    }
  }, [userEmail]);
  const setSort = useCallback((key: SortKey, dir?: SortDir) => {
    setSortKey((prevKey) => {
      setSortDir((prevDir) => {
        const next = dir ?? (prevKey === key ? (prevDir === "asc" ? "desc" : "asc") : key === "name" || key === "type" ? "asc" : "desc");
        write(k("sort"), { key, dir: next });
        return next;
      });
      return key;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userEmail]);
  const setTypeFilter = useCallback((f: TypeFilter) => setTypeFilterState(f), []);
  const setDetailsOpen = useCallback((v: boolean) => {
    setDetailsOpenState(v);
    write(k("details"), v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userEmail]);

  const togglePin = useCallback((pin: Pin) => {
    setPins((prev) => {
      const next = prev.some((p) => p.id === pin.id) ? prev.filter((p) => p.id !== pin.id) : [...prev, pin];
      write(`loom-pins-${userEmail}`, next);
      return next;
    });
  }, [userEmail]);

  const updatePinsForMove = useCallback((oldPath: string, newPath: string | null) => {
    setPins((prev) => {
      let changed = false;
      const next: Pin[] = [];
      for (const p of prev) {
        const path = p.path ?? decodeURIComponent(p.href.replace(/^\/files\/?/, ""));
        if (path === oldPath || path.startsWith(oldPath + "/")) {
          changed = true;
          if (newPath === null) continue; // deleted
          const np = newPath + path.slice(oldPath.length);
          next.push({
            ...p,
            path: np,
            name: path === oldPath ? np.split("/").pop()! : p.name,
            href: "/files/" + np.split("/").map(encodeURIComponent).join("/"),
          });
        } else next.push(p);
      }
      if (!changed) return prev;
      write(`loom-pins-${userEmail}`, next);
      return next;
    });
  }, [userEmail]);

  // ── search ──
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [searchGlobal, setSearchGlobal] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 250);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const viewPrefs = useMemo<ViewPrefs>(
    () => ({ viewMode, setViewMode, gridSize, setGridSize, sortKey, sortDir, setSort, typeFilter, setTypeFilter, detailsOpen, setDetailsOpen }),
    [viewMode, setViewMode, gridSize, setGridSize, sortKey, sortDir, setSort, typeFilter, setTypeFilter, detailsOpen, setDetailsOpen]
  );
  const search = useMemo<SearchState>(
    () => ({ searchQuery, debouncedQuery, setSearchQuery, searchGlobal, setSearchGlobal }),
    [searchQuery, debouncedQuery, searchGlobal]
  );
  const nav = useMemo<NavState>(
    () => ({ breadcrumbs, setBreadcrumbs, pins, togglePin, updatePinsForMove }),
    [breadcrumbs, pins, togglePin, updatePinsForMove]
  );

  return (
    <ViewPrefsContext.Provider value={viewPrefs}>
      <NavContext.Provider value={nav}>
        <SearchContext.Provider value={search}>{children}</SearchContext.Provider>
      </NavContext.Provider>
    </ViewPrefsContext.Provider>
  );
}

function need<T>(v: T | null, name: string): T {
  if (!v) throw new Error(`${name} must be used within TopBarProvider`);
  return v;
}

export const useViewPrefs = () => need(useContext(ViewPrefsContext), "useViewPrefs");
export const useSearch = () => need(useContext(SearchContext), "useSearch");
export const useNav = () => need(useContext(NavContext), "useNav");

export function useTopBar() {
  return { ...useViewPrefs(), ...useSearch(), ...useNav() };
}
