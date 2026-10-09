/**
 * Uploads: the browser's in-order protocol (must keep working exactly as
 * before) and the apps' numbered, parallel chunks. The test stack uses 1 MiB
 * chunks and a 64 MiB write window.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  Client, owner, familyUser, pairApp, sharedApp, sha256, randomBytes, uniq, sql, closeDb, freshFolder,
  mediaFile, mediaExists, mediaList, putBytes, chunkPut, splitChunks, runMaintenance, compose, waitHealthy, MEDIA, BASE,
} from "./helpers.ts";

after(closeDb);

const MiB = 1024 * 1024;

async function createSession(c: Client, body: Record<string, unknown>) {
  const r = await c.post("/api/upload/sessions", body);
  assert.ok(r.status === 201 || r.status === 200, `create → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/** The browser way: chunks in order, the last one finalizes. */
async function streamUpload(c: Client, destDir: string, name: string, data: Buffer, extra: Record<string, unknown> = {}, conflict = "keep_both") {
  const s = await createSession(c, { destDir, relativePath: name, size: data.length, lastModified: 1_600_000_000_000, ...extra });
  let offset = 0;
  let last: any = null;
  const parts = data.length ? splitChunks(data, s.chunkSize) : [Buffer.alloc(0)];
  for (let i = 0; i < parts.length; i++) {
    const final = i === parts.length - 1;
    const r = await putBytes(c, `/api/upload/sessions/${s.id}?offset=${offset}${final ? `&final=1&conflict=${conflict}` : ""}`, parts[i], {
      "x-chunk-sha256": sha256(parts[i]),
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    offset += parts[i].length;
    last = r.body;
  }
  return { session: s, result: last };
}

/** The app way: numbered chunks (given order), then complete. */
async function chunkUpload(c: Client, destDir: string, name: string, data: Buffer, order?: number[], extra: Record<string, unknown> = {}) {
  const s = await createSession(c, { destDir, relativePath: name, size: data.length, lastModified: 1_600_000_000_000, mode: "chunks", ...extra });
  const parts = splitChunks(data, s.chunkSize);
  for (const i of order ?? parts.map((_, i) => i)) {
    const r = await chunkPut(c, s.id, i, parts[i]);
    assert.equal(r.status, 200, `chunk ${i}: ${JSON.stringify(r.body)}`);
  }
  const done = await c.post(`/api/upload/sessions/${s.id}/complete`);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return { session: s, result: done.body };
}

// ─── the browser's protocol ──────────────────────────────────────────────────

test("stream: a multi-chunk upload arrives intact with its original date", async () => {
  const o = await owner();
  const dir = await freshFolder(o);
  const data = randomBytes(2.5 * MiB);
  const { session, result } = await streamUpload(o, dir, "video.bin", data);
  assert.equal(result.success, true);
  assert.equal(result.path, `${dir}/video.bin`);
  assert.equal(sha256(mediaFile(result.path)), sha256(data));
  assert.equal(fs.statSync(path.join(MEDIA, result.path)).mtimeMs, 1_600_000_000_000);
  assert.equal(mediaExists(`.tmp-upload/${session.id}.partial`), false, "the temporary file is gone");
});

test("stream: wrong offsets get 409 with the server's position; corrupt chunks 422 and are discarded", async () => {
  const o = await owner();
  const dir = await freshFolder(o);
  const data = randomBytes(2 * MiB);
  const s = await createSession(o, { destDir: dir, relativePath: "a.bin", size: data.length });
  const [c0, c1] = splitChunks(data, s.chunkSize);
  assert.equal((await putBytes(o, `/api/upload/sessions/${s.id}?offset=0`, c0, { "x-chunk-sha256": sha256(c0) })).body.received, MiB);
  const wrong = await putBytes(o, `/api/upload/sessions/${s.id}?offset=0`, c0, { "x-chunk-sha256": sha256(c0) });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.received, MiB);
  const bad = await putBytes(o, `/api/upload/sessions/${s.id}?offset=${MiB}`, c1, { "x-chunk-sha256": sha256(c0) });
  assert.equal(bad.status, 422);
  assert.equal((await o.get(`/api/upload/sessions/${s.id}`)).body.received, MiB, "the corrupt chunk wasn't kept");
  const ok = await putBytes(o, `/api/upload/sessions/${s.id}?offset=${MiB}&final=1`, c1, { "x-chunk-sha256": sha256(c1) });
  assert.equal(ok.status, 200);
  assert.equal(sha256(mediaFile(ok.body.path)), sha256(data));
  // Numbered chunks aren't accepted on an in-order upload.
  const s2 = await createSession(o, { destDir: dir, relativePath: "b.bin", size: 10 });
  assert.equal((await chunkPut(o, s2.id, 0, randomBytes(10))).status, 400);
});

test("stream: empty files, Keep both and Replace (the old file goes to Trash)", async () => {
  const o = await owner();
  const dir = await freshFolder(o);
  const empty = await streamUpload(o, dir, "empty.txt", Buffer.alloc(0));
  assert.equal(mediaFile(empty.result.path).length, 0);

  const v1 = Buffer.from("version one");
  const v2 = Buffer.from("version two!");
  await streamUpload(o, dir, "doc.txt", v1);
  const both = await streamUpload(o, dir, "doc.txt", v2, {}, "keep_both");
  assert.equal(both.result.name, "doc (1).txt");
  assert.equal(both.result.renamed, true);

  const repl = await streamUpload(o, dir, "doc.txt", v2, {}, "replace");
  assert.equal(repl.result.replaced, true);
  assert.equal(mediaFile(`${dir}/doc.txt`).toString(), "version two!");
  const trash = await sql(`SELECT count(*)::int AS n FROM trash_items WHERE "originalPath" = $1`, [`${dir}/doc.txt`]);
  assert.equal(trash[0].n, 1);
});

// ─── the apps' numbered chunks ───────────────────────────────────────────────

test("chunks: out of order produces the same file; the session lists what's missing", async () => {
  const o = await owner();
  const { app } = await sharedApp(o);
  const dir = await freshFolder(o);
  const data = randomBytes(5 * MiB + 1234);
  const s = await createSession(app, { destDir: dir, relativePath: "sub/folder/big.bin", size: data.length, mode: "chunks" });
  assert.equal(s.mode, "chunks");
  assert.equal(s.chunks, 6);
  assert.deepEqual(s.missing, [0, 1, 2, 3, 4, 5]);
  const parts = splitChunks(data, s.chunkSize);
  for (const i of [5, 2, 0, 4]) assert.equal((await chunkPut(app, s.id, i, parts[i])).status, 200);
  const mid = await app.get(`/api/upload/sessions/${s.id}`);
  assert.deepEqual(mid.body.missing, [1, 3]);
  assert.equal(mid.body.received, parts[0].length + parts[2].length + parts[4].length + parts[5].length);
  const early = await app.post(`/api/upload/sessions/${s.id}/complete`);
  assert.equal(early.status, 409);
  assert.deepEqual(early.body.missing, [1, 3]);
  for (const i of [3, 1]) assert.equal((await chunkPut(app, s.id, i, parts[i])).status, 200);
  const done = await app.post(`/api/upload/sessions/${s.id}/complete`);
  assert.equal(done.status, 200);
  assert.equal(done.body.path, `${dir}/sub/folder/big.bin`);
  assert.equal(sha256(mediaFile(done.body.path)), sha256(data));
  assert.equal(fs.statSync(path.join(MEDIA, done.body.path)).mtimeMs > 0, true);

  // Asking again (lost response) returns the same answer, not an error or a copy.
  const again = await app.post(`/api/upload/sessions/${s.id}/complete`);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, done.body);
  assert.deepEqual(mediaList(`${dir}/sub/folder`), ["big.bin"]);
  const status = await app.get(`/api/upload/sessions/${s.id}`);
  assert.equal(status.body.result.path, done.body.path);
  // A finished session takes no more chunks.
  assert.equal((await chunkPut(app, s.id, 0, parts[0])).status, 409);
});

