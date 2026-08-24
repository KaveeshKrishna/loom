# Loom Project Context

## Last Updated
2026-08-25 (Session 14 — continued)

## Session 14 — Context Menus and Folder Sizes

### Dynamic Folder Size
- **New API:** `/api/files/size` uses `prisma.fileNode.aggregate` to quickly sum file sizes under a directory using a lightweight PostgreSQL query (`SUM(size)`). This completely avoids reading from the idle SSD.
- **Note on Behavior:** Because it strictly uses the DB, the folder sizes will only include new files (added manually via another machine) after the user runs a manual **Rescan** from the dashboard. This was an explicit architectural decision to preserve the idle SSD state.
- **New Component:** `<FolderSize />` asynchronously fetches the folder size without blocking page rendering, showing a subtle `...` loading state. Integrated into both `FileList` and `FileGrid`.

### Windows-Style Context Menus
- **New Hook & Component:** Added `useContextMenu` and `<ContextMenu />`. The menu renders via a React Portal and calculates boundaries to ensure it never overflows the screen (flips upwards/leftwards as needed).
- **Interactions:** Triggers on right-click (desktop) and long-press (mobile). Also triggers when clicking the 3-dots menu on folders.
- **Unified Action Menu:** Individual Star and Download buttons have been removed from List and Grid views. All file and folder actions are now unified under a single 3-dots context menu button in `FileList`, `FileGrid`, and `Sidebar` (pinned folders). This guarantees consistent behavior across all devices and input methods.

## Session 12 — Page Unification, Loading Skeletons & Video Buffering Fix

### Loading Skeletons
- **New file:** `web/components/files/FileSkeletons.tsx` — exports `FileGridSkeleton` and `FileListSkeleton`.
- Skeleton cards/rows use a `shimmer` CSS keyframe animation (added to `globals.css`) that sweeps a highlight across the placeholder shapes.
- `FileGridSkeleton` uses the exact same responsive grid column breakpoints as `FileGrid` and reads `gridSize` from `TopBarContext`.
- `FileListSkeleton` mimics the list header + row layout with staggered shimmer delays.

### Category Pages Unified (Photos, Videos, Documents)
All three pages now behave identically to `files/[...path]/page.tsx`:
- **Removed** the custom static header (`<div className="px-6 py-5 border-b">`) — pages now look exactly like the home file explorer.
- **Added** `favoriteIds` state + `toggleFavorite` handler → star button now works in all views on these pages.
- **Added** `showPath` prop → file path shown under the filename (since all files from across the library are mixed).
- **Fixed sibling timeline:** `buildSiblings()` now correctly maps `preview?.cachePath ?? thumbnail?.cachePath` so video poster frames appear in the timeline.
- **Fixed Documents breadcrumb bug:** `documents/page.tsx` was missing the `setBreadcrumbs` call, causing the top bar/search bar to stay on the previous page's state. Fixed by adding `setBreadcrumbs([{ label: "Documents", href: "/documents" }])` on mount.

### Home File Explorer — Search Timeline Fix
- `files/[...path]/page.tsx`: `navigate()` now builds siblings from `displayNodes` (the active search results list) instead of always using raw `nodes`. This means opening a file while searching populates the bottom timeline with the other search results.
- `onNavigateTo` now looks up the full node in both `nodes` and `searchNodes` so navigation across search results works.

### Video Buffering Overlay
- `MediaViewer.tsx`: Extracted native `<video>` into a `NativeVideoPlayer` component with a `buffering` state.
- `onWaiting` → shows spinner overlay; `onPlaying`/`onCanPlay` → hides it.
- `HlsPlayer` also gains the same `onWaiting`/`onPlaying`/`onCanPlay` handlers and shows the overlay.
- Both players share a `BufferingOverlay` component — semi-transparent black with `backdrop-blur` + spinner + label text.

### Build Status
- ✅ `docker compose build loom-web` — exit code 0 (Session 13, 2026-08-25)
- ✅ `docker compose up -d loom-web` — healthy

### Performance Optimizations (2026-08-25)
- **Universal Loading Optimization:** Large directories (e.g., Photos with 5k+ images) were causing main thread jank and blocked navigation.
- Added cursor-based pagination and `useInfiniteNodes` hook with `IntersectionObserver` to batch load items 100 at a time on `photos/page.tsx`, `videos/page.tsx`, `documents/page.tsx`, and `favorites/page.tsx`.
- Integrated `AbortController` universally to all API fetch calls (`files/[...path]/page.tsx`, `recent/page.tsx`, etc.) to instantly cancel pending requests on unmount, allowing snappy navigation.
- Enabled `decoding="async"` for image thumbnails in `FileGrid` to move decoding off the main thread.



