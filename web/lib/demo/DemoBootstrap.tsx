"use client";

/**
 * Thin client-component wrapper around bootstrap.ts's top-level install
 * logic.
 *
 * web/lib/demo/swap/root-layout.tsx (which replaces the real root layout at
 * demo-build time) has to stay a Server Component so it can export
 * `metadata` — but that means anything it imports directly is treated as
 * server-only code and excluded from the client JS bundle entirely (this
 * was a real, shipped bug: bootstrap.ts's fetch/XHR shims and Service
 * Worker registration never ran in the browser, so every /api/* call fell
 * through to the real network, hit Caddy's static-file fallback, and
 * "succeeded" with an HTML response the app couldn't parse as JSON — empty
 * file listings, a dead Scan Now button, everything).
 *
 * Rendering this component from that Server Component is what actually
 * gets bootstrap.ts's module (and its top-level side effects) shipped to
 * and evaluated in the browser, before hydration — the same guarantee a
 * bare top-level import gives a client-component tree, just routed through
 * one.
 */
import "./bootstrap";

export function DemoBootstrap() {
  return null;
}
