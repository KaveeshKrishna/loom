# MediaViewer Timeline Mismatch Bug

## Problem Statement
When a user opens a file (image, video, etc.) in the `MediaViewer`, the sibling timeline at the bottom is often out of sync with the visual order of the files in the folder (Grid/List view).
For example, clicking the *first* file in a folder might highlight an item in the middle of the timeline, and the surrounding files in the timeline do not match the surrounding files in the folder view.

## Root Cause
The root cause is a **sorting mismatch** between what is rendered in `FileGrid`/`FileList` and what is passed to `MediaViewer` as `siblings`.

1. **Grid/List Internal Sorting:**
   Both `web/components/files/FileGrid.tsx` and `web/components/files/FileList.tsx` independently sort the `nodes` prop they receive before rendering:
   ```typescript
   const sorted = [...nodes].sort((a, b) => {
     if (a.type === b.type) return a.name.localeCompare(b.name);
     return a.type === "DIRECTORY" ? -1 : 1;
   });
   ```
   So the user *always* sees files sorted by Directories first, then alphabetically by name.

2. **Siblings Array is Unsorted:**
   In the page components (e.g., `photos/page.tsx`, `videos/page.tsx`, `files/[...path]/page.tsx`), the `onNavigate` callback builds the `siblings` array from the *raw* `filteredNodes` or `displayNodes` arrays, which are NOT sorted alphabetically. 
   - For `/api/files/type` (used by Photos, Videos, Docs), the backend returns files sorted by `updatedAt desc`.
   - For `/api/files` (used by Home), the backend might return them in whatever order the DB yields or its own internal sort.

When `setViewer({ node, siblings })` is called, `MediaViewer` receives the unsorted (or differently sorted) `siblings` array. Thus, the index of the opened `node` in the `siblings` array is completely different from its visual index in the Grid/List, breaking the user's mental model of "next" and "previous".

## Recommended Fix

**Lift the sorting logic out of the Grid/List components and into the page components.**

1. Create a shared utility function in `web/lib/utils.ts`:
   ```typescript
   export function sortNodes<T extends { type: string; name: string }>(nodes: T[]): T[] {
     return [...nodes].sort((a, b) => {
       if (a.type === b.type) return a.name.localeCompare(b.name);
       return a.type === "DIRECTORY" ? -1 : 1;
     });
   }
   ```
2. Remove the internal sorting from `FileGrid.tsx` and `FileList.tsx`. They should just map over the `nodes` prop directly.
3. In `files/[...path]/page.tsx`, `photos/page.tsx`, `videos/page.tsx`, and `documents/page.tsx`, sort the nodes *before* rendering the Grid/List AND before building the `siblings` array:
   ```typescript
   // Example for Category Pages:
   const sortedFilteredNodes = useMemo(() => sortNodes(filteredNodes), [filteredNodes]);

   // Render:
   <FileGrid nodes={sortedFilteredNodes} ... />

   // onNavigate:
   const navigate = useCallback((node) => {
     const siblings = buildSiblings(sortedFilteredNodes);
     setViewer({ node, siblings });
   }, [sortedFilteredNodes]);
   ```
4. This guarantees that the order of items on the screen (Grid/List) perfectly matches the order of items in the `MediaViewer` timeline.
