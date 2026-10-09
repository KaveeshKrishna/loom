// Renders the app icon (Loom's mark: a blue rounded square with a white L)
// to the PNGs and the multi-size .ico Tauri needs.
//   node scripts/icons.mjs   (needs the "sharp" package; SHARP=/path/to/sharp)
import fs from "node:fs";
import { createRequire } from "node:module";
const sharp = createRequire(import.meta.url)(process.env.SHARP || "sharp");

const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2F7BFF"/><stop offset="1" stop-color="#1A5FE6"/></linearGradient></defs>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#g)"/>
  <path d="M92 64h30v100h52v28H92z" fill="#fff"/>
</svg>`;

const out = "src-tauri/icons";
fs.mkdirSync(out, { recursive: true });
const png = (size) => sharp(Buffer.from(svg(size))).png().toBuffer();
fs.writeFileSync(`${out}/32x32.png`, await png(32));
fs.writeFileSync(`${out}/128x128.png`, await png(128));
fs.writeFileSync(`${out}/128x128@2x.png`, await png(256));
fs.writeFileSync(`${out}/icon.png`, await png(512));

// .ico: a header, one directory entry per size, then the PNGs.
const sizes = [16, 20, 24, 32, 40, 48, 64, 256];
const images = await Promise.all(sizes.map(png));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(s >= 256 ? 0 : s, 0);
  e.writeUInt8(s >= 256 ? 0 : s, 1);
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(images[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += images[i].length;
  return e;
});
fs.writeFileSync(`${out}/icon.ico`, Buffer.concat([header, ...entries, ...images]));
console.log("icons written");
