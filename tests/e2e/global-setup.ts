/** Owner account, sample files, and a signed-in browser state for every test. */
import fs from "node:fs";
import path from "node:path";
import { request, type FullConfig } from "@playwright/test";
import { owner, sha256, splitChunks, chunkPut, OWNER, BASE } from "../api/helpers.ts";

const ASSETS = path.join(import.meta.dirname, "../../web/public/demo-assets");

async function upload(c: Awaited<ReturnType<typeof owner>>, destDir: string, name: string, data: Buffer) {
  const s = await c.post("/api/upload/sessions", { destDir, relativePath: name, size: data.length, lastModified: Date.now() - 86_400_000 * 30, mode: "chunks" });
  if (s.status === 409 || s.status >= 400) return;
  const parts = data.length ? splitChunks(data, s.body.chunkSize) : [];
  for (let i = 0; i < parts.length; i++) await chunkPut(c, s.body.id, i, parts[i], sha256(parts[i]));
  await c.post(`/api/upload/sessions/${s.body.id}/complete`);
}

export default async function globalSetup(_config: FullConfig) {
  fs.mkdirSync("e2e-results", { recursive: true });
  const o = await owner();
  const top = await o.get("/api/files?path=");
  const names = new Set((top.body.children ?? []).map((n: { name: string }) => n.name));
  if (!names.has("Photos")) {
    for (const d of ["Photos", "Documents", "Videos"]) await o.post("/api/fs/mkdir", { parentPath: "", name: d });
    await o.post("/api/fs/mkdir", { parentPath: "Photos", name: "Trip to the hills" });
    for (const f of fs.readdirSync(path.join(ASSETS, "photos")).slice(0, 12)) {
      await upload(o, "Photos/Trip to the hills", f.replace("photo-", "IMG_20260"), fs.readFileSync(path.join(ASSETS, "photos", f)));
    }
    await upload(o, "Videos", "Waterfall.mp4", fs.readFileSync(path.join(ASSETS, "videos/clip-01.mp4")));
    await upload(o, "Documents", "Packing list.md", Buffer.from("# Packing list\n\n- Boots\n- Rain jacket\n- Camera\n"));
    await upload(o, "Documents", "Notes.txt", Buffer.from("Loom test notes.\n"));
  }

  // Sign in the way the login page does and keep the cookie for the browser tests.
  const ctx = await request.newContext({ baseURL: BASE });
  const res = await ctx.post("/api/auth/sign-in/email", { data: { email: OWNER.email, password: OWNER.password }, headers: { origin: BASE } });
  if (!res.ok()) throw new Error(`sign-in failed: ${res.status()}`);
  await ctx.storageState({ path: "e2e-results/owner.json" });
  await ctx.dispose();
}
