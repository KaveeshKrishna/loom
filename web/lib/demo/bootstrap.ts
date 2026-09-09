/**
 * web/lib/demo/bootstrap.ts
 *
 * Turns the running app into the self-contained public demo. This module
 * only ever exists in the demo build's copy of app/layout.tsx (see
 * loom-demo/build.sh) — production's real layout never imports it, so none
 * of web/lib/demo/ is ever bundled into the real Docker image.
 *
 * Runs its setup as top-level module code (not inside a React
 * component/effect), which JS module evaluation guarantees completes
 * before React starts rendering/hydrating anything — so the fetch/XHR
 * shims are always installed before any component's first data fetch.
 * (`/api/cache/*` and `/api/files/serve*` are handled separately by the
 * Service Worker at public/demo-sw.js, registered here too.)
 *
 * Imported via web/lib/demo/DemoBootstrap.tsx, not directly from
 * swap/root-layout.tsx — that layout is a Server Component (it exports
 * `metadata`), and a Server Component's imports are server-only and never
 * reach the browser. This was shipped broken once already: without that
 * indirection, this file's code never ran client-side at all, so every
 * /api/* call silently fell through to the real network.
 */
import { initState } from "./state";
import { installFetch } from "./mockServer";
import { installUploadShim } from "./mockUpload";

if (typeof window !== "undefined") {
  // The demo defaults to dark theme (rather than the real app's OS-preference
  // default) so first-time visitors get a consistent look starting on the
  // login page. Seeding the same key TopBar.tsx reads means this holds after
  // sign-in too, not just on the pre-auth login page (see swap/root-layout.tsx
  // for the login page's own inline-script version of this default). A
  // visitor who explicitly picks a theme via Settings still overrides this,
  // same as production.
  try {
    if (!localStorage.getItem("loom-theme")) localStorage.setItem("loom-theme", "dark");
  } catch { /* ignore */ }

  initState();
  installFetch();
  installUploadShim();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/demo-sw.js").catch(() => {
      // If registration fails (unsupported browser, blocked, etc.), image/
      // video/download loads simply won't resolve — everything else in the
      // demo still works.
    });
  }

  try {
    document.title = "Loom — Interactive Demo";
  } catch { /* ignore */ }
}
