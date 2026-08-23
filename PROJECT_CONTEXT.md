# Loom Project Context

## Last Updated
2026-08-23 (Session 3)

## Architecture Summary
- **Stack**: Next.js 15 + Prisma + PostgreSQL, Docker Compose
- **Services**: `loom-web`, `loom-scanner`, `postgres`
- **Build**: `docker compose build loom-web`

## Key Files
- `web/components/layout/MainShell.tsx` — Root layout shell, wraps TopBarProvider with userEmail
- `web/components/layout/TopBarContext.tsx` — Global state: viewMode, gridSize, pins, breadcrumbs, searchQuery, searchGlobal
- `web/components/layout/TopBar.tsx` — Top navigation bar with search, breadcrumbs, view toggles, grid-size dropdown
- `web/components/layout/Sidebar.tsx` — Sidebar with nav items, pinned folders (from context), 3-dots unpin menu on hover
- `web/components/files/FileGrid.tsx` — Grid view, uses gridSize from TopBarContext for dynamic columns
- `web/components/files/FileList.tsx` — List view
- `web/components/files/FolderMenu.tsx` — 3-dots menu on folder hover, shows Pin/Unpin using context

## Implemented Features (Session 1-3)
1. **Sidebar toggle button** — Fixed to stay on the border of the sidebar panel in both collapsed and expanded states
2. **Search clear button** — Magnifying glass becomes X when text is present to clear search
3. **Removed Recent tab** from sidebar
4. **Pinned Folders** — Unified via `TopBarContext` (pins array + togglePin), persisted to `localStorage` keyed by `userEmail`
   - FolderMenu shows **Pin/Unpin** text based on current state
   - Sidebar pinned items show 3-dots button on hover → Unpin action
5. **Grid view fixed** on Documents page — now conditionally renders FileGrid or FileList based on viewMode
6. **Grid size dropdown** in TopBar — Small / Medium / Large, persisted to localStorage per user
7. **View toggle buttons** (grid/list) now visible on mobile (removed `hidden sm:flex` class)
8. **Breadcrumb nav** — Now uses CSS scroll (`overflow-x-auto`) up to `max-w-[70vw]`, no hard item count limit, grows with screen width

## Known Patterns
- All localStorage keys are user-scoped: `loom-pins-{userEmail}`, `loom-grid-size-{userEmail}`, `loom-theme`
- IDE shows false-positive TS errors (`JSX intrinsic elements`, `no declaration file for react`) — these are tsconfig path alias issues, do NOT affect build
- Real build errors to watch: `no-unused-vars`, `react-hooks/rules-of-hooks`
- `useTopBar()` hook must always be called BEFORE any early returns in components

## Recent Build Fixes (Session 3)
- Moved `useTopBar()` call in FileGrid.tsx before the early empty-state return
- Removed stray `</div>` from Sidebar.tsx footer
- Replaced `React.MouseEvent` with `MouseEvent` (imported from react) in FolderMenu.tsx
- Fixed `useState` misuse as init side-effect → replaced with `useEffect` in TopBarContext.tsx
- Prefixed unused `pin` parameter with `_` in `SidebarPinMenu`
- Added `no-scrollbar` and `mask-gradient-right` CSS utilities to `globals.css`

## Implemented Features (Session 4)
9. **Options Menu Visibility** — The 3-dots folder menu is now always visible in the main content area (grid/list views), but remains hover-only in the sidebar.
10. **Context Menus** — Right-clicking or long-pressing on any folder (in main views or sidebar) now triggers its respective 3-dots dropdown menu using `onContextMenu` and touch events.
11. **Grid View Dropdown Fix** — Removed `overflow-hidden` from the view toggle button container in `TopBar.tsx`, which was clipping the grid size dropdown.

## Implemented Features (Session 5)
12. **Folder Menu Pin Bubbling** — Added `e.stopPropagation()` when clicking "Pin" in `FolderMenu.tsx` so it does not inadvertently open the folder.
13. **Mobile FileGrid Layout** — Adjusted mobile grid sizes: sm=4 cols, md=3 cols, lg=2 cols, xl=1 col.
14. **Mobile TopBar View Toggle** — Hidden the Grid/List view toggles in the header on mobile and added them inside the user dropdown, directly above Theme toggles. Also added a grid size selector (SM, MD, LG, XL) inside the dropdown on mobile.
15. **Breadcrumb Truncation & Spacing** — Long folder names in breadcrumbs are truncated to 15 characters. Removed max-width constraints on the breadcrumb nav so it flexibly uses all remaining top-bar space on desktop.
16. **Sidebar Mobile Overlay Z-Index** — Adjusted the mobile sidebar z-index in `Sidebar.tsx` and the mobile overlay wrapper in `MainShell.tsx` to `z-[60]` so that it correctly layers *over* the floating mobile search bar (`z-50`).
17. **Long Press Fix** — Fixed long press on mobile in `FileGrid.tsx`, `FileList.tsx`, and `Sidebar.tsx`. The old `let touchTimer` variable was reset on each render. Replaced with `useRef` for the timer and a `longPressFiredRef` flag to (a) prevent the `onClick` from navigating after a long press and (b) call `e.preventDefault()` in `onTouchEnd` to suppress the OS synthetic tap that was immediately closing the menu.
18. **HEVC/MOV Video Fix** — Added ffmpeg to Dockerfile. Created `/api/files/transcode` endpoint that (HEAD) probes codec via ffprobe and (GET) streams H.264/AAC transcoded MP4. `MediaViewer.tsx` now does a browser HEVC support check first; if unsupported, it probes the file and switches to the transcode stream for HEVC files (.MOV from iPhone, some .mp4). H.264 files continue to use the direct serve endpoint.
- Fixed an issue where long pressing on folders in the main content area and side panel caused the context menu to appear and immediately disappear. This was due to double-firing from custom touch timers and native `contextmenu` events on mobile browsers, as well as synthetic `mousedown` events on `touchend`. Resolved by making the open dispatch idempotent via CustomEvents and using `pointerdown` for outside click detection.
- Added active scale and color transitions to buttons and list items across FileGrid, FileList, and Sidebar for immediate visual feedback on touch/click.
- Resolved a bug where long-pressing pinned sidebar items on mobile incorrectly navigated and closed the sidebar instead of opening the context menu.
- Adjusted the SidebarPinMenu 3-dots icon to be visible on touch devices (mobile and tablet) rather than relying exclusively on group-hover, which doesn't exist on touch.
