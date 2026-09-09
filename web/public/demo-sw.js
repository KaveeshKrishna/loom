/**
 * demo-sw.js — Service Worker for the Loom public demo build ONLY.
 *
 * `<img src>`, `<video src>`, and `<a href>` downloads never go through
 * `window.fetch` — they're native browser resource loads, which the page's
 * fetch monkeypatch (web/lib/demo/mockServer.ts) can never see. A Service
 * Worker is the only mechanism that can intercept those too, so this file
 * exists purely to answer two URL shapes with real bundled placeholder
 * media, entirely from the browser:
 *
 *   GET /api/cache/<cachePath>            -> a real generated photo/clip
 *   GET /api/files/serve?path=<relPath>   -> a real generated photo/clip,
 *                                            or synthesized text for docs
 *
 * This file is deliberately plain, dependency-free JS (Service Workers
 * can't easily import the rest of web/lib/demo/'s TypeScript modules
 * without a separate bundling step) — so the tiny deterministic
 * photo/video picker below is a DELIBERATE, minimal duplicate of
 * web/lib/demo/assets.ts's pickPhotoAsset/pickVideoAsset. If you change
 * PHOTO_COUNT/VIDEO_COUNT or the hash function in one place, update the
 * other.
 *
 * No real backend is contacted anywhere in this file — the demo build has
 * none.
 */

const PHOTO_COUNT = 15;
const VIDEO_COUNT = 4;

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function pickPhotoAsset(seed) {
  return "photo-" + String((hashStr(seed) % PHOTO_COUNT) + 1).padStart(2, "0") + ".jpg";
}
function pickVideoAsset(seed) {
  return "clip-" + String((hashStr(seed) % VIDEO_COUNT) + 1).padStart(2, "0") + ".mp4";
}

const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "heic", "avif"];
const VIDEO_EXTS = ["mp4", "mov", "mkv", "webm", "avi", "m4v"];

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Take control of already-open tabs (the login page) immediately, rather
  // than waiting for the next full navigation.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // never touch cross-origin requests

  if (url.pathname.startsWith("/api/cache/")) {
    event.respondWith(handleCache(url));
    return;
  }
  if (url.pathname === "/api/files/serve") {
    event.respondWith(handleServe(url));
    return;
  }
  // Everything else (JS/CSS chunks, /demo-assets/*, fonts) — let the
  // browser handle it exactly as if this Service Worker didn't exist.
});

async function handleCache(url) {
  const cachePath = decodeURIComponent(url.pathname.slice("/api/cache/".length));
  const dir = cachePath.startsWith("clip-") ? "videos" : "photos";
  const real = await fetch(`/demo-assets/${dir}/${cachePath}`);
  return real.ok ? real : notFound();
}

async function handleServe(url) {
  const relPath = url.searchParams.get("path") || "";
  const download = url.searchParams.get("download") === "1";
  const fileName = relPath.split("/").pop() || "file";
  const ext = extOf(fileName);

  let response;
  if (IMAGE_EXTS.includes(ext)) {
    response = await fetch(`/demo-assets/photos/${pickPhotoAsset(relPath)}`);
  } else if (VIDEO_EXTS.includes(ext)) {
    response = await fetch(`/demo-assets/videos/${pickVideoAsset(relPath)}`);
  } else {
    const text = `This is fabricated demo content for "${fileName}".\n\nLoom's public demo has no real backend — every file you see is invented, and this text is generated on the fly rather than read from a real document.`;
    response = new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  if (!response.ok) return notFound();

  if (download) {
    const buf = await response.arrayBuffer();
    const headers = new Headers(response.headers);
    headers.set("Content-Disposition", `attachment; filename="${fileName.replace(/"/g, "")}"`);
    return new Response(buf, { status: 200, headers });
  }
  return response;
}

function notFound() {
  return new Response("Not found", { status: 404 });
}
