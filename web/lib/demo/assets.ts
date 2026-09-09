/**
 * web/lib/demo/assets.ts
 *
 * Deterministic mapping from a fabricated file's identity to one of a small
 * pool of real, generated placeholder media files (see
 * scripts/generate-demo-assets.ts, output in web/public/demo-assets/).
 *
 * This same picking logic is duplicated (deliberately kept tiny and simple
 * to minimize drift risk) in web/public/demo-sw.js, which resolves
 * `/api/cache/*` and `/api/files/serve*` requests — those are native
 * <img>/<video>/<a> resource loads, which never go through `window.fetch`
 * at all, so they can't be handled by mockServer.ts's fetch patch. If you
 * change PHOTO_COUNT/VIDEO_COUNT or the hash function here, update
 * demo-sw.js's copy too.
 */

export const PHOTO_COUNT = 15;
export const VIDEO_COUNT = 4;

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Given any stable seed string (a relativePath works well), pick a pool photo filename. */
export function pickPhotoAsset(seed: string): string {
  const n = (hashStr(seed) % PHOTO_COUNT) + 1;
  return `photo-${String(n).padStart(2, "0")}.jpg`;
}

/** Given any stable seed string, pick a pool video filename. */
export function pickVideoAsset(seed: string): string {
  const n = (hashStr(seed) % VIDEO_COUNT) + 1;
  return `clip-${String(n).padStart(2, "0")}.mp4`;
}
