import React, { useState, useCallback, RefObject } from "react";
import type { FileNode } from "@prisma/client";

export interface ContextMenuPosition {
  x: number;
  y: number;
}

export function useContextMenu() {
  const [position, setPosition] = useState<ContextMenuPosition | null>(null);
  const [node, setNode] = useState<FileNode | null>(null);

  const open = useCallback((e: React.MouseEvent | React.TouchEvent | CustomEvent, nodeData: FileNode | null = null, buttonRef?: RefObject<HTMLElement | null>) => {
    // If opened programmatically via button
    if (buttonRef?.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPosition({ x: rect.right, y: rect.bottom });
    } else {
      let x = 0, y = 0;
      if ("touches" in e && e.touches.length > 0) {
        x = e.touches[0].clientX;
        y = e.touches[0].clientY;
      } else if ("clientX" in e) {
        x = (e as React.MouseEvent).clientX;
        y = (e as React.MouseEvent).clientY;
      }
      setPosition({ x, y });
    }
    setNode(nodeData);
  }, []);

  const close = useCallback(() => {
    setPosition(null);
    setNode(null);
  }, []);

  return {
    isOpen: position !== null,
    position,
    node,
    open,
    close
  };
}
