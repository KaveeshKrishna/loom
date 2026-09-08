"use client";

import { createContext, useContext, useState, ReactNode } from "react";

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

  const copyToClipboard = (paths: string[]) => {
    setClipboard({ action: "COPY", paths });
  };

  const cutToClipboard = (paths: string[]) => {
    setClipboard({ action: "CUT", paths });
  };

  const clearClipboard = () => {
    setClipboard({ action: null, paths: [] });
  };

  return (
    <ClipboardContext.Provider value={{ clipboard, copyToClipboard, cutToClipboard, clearClipboard }}>
      {children}
    </ClipboardContext.Provider>
  );
}

export function useClipboard() {
  const ctx = useContext(ClipboardContext);
  if (!ctx) throw new Error("useClipboard must be used within ClipboardProvider");
  return ctx;
}
