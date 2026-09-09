/**
 * DEMO BUILD ONLY.
 *
 * web/app/(main)/files/[...path]/page.tsx is `"use client"` (it fetches
 * everything client-side already, matching every other page under
 * (main)/). A static export needs every dynamic catch-all route to export
 * `generateStaticParams()` — but that export is only valid from a Server
 * Component module, and can't be added to a "use client" file.
 *
 * So for the demo build only, loom-demo/build.sh renames the real file
 * aside to FilesPageInner.tsx (completely unchanged — same component, same
 * logic, no demo-specific edits) and drops this file in as the new
 * page.tsx: a thin Server Component wrapper that satisfies the static
 * export requirement and just renders the real client component.
 *
 * `[...path]` is a REQUIRED catch-all (at least one segment), and a static
 * export refuses to build a dynamic route with zero generated params at
 * all — it needs at least one concrete example. Which one doesn't matter:
 * FilesPageInner never uses server-provided params, it's a "use client"
 * component that reads the REAL browser URL via useParams()/usePathname()
 * and fetches accordingly, so every param value (real or not) produces an
 * identical generic shell that hydrates into the correct folder view for
 * whatever path was actually visited. So this is a single throwaway value,
 * not an attempt to enumerate real folders.
 *
 * Real folder navigation happens by clicking through from the already
 * statically-generated `/files` shell (app/(main)/files/page.tsx, which
 * imports and renders this same default export) — Next's client-side
 * router handles that entirely in-page, no new document load or export
 * lookup involved. A hard refresh or shared link straight to a deep folder
 * path falls back to the root shell via Caddy's SPA fallback (see
 * loom-demo/Caddyfile.snippet), landing on the top-level file list rather
 * than that exact folder — acceptable for a demo.
 */
import FilesPageInner from "./FilesPageInner";

export function generateStaticParams() {
  return [{ path: ["_"] }];
}

export default function FilesPage() {
  return <FilesPageInner />;
}