test("chunks: an empty file, and a plain in-order upload with keep-both naming", async () => {
  const o = await owner();
  const { app } = await sharedApp(o);
  const dir = await freshFolder(o);
  const empty = await chunkUpload(app, dir, "empty.bin", Buffer.alloc(0));
  assert.equal(mediaFile(empty.result.path).length, 0);
  const data = randomBytes(3 * MiB);
  await chunkUpload(app, dir, "same.bin", data);
  const second = await chunkUpload(app, dir, "same.bin", data);
  assert.equal(second.result.name, "same (1).bin");
  assert.equal(fs.statSync(path.join(MEDIA, second.result.path)).mtimeMs, 1_600_000_000_000);
});

test("chunks: a resent chunk is acknowledged without rewriting it", async () => {
  const o = await owner();
  const { app } = await sharedApp(o);
  const dir = await freshFolder(o);
  const data = randomBytes(2 * MiB);
  const s = await createSession(app, { destDir: dir, relativePath: "d.bin", size: data.length, mode: "chunks" });
  const parts = splitChunks(data, s.chunkSize);
  assert.equal((await chunkPut(app, s.id, 0, parts[0])).status, 200);
  const dup = await chunkPut(app, s.id, 0, parts[0]);
  assert.equal(dup.status, 200);
  assert.equal(dup.body.duplicate, true);
  assert.equal(dup.body.received, MiB, "counted once");
});

