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
 */
import { initState } from "./state";
import { installFetch } from "./mockServer";
import { installUploadShim } from "./mockUpload";

if (typeof window !== "undefined") {
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