## Session 10 Fix — Video Thumbnails Not Showing in FileGrid
**Root Cause:** The scanner stores video poster frames in the **`previews` DB table** (path: `previews/video-{id}_{version}.webp`), NOT in the `thumbnails` table. `FileGrid.tsx` was only checking `node.thumbnail` (always `null` for videos), so it fell back to showing a file icon instead of the poster.

**Fix:** Updated `FileGrid.tsx` line ~103 to check `node.thumbnail || node.preview` and use `node.preview?.cachePath ?? node.thumbnail?.cachePath` as the image src. This matches the pattern already used on every other page (`videos/`, `favorites/`, `recent/`, etc.).

**File changed:** `web/components/files/FileGrid.tsx` — one-line logic fix, rebuilt + redeployed.

## Session 10 Feature — Thumbnail Cache Reset Button
**Added to Settings → Scanner panel:**
- New card "Thumbnail & Preview Cache" shows DB record counts + physical file count
- **Reset Cache** button (`DELETE /api/thumbnail-cache`) does:
  1. Deletes all `thumbnails` + `previews` DB records
  2. Wipes all files in `/cache/thumbnails/` and `/cache/previews/` (incl. `.failed` sentinels)
  3. Resets `sourceVersion = null` on all `FileNode` rows → scanner regenerates everything
  4. Automatically queues a fresh `FULL_RESCAN` after clearing

**New file:** `web/app/api/thumbnail-cache/route.ts` — GET (stats) + DELETE (full reset). Owner only.
**Modified:** `web/components/settings/ScanPanel.tsx` — added new card + state + handler.

## Architecture Summary
- **Stack**: Next.js 15 + Prisma + PostgreSQL, Docker Compose
- **Services**: `loom-web`, `loom-scanner`, `postgres`
- **Build**: `docker compose build loom-web loom-scanner`

## Key Files
- `web/components/layout/MainShell.tsx` — Root layout shell, wraps TopBarProvider with userEmail
- `web/components/layout/TopBarContext.tsx` — Global state: viewMode, gridSize, pins, breadcrumbs, searchQuery, searchGlobal
- `web/components/layout/TopBar.tsx` — Top navigation bar with search, breadcrumbs, view toggles, grid-size dropdown
- `web/components/layout/Sidebar.tsx` — Sidebar with nav items, pinned folders (from context), 3-dots unpin menu on hover
- `web/components/files/FileGrid.tsx` — Grid view, uses gridSize from TopBarContext for dynamic columns
- `web/components/files/FileList.tsx` — List view
- `web/components/files/FolderMenu.tsx` — 3-dots menu on folder hover, shows Pin/Unpin using context
- `web/lib/video-compat.ts` — ffprobe codec detection + MIME/codec compatibility classification
- `web/lib/hls-manager.ts` — Full HLS generation engine: job deduplication, activity-based lifecycle, atomic finalization
- `web/app/api/files/hls/[fileNodeId]/route.ts` — Probe endpoint
- `web/app/api/files/hls/[fileNodeId]/[...segments]/route.ts` — Manifest + segment serving
- `web/app/api/video-cache/route.ts` — Cache stats + clear (Owner only)
- `scanner/src/index.ts` — Scanner with sourceVersion reconciliation + orphan GC
- `web/scripts/migrate-derived-media.ts` — One-time migration script for legacy sha256 cache files

## Known Patterns
- All localStorage keys are user-scoped: `loom-pins-{userEmail}`, `loom-grid-size-{userEmail}`, `loom-theme`
- IDE shows false-positive TS errors (`JSX intrinsic elements`, `no declaration file for react`, `videoCache does not exist`, `sourceVersion does not exist on FileNode`, `Cannot find module 'fs'`) — these are tsconfig path alias + stale Prisma client issues in the IDE, do NOT affect build
- Real build errors to watch: `no-unused-vars`, `react-hooks/rules-of-hooks`
- `useTopBar()` hook must always be called BEFORE any early returns in components
- Project uses `prisma db push` (no migrations directory) — schema is pushed directly to DB
- `file_nodes` table has both `sourceVersion` and `browserCompatible` columns — confirmed via `information_schema.columns`

