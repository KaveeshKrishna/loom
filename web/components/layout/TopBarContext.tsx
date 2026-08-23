"use client";

import { createContext, useContext, useState, useEffect, ReactNode } from "react";

export type Breadcrumb = { label: string; href: string };

interface TopBarContextType {
  viewMode: "grid" | "list";
  setViewMode: (mode: "grid" | "list") => void;
  gridSize: "sm" | "md" | "lg" | "xl";
  setGridSize: (size: "sm" | "md" | "lg" | "xl") => void;
  pins: { id: string; name: string; href: string }[];
  togglePin: (pin: { id: string; name: string; href: string }) => void;
  breadcrumbs: Breadcrumb[];
  setBreadcrumbs: (crumbs: Breadcrumb[]) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  searchGlobal: boolean;
  setSearchGlobal: (b: boolean) => void;
}

const TopBarContext = createContext<TopBarContextType | null>(null);

export function TopBarProvider({ children, userEmail }: { children: ReactNode, userEmail: string }) {
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [gridSize, setGridSizeState] = useState<"sm" | "md" | "lg" | "xl">("lg");
  const [pins, setPins] = useState<{ id: string; name: string; href: string }[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchGlobal, setSearchGlobal] = useState(false);

  // Initialize from localStorage on client mount
  useEffect(() => {
    const savedGrid = localStorage.getItem(`loom-grid-size-${userEmail}`) as "sm" | "md" | "lg" | "xl" | null;
    if (savedGrid) setGridSizeState(savedGrid);

    const savedPins = localStorage.getItem(`loom-pins-${userEmail}`);
    if (savedPins) {
      try { setPins(JSON.parse(savedPins)); } catch {}
    }
  }, [userEmail]);

  const togglePin = (pin: { id: string; name: string; href: string }) => {
    setPins((prev) => {
      const exists = prev.some((p) => p.id === pin.id);
      const next = exists ? prev.filter((p) => p.id !== pin.id) : [...prev, pin];
      localStorage.setItem(`loom-pins-${userEmail}`, JSON.stringify(next));
      return next;
    });
  };

  const setGridSize = (size: "sm" | "md" | "lg" | "xl") => {
    setGridSizeState(size);
    localStorage.setItem(`loom-grid-size-${userEmail}`, size);
  };

  return (
    <TopBarContext.Provider value={{ viewMode, setViewMode, gridSize, setGridSize, pins, togglePin, breadcrumbs, setBreadcrumbs, searchQuery, setSearchQuery, searchGlobal, setSearchGlobal }}>
      {children}
    </TopBarContext.Provider>
  );
}

export function useTopBar() {
  const ctx = useContext(TopBarContext);
  if (!ctx) throw new Error("useTopBar must be used within TopBarProvider");
  return ctx;
}
