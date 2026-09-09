/**
 * web/lib/demo/generate-assets.ts
 *
 * Generates the pool of placeholder photos used by the public demo build
 * (see web/lib/demo/assets.ts for the pool size / picking logic, and
 * web/public/demo-sw.js for how they're served). Run once by
 * loom-demo/build.sh before `next build`; output is committed to the repo
 * under web/public/demo-assets/photos/ (small, deterministic, so a fresh
 * clone can build the demo without regenerating anything, but re-running
 * this is fine and safe).
 *
 * Deliberately generated rather than sourced from stock photos — zero
 * licensing questions, zero internet dependency, fully reproducible.
 *
 * Video placeholders (web/public/demo-assets/videos/) are generated
 * separately by loom-demo/build.sh via ffmpeg in a throwaway container,
 * since ffmpeg isn't a Node dependency and ties up sharp/Node for nothing.
 *
 * Usage: npx tsx lib/demo/generate-assets.ts   (run from web/)
 */
import sharp from "sharp";
import { mkdir } from "fs/promises";
import { join } from "path";
import { PHOTO_COUNT } from "./assets";

const OUT_DIR = join(__dirname, "..", "..", "public", "demo-assets", "photos");

const PALETTES: [string, string][] = [
  ["#f97316", "#fb923c"], ["#0ea5e9", "#38bdf8"], ["#22c55e", "#4ade80"],
  ["#a855f7", "#c084fc"], ["#ec4899", "#f472b6"], ["#eab308", "#facc15"],
  ["#14b8a6", "#2dd4bf"], ["#ef4444", "#f87171"], ["#6366f1", "#818cf8"],
  ["#84cc16", "#a3e635"], ["#06b6d4", "#22d3ee"], ["#f43f5e", "#fb7185"],
  ["#8b5cf6", "#a78bfa"], ["#10b981", "#34d399"], ["#f59e0b", "#fbbf24"],
];

// No text is baked into the images — the UI already shows each fabricated
// file's real (invented) filename next to its thumbnail, exactly like real
// photos never have their filename printed across the pixels either. This
// also sidesteps needing a working fontconfig/font stack on the machine
// running this script, which isn't guaranteed.

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  for (let i = 0; i < PHOTO_COUNT; i++) {
    const num = String(i + 1).padStart(2, "0");
    const [c1, c2] = PALETTES[i % PALETTES.length];
    const angle = (i * 47) % 360;

    const svg = `
      <svg width="960" height="720" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%" gradientTransform="rotate(${angle} 0.5 0.5)">
            <stop offset="0%" stop-color="${c1}"/>
            <stop offset="100%" stop-color="${c2}"/>
          </linearGradient>
        </defs>
        <rect width="960" height="720" fill="url(#g)"/>
        <circle cx="${180 + (i * 53) % 700}" cy="${120 + (i * 37) % 480}" r="${90 + (i * 13) % 60}" fill="rgba(255,255,255,0.14)"/>
        <circle cx="${820 - (i * 41) % 600}" cy="${600 - (i * 29) % 400}" r="${60 + (i * 17) % 80}" fill="rgba(255,255,255,0.10)"/>
      </svg>`;

    await sharp(Buffer.from(svg))
      .jpeg({ quality: 82 })
      .toFile(join(OUT_DIR, `photo-${num}.jpg`));
  }

  console.log(`Generated ${PHOTO_COUNT} placeholder photos in ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