test("chunks: wrong length, missing or wrong checksum, bad index", async () => {
  const o = await owner();
  const { app } = await sharedApp(o);
  const dir = await freshFolder(o);
  const data = randomBytes(2 * MiB);
  const s = await createSession(app, { destDir: dir, relativePath: "v.bin", size: data.length, mode: "chunks" });
  const parts = splitChunks(data, s.chunkSize);
  assert.equal((await chunkPut(app, s.id, 0, parts[0].subarray(0, 1000))).status, 400);
  assert.equal((await chunkPut(app, s.id, 0, parts[0], null)).status, 400);
  const bad = await chunkPut(app, s.id, 1, parts[1], sha256(parts[0]));
  assert.equal(bad.status, 422);
  assert.deepEqual((await app.get(`/api/upload/sessions/${s.id}`)).body.missing, [0, 1], "a corrupt chunk isn't marked");
  assert.equal((await chunkPut(app, s.id, 2, parts[1])).status, 400);
  const neg = await putBytes(app, `/api/upload/sessions/${s.id}?chunk=-1`, parts[0], { "x-chunk-sha256": sha256(parts[0]) });
  assert.equal(neg.status, 400);
});

test("chunks: the write window keeps far-ahead chunks out (no huge zero-fill on exFAT)", async () => {
  const o = await owner();
  const { app } = await sharedApp(o);
  const dir = await freshFolder(o);
  const size = 80 * MiB;
  const s = await createSession(app, { destDir: dir, relativePath: "w.bin", size, mode: "chunks" });
  assert.equal(s.windowEnd, 64);
  const far = await chunkPut(app, s.id, 70, randomBytes(MiB));
  assert.equal(far.status, 409);
  assert.equal(far.body.windowEnd, 64);
  assert.equal((await chunkPut(app, s.id, 64, randomBytes(MiB))).status, 200, "the window's edge is fine");
  await app.del(`/api/upload/sessions/${s.id}`);
});

test("chunks: a retried create with the same clientRef returns the same session", async () => {
  const o = await owner();
  const { app } = await sharedApp(o);
  const dir = await freshFolder(o);
  const ref = uniq("ref-abcdef");
  const body = { destDir: dir, relativePath: "r.bin", size: 100, mode: "chunks", clientRef: ref };
  const a = await app.post("/api/upload/sessions", body);
  const b = await app.post("/api/upload/sessions", body);
  assert.equal(a.status, 201);
  assert.equal(b.body.id, a.body.id);
  const clash = await app.post("/api/upload/sessions", { ...body, size: 101 });
  assert.equal(clash.status, 409);
});

test("chunks: apps choose their chunk size within limits", async () => {
  const o = await owner();
  const { app } = await sharedApp(o);
  const dir = await freshFolder(o);
  const s = await createSession(app, { destDir: dir, relativePath: "c.bin", size: 10 * MiB, mode: "chunks", chunkSize: 4 * MiB });
  assert.equal(s.chunkSize, 4 * MiB);
  assert.equal(s.chunks, 3);
  assert.equal((await app.post("/api/upload/sessions", { destDir: dir, relativePath: "x.bin", size: 10, mode: "chunks", chunkSize: 1000 })).status, 400);
  assert.equal((await app.post("/api/upload/sessions", { destDir: dir, relativePath: "x.bin", size: 10, mode: "chunks", chunkSize: 200 * MiB })).status, 400);
});

