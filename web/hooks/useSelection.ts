import { useState, useCallback } from "react";

export function useSelection(itemIds: string[]) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);

  const toggleSelection = useCallback((id: string, multi: boolean, shift: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const currentIndex = itemIds.indexOf(id);

      if (shift && lastSelectedIndex !== null && currentIndex !== -1) {
        // Shift-click: range selection
        const start = Math.min(lastSelectedIndex, currentIndex);
        const end = Math.max(lastSelectedIndex, currentIndex);
        
        if (!multi) next.clear(); // If not ctrl-clicking, clear other selections first
        
        for (let i = start; i <= end; i++) {
          if (itemIds[i]) next.add(itemIds[i]);
        }
      } else if (multi) {
        // Ctrl-click: toggle single item
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        setLastSelectedIndex(currentIndex);
      } else {
        // Normal click (though we intercept this before calling toggle if they just clicked the item)
        // Usually, checkboxes just toggle
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        setLastSelectedIndex(currentIndex);
      }
      return next;
    });
  }, [itemIds, lastSelectedIndex]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setLastSelectedIndex(null);
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(itemIds));
  }, [itemIds]);

  return {
    selectedIds,
    setSelectedIds,
    toggleSelection,
    clearSelection,
    selectAll,
  };
}
