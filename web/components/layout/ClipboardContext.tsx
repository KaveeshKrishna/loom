"use client";

import { createContext, useCallback, useContext, useMemo, useState, ReactNode } from "react";

export type ClipboardAction = "COPY" | "CUT" | null;

export interface ClipboardState {
  action: ClipboardAction;
  paths: string[];
}

interface ClipboardContextType {
  clipboard: ClipboardState;
  copyToClipboard: (paths: string[]) => void;
  cutToClipboard: (paths: string[]) => void;
  clearClipboard: () => void;
}

const ClipboardContext = createContext<ClipboardContextType | null>(null);

export function ClipboardProvider({ children }: { children: ReactNode }) {
  const [clipboard, setClipboard] = useState<ClipboardState>({ action: null, paths: [] });

  const copyToClipboard = useCallback((paths: string[]) => setClipboard({ action: "COPY", paths }), []);
  const cutToClipboard = useCallback((paths: string[]) => setClipboard({ action: "CUT", paths }), []);
  const clearClipboard = useCallback(() => setClipboard({ action: null, paths: [] }), []);
  const value = useMemo(
    () => ({ clipboard, copyToClipboard, cutToClipboard, clearClipboard }),
    [clipboard, copyToClipboard, cutToClipboard, clearClipboard]
  );

  return (
    <ClipboardContext.Provider value={value}>
      {children}
    </ClipboardContext.Provider>
  );
}

export function useClipboard() {
  const ctx = useContext(ClipboardContext);
  if (!ctx) throw new Error("useClipboard must be used within ClipboardProvider");
  return ctx;
}