## Implemented Features (Sessions 1-3)
1. **Sidebar toggle button** — Fixed to stay on the border of the sidebar panel
2. **Search clear button** — Magnifying glass becomes X when text is present
3. **Removed Recent tab** from sidebar
4. **Pinned Folders** — Unified via `TopBarContext`, persisted to `localStorage` keyed by `userEmail`
5. **Grid view fixed** on Documents page — conditionally renders FileGrid or FileList based on viewMode
6. **Grid size dropdown** in TopBar — Small / Medium / Large, persisted to localStorage per user
7. **View toggle buttons** (grid/list) now visible on mobile
8. **Breadcrumb nav** — CSS scroll (`overflow-x-auto`), no hard item count limit

## Implemented Features (Sessions 4-5)
9. **Options Menu Visibility** — 3-dots always visible in main content area, hover-only in sidebar
10. **Context Menus** — Right-click / long-press on folder opens its dropdown
11. **Grid View Dropdown Fix** — Removed `overflow-hidden` from view toggle button container
12. **Folder Menu Pin Bubbling** — `e.stopPropagation()` on Pin click
13. **Mobile FileGrid Layout** — sm=4 cols, md=3 cols, lg=2 cols, xl=1 col
14. **Mobile TopBar View Toggle** — View toggles inside user dropdown on mobile
15. **Breadcrumb Truncation & Spacing** — Long folder names truncated to 15 chars
16. **Sidebar Mobile Overlay Z-Index** — `z-[60]` to layer over search bar
17. **Long Press Fix** — `useRef` for timer, `longPressFiredRef` to prevent click-after-longpress
18. **HEVC/MOV Video Fix** — `/api/files/transcode` endpoint, ffmpeg in Dockerfile, MediaViewer probes codec

## Implemented Features (Session 6) — Video Streaming V2 & Derived Media Reconciliation
57. **Region-Based HLS Streaming** — Incompatible videos (HEVC, MOV, MKV, AVI, MPEG etc.) served via demand-driven, region-based fMP4 HLS.
    - Synthesized full VOD manifest from ffprobe duration → instant full-timeline display
    - FFmpeg invoked only for requested regions; seeks directly to the needed segment offset
    - Job deduplication: 3 concurrent seeks to same region → 1 FFmpeg process
    - Activity-based lifecycle: 30s idle → SIGTERM; completed segments preserved
    - Atomic `.m4s.tmp → .m4s` rename ensures crash safety
    - Bounded wait: 30s timeout → HTTP 503 Retry-After: 2 (hls.js natively retries)
58. **Universal Derived Media Reconciliation** — `sourceVersion = "${size}-${mtimeMs}"` is the identity for all derived media. Rescan preserves unchanged files and only regenerates when content actually changed.
59. **Migration Script** — `web/scripts/migrate-derived-media.ts` — run once to migrate existing sha256-keyed cache files to `{fileNodeId}_{sourceVersion}` format.
60. **Schema** — `FileNode.sourceVersion`, `FileNode.browserCompatible`, `VideoCache.@@unique([fileNodeId, sourceVersion])`, `Thumbnail.sourceVersion`, `Preview.sourceVersion`.
61. **MediaViewer HLS Player** — Probe → native HTTP Range serve OR `hls.js` HLS. "Preparing video…" overlay. Safari native HLS fallback.
62. **ScanPanel Video Cache Stats** — HLS cache usage (GB / 20 GB limit, count) + "Clear Cache" button.

## Implemented Features (Session 7) — Video Thumbnail & HLS Permission Fixes
63. **Video Thumbnail FFmpeg Fix** — Fixed ffmpeg exit code 183 during `spawn` in scanner by avoiding quotes in the `-vf` filter argument (`scale=w=320:h=320:force_original_aspect_ratio=decrease`).
64. **HLS Cache Permissions** — `loom-scanner` (root) previously created `/cache/videos` which prevented `loom-web` (node user) from generating HLS segments. Chowned directory to `1000:1000`.
65. **Scanner Prisma Client Sync** — Fixed an issue where the scanner was built with a stale `prisma/schema.prisma` file, causing TypeScript errors. Copied `web/prisma/schema.prisma` to `scanner/prisma/schema.prisma` before building.

