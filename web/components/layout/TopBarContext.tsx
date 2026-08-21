"use client";

import { createContext, useContext, useState, ReactNode } from "react";

export type Breadcrumb = { label: string; href: string };

interface TopBarContextType {
  viewMode: "grid" | "list";
  setViewMode: (mode: "grid" | "list") => void;
  breadcrumbs: Breadcrumb[];
  setBreadcrumbs: (crumbs: Breadcrumb[]) => void;
}

const TopBarContext = createContext<TopBarContextType | null>(null);

export function TopBarProvider({ children }: { children: ReactNode }) {
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);

  return (
    <TopBarContext.Provider value={{ viewMode, setViewMode, breadcrumbs, setBreadcrumbs }}>
      {children}
    </TopBarContext.Provider>
  );
}

export function useTopBar() {
  const ctx = useContext(TopBarContext);
  if (!ctx) throw new Error("useTopBar must be used within TopBarProvider");
  return ctx;
}