test("chunks: parallel chunks are capped per upload; a busy chunk can't be written twice", async () => {
  const o = await owner();
  const { app } = await sharedApp(o);
  const dir = await freshFolder(o);
  const data = randomBytes(6 * MiB);
  const s = await createSession(app, { destDir: dir, relativePath: "p.bin", size: data.length, mode: "chunks" });
  const parts = splitChunks(data, s.chunkSize);

  // Four slow chunks: send half, then hold until released.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow = (i: number) =>
    app.raw("PUT", `/api/upload/sessions/${s.id}?chunk=${i}`, {
      body: new ReadableStream({
        async start(ctrl) {
          ctrl.enqueue(parts[i].subarray(0, MiB / 2));
          await gate;
          ctrl.enqueue(parts[i].subarray(MiB / 2));
          ctrl.close();
        },
      }) as unknown as BodyInit,
      headers: { "content-type": "application/octet-stream", "content-length": String(parts[i].length), "x-chunk-sha256": sha256(parts[i]) },
    });
  const running = [0, 1, 2, 3].map(slow);
  await new Promise((r) => setTimeout(r, 800));
  const fifth = await chunkPut(app, s.id, 4, parts[4]);
  assert.equal(fifth.status, 429);
  const same = await chunkPut(app, s.id, 0, parts[0]);
  assert.equal(same.status, 409, "chunk 0 is already being written");
  release();
  for (const r of await Promise.all(running)) assert.equal(r.status, 200, await r.text());
  for (const i of [4, 5]) assert.equal((await chunkPut(app, s.id, i, parts[i])).status, 200);
  const done = await app.post(`/api/upload/sessions/${s.id}/complete`);
  assert.equal(sha256(mediaFile(done.body.path)), sha256(data));
});

test("chunks: an aborted chunk leaves nothing marked and can be resent", async () => {
  const o = await owner();
  const { app } = await sharedApp(o);
  const dir = await freshFolder(o);
  const data = randomBytes(2 * MiB);
  const s = await createSession(app, { destDir: dir, relativePath: "ab.bin", size: data.length, mode: "chunks" });
  const parts = splitChunks(data, s.chunkSize);
  const ac = new AbortController();
  const p = fetch(`${BASE}/api/upload/sessions/${s.id}?chunk=1`, {
    method: "PUT",
    signal: ac.signal,
    headers: { ...app.headers(), "content-type": "application/octet-stream", "content-length": String(parts[1].length), "x-chunk-sha256": sha256(parts[1]) },
    body: new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(parts[1].subarray(0, 1000)); // never finishes
      },
    }) as unknown as BodyInit,
    // @ts-expect-error streamed body
    duplex: "half",
  }).catch(() => null);
  await new Promise((r) => setTimeout(r, 500));
  ac.abort();
  await p;
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual((await app.get(`/api/upload/sessions/${s.id}`)).body.missing, [0, 1]);
  for (const i of [1, 0]) assert.equal((await chunkPut(app, s.id, i, parts[i])).status, 200);
  const done = await app.post(`/api/upload/sessions/${s.id}/complete`);
  assert.equal(sha256(mediaFile(done.body.path)), sha256(data));
});

test("chunks: the upload survives a server restart and resumes from what's missing", async () => {
  const o = await owner();
  const { app } = await sharedApp(o);
  const dir = await freshFolder(o);
  const data = randomBytes(4 * MiB);
  const s = await createSession(app, { destDir: dir, relativePath: "restart.bin", size: data.length, mode: "chunks" });
  const parts = splitChunks(data, s.chunkSize);
  for (const i of [0, 2]) await chunkPut(app, s.id, i, parts[i]);
  compose("restart", "loom-web");
  await waitHealthy();
  const after = await app.get(`/api/upload/sessions/${s.id}`);
  assert.equal(after.status, 200);
  assert.deepEqual(after.body.missing, [1, 3]);
  for (const i of after.body.missing) assert.equal((await chunkPut(app, s.id, i, parts[i])).status, 200);
  const done = await app.post(`/api/upload/sessions/${s.id}/complete`);
  assert.equal(sha256(mediaFile(done.body.path)), sha256(data));
});

// ─── who sees what ───────────────────────────────────────────────────────────