## Implemented Features (Session 8) — HLS Root Cause Investigation & Fixes
66. **DB Column Confirmed** — Verified `sourceVersion` and `browserCompatible` columns exist in `file_nodes` via `information_schema.columns`. IDE lint errors were false-positives.
67. **Scanner sourceVersion Backfill Bug Found & Fixed** — The scanner's FULL_RESCAN path (line 379) only used `existing.sourceVersion ?? newSourceVersion` as a local variable for media validation — it never **wrote** it back to the `file_nodes` table for unchanged files. Fixed by adding a `prisma.fileNode.update()` when `sourceVersion` is NULL.
68. **SQL Backfill Applied** — Ran `UPDATE file_nodes SET "sourceVersion" = size::text || '-' || EXTRACT(EPOCH FROM "modifiedAt")::bigint * 1000` directly in Postgres to backfill all 6810 file_nodes immediately. All 6549 files now have sourceVersion.
69. **BigInt Serialization Bug Fixed (segments route)** — `[...segments]/route.ts` line 57 still had `${fileNode.size}` (gives `"37128553n"`). Fixed to `${fileNode.size?.toString()}`. Probe route already had this fix.
70. **Comprehensive HLS Logging Added** — Added `[HLS-seg]` step logs to `[...segments]/route.ts` and `[HLS]` logs to `hls-manager.ts` (FFmpeg spawn args, segment finalization, ensureGeneration lifecycle). FFmpeg stderr is piped to console (error-level lines only).
71. **SEGMENT_WAIT_MS increased 8s → 30s** — Heavy source files (HEVC/MOV/MKV/MPEG) take longer than 8s for first segment.
72. **init.mp4 wait timeout increased 8s → 15s** — Same rationale as above.
73. **ensureGeneration try/catch** — Wrapped `ensureGeneration()` calls in try/catch to surface errors as 500 instead of silent 503.

## Implemented Features (Session 9) — Missing Thumbnail Generation Fix
74. **Scanner Thumbnail Regeneration Fix** — Re-enabled thumbnail and preview regeneration for missing components in unchanged files. Added a `forceRetryFailed` flag to generation functions that ignores and removes stale `.failed` sentinels (which were previously blocking the rebuild of missing components).

## Build Status
- ✅ `docker compose build loom-web loom-scanner` — exit code 0 (Session 9, 2026-08-24)
- ✅ `docker compose up -d loom-web loom-scanner` — both healthy
- ✅ `sourceVersion` backfilled in DB for all 6810 file_nodes
- 🔄 **Manual acceptance test required**: Open browser, trigger video playback, watch `docker compose logs -f loom-web` for `[HLS-seg]` and `[HLS]` log lines.

## Known Corrupt Files (Scanner Warnings — Expected)
- `_1102011.MP4` — moov atom not found (truncated file)
- `_00_0549.mov` — actually an MP3 file with `.mov` extension (audio only, no video stream)
- `_00_0556.mov` — moov atom not found (truncated file)
- These are legitimately broken source files, `.failed` sentinels are correct behavior.

## Implemented Features (Session 11) — HLS Caching Fast-Path Fix
106. **HLS Premature Caching Fix** — Replaced manual custom rename loop in `hls-manager.ts` with FFmpeg's native `-hls_flags temp_file`. Previously, `renameWatcher` was renaming `.tmp` segments to their final names *while FFmpeg was still writing to them*. This caused `isSegmentValid` to return true prematurely, causing the backend to serve truncated chunks (e.g. 32KB) with a full `Content-Length` and a 1-year browser cache policy.
107. **Infinite Loop Resolved** — hls.js was receiving these truncated segments, hitting a `MEDIA_ERROR` while parsing incomplete fmp4 boxes, dropping the buffer, and retrying. Because the browser heavily cached the truncated 32KB response, it repeatedly served it from disk cache, causing an endless `segment_000 -> segment_001 -> MEDIA_ERROR -> segment_000` loop without ever hitting the server again. With native `temp_file`, FFmpeg atomically renames the segment only when it is 100% complete, preventing premature cache hits.

**To resolve caching issues in development**: Users experiencing the infinite loop need to clear their browser cache or perform a hard refresh, as their browser has aggressively cached the corrupt, truncated segments from prior sessions.

## Session 13 — MediaViewer Timeline Mismatch Bug Fix
108. **Sorting logic lifted to Page components** — Lifted `sortNodes` utility into `web/lib/utils.ts`. 
109. **FileGrid and FileList stripped of internal sorting** — Removed internal alphabetical sort from `FileGrid.tsx` and `FileList.tsx`.
110. **Consistent Sorting State for MediaViewer** — `files`, `photos`, `videos`, `documents`, and `favorites` pages now sort items *before* sending to the Grid/List and passing them into the `siblings` array for `MediaViewer`. This ensures the timeline matches the visual Grid exactly.
111. **Recent Page Chronological Sorting fix** — Fixed a bug where `recent/page.tsx` was unintentionally alphabetically sorted; it now strictly maintains backend descending chronological order.