test("browsers and apps each list (and clean up) only their own unfinished uploads", async () => {
  const o = await owner();
  const { app } = await sharedApp(o);
  const dir = await freshFolder(o);
  const browserSession = await createSession(o, { destDir: dir, relativePath: "b.bin", size: 10 });
  const appSession = await createSession(app, { destDir: dir, relativePath: "a.bin", size: 10, mode: "chunks" });
  const browserList = (await o.get("/api/upload/sessions")).body.sessions.map((x: any) => x.id);
  const appList = (await app.get("/api/upload/sessions")).body.sessions.map((x: any) => x.id);
  assert.ok(browserList.includes(browserSession.id) && !browserList.includes(appSession.id));
  assert.ok(appList.includes(appSession.id) && !appList.includes(browserSession.id));

  // "Discard stale uploads" in the browser never touches an app's (maybe paused) uploads.
  await sql(`UPDATE upload_sessions SET "updatedAt" = now() - interval '1 hour' WHERE id = ANY($1)`, [[browserSession.id, appSession.id]]);
  const stale = await o.del("/api/upload/sessions?stale=1");
  assert.ok(stale.body.removed >= 1);
  assert.equal((await app.get(`/api/upload/sessions/${appSession.id}`)).status, 200);
  assert.equal((await o.get(`/api/upload/sessions/${browserSession.id}`)).status, 404);

  // Another user can't see or touch it.
  const fam = await familyUser();
  assert.equal((await fam.client.get(`/api/upload/sessions/${appSession.id}`)).status, 404);
});

test("app uploads stay resumable for a week, browser ones for a day; housekeeping removes expired ones", async () => {
  const o = await owner();
  const { app } = await sharedApp(o);
  const dir = await freshFolder(o);
  const a = await createSession(app, { destDir: dir, relativePath: "ttl-a.bin", size: 10, mode: "chunks" });
  const b = await createSession(o, { destDir: dir, relativePath: "ttl-b.bin", size: 10 });
  const days = (d: string) => (new Date(d).getTime() - Date.now()) / 86_400_000;
  assert.ok(Math.abs(days(a.expiresAt) - 7) < 0.01, `app: ${days(a.expiresAt)}`);
  assert.ok(Math.abs(days(b.expiresAt) - 1) < 0.01, `browser: ${days(b.expiresAt)}`);

  assert.ok(mediaExists(`.tmp-upload/${a.id}.partial`));
  await sql(`UPDATE upload_sessions SET "expiresAt" = now() - interval '1 minute' WHERE id = $1`, [a.id]);
  runMaintenance();
  assert.equal((await sql(`SELECT 1 FROM upload_sessions WHERE id = $1`, [a.id])).length, 0);
  assert.equal(mediaExists(`.tmp-upload/${a.id}.partial`), false);
});

test("removing an app cancels its unfinished uploads", async () => {
  const o = await owner();
  const { app, deviceId } = await pairApp(o);
  const dir = await freshFolder(o);
  const s = await createSession(app, { destDir: dir, relativePath: "gone.bin", size: 10, mode: "chunks" });
  await o.del(`/api/devices/${deviceId}`);
  assert.equal((await sql(`SELECT 1 FROM upload_sessions WHERE id = $1`, [s.id])).length, 0);
});

test("chunks: an app's upload is announced live to open browsers, like a browser upload", async () => {
  const o = await owner();
  const { app } = await sharedApp(o);
  const dir = await freshFolder(o);
  // The browser's live-update stream (what refreshes the folder on screen).
  const ac = new AbortController();
  const res = await o.raw("GET", "/api/events", { headers: { accept: "text/event-stream" } });
  assert.equal(res.status, 200);
  const events: string[] = [];
  const reading = (async () => {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    ac.signal.addEventListener("abort", () => reader.cancel().catch(() => {}));
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        events.push(dec.decode(value));
      }
    } catch {
      /* cancelled */
    }
  })();
  await new Promise((r) => setTimeout(r, 300));
  await chunkUpload(app, dir, "from-the-app.bin", randomBytes(MiB + 5));
  const until = Date.now() + 10_000;
  while (!events.join("").includes(`"${dir}"`) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  ac.abort();
  await reading;
  const changed = events
    .join("")
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice(5)))
    .find((e) => e.type === "changed" && e.dirs?.includes(dir));
  assert.ok(changed, `no change event for ${dir}: ${events.join("")}`);
  assert.ok(changed.nodeIds?.length >= 1, "names the new file");
});
