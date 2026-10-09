/**
 * GET /api/client/info and the LAN listener (loom-lan): HTTPS from Loom's own
 * certificate authority, app tokens only.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { Client, owner, pairApp, lanRequest, sha256, randomBytes, closeDb, freshFolder, mediaFile, sql, LAN_CA } from "./helpers.ts";

after(closeDb);

test("client info: public basics; the LAN address and CA only for signed-in callers", async () => {
  const anon = await new Client().get("/api/client/info");
  assert.equal(anon.status, 200);
  assert.equal(anon.body.product, "loom");
  assert.equal(anon.body.apiVersion, 1);
  assert.match(anon.body.instanceId, /^[0-9a-f-]{36}$/);
  assert.ok(anon.body.capabilities.includes("upload.chunks.v1"));
  assert.equal(anon.body.upload.chunkSize, 1024 * 1024);
  assert.equal(anon.body.lan, null);
  assert.equal(anon.body.user, null);

  const o = await owner();
  const { app, deviceId } = await pairApp(o);
  const info = await app.get("/api/client/info");
  assert.equal(info.body.deviceId, deviceId);
  assert.equal(info.body.instanceId, anon.body.instanceId, "stable");
  assert.equal(info.body.lan.url, "https://127.0.0.1:18443");
  const pem = fs.readFileSync(LAN_CA, "utf8").trim();
  assert.equal(info.body.lan.caPem, pem);
  const der = new crypto.X509Certificate(pem).raw;
  assert.equal(info.body.lan.caSha256, crypto.createHash("sha256").update(der).digest("hex"));
});

test("LAN: the certificate chains to the pinned CA, and is refused without it", async () => {
  const ok = await lanRequest("GET", "/api/health");
  assert.equal(ok.status, 200);
  const leaf = ok.cert;
  assert.match(String(leaf.subjectaltname), /IP Address:127\.0\.0\.1/);
  await assert.rejects(lanRequest("GET", "/api/health", { ca: null }), /self[- ]signed|unable to (get|verify)|certificate/i);
});

test("LAN: app tokens only — no sign-in page, no browser sessions", async () => {
  const o = await owner();
  const { token } = await pairApp(o);
  assert.equal((await lanRequest("GET", "/api/files?path=", { token })).status, 200);
  assert.equal((await lanRequest("GET", "/api/files?path=")).status, 403, "no token: refused by the proxy");
  assert.equal((await lanRequest("GET", "/login")).status, 403);
  assert.equal((await lanRequest("POST", "/api/auth/sign-in/email", { body: Buffer.from("{}") })).status, 403);
  // Even a cookie smuggled in next to a fake app header is refused by loom-web.
  const cookieOnly = await lanRequest("GET", "/api/files?path=", { cookie: o.cookie, headers: { authorization: "Bearer loomd_x" } });
  assert.equal(cookieOnly.status, 401);
  // Open endpoints the apps use to find the address.
  const info = await lanRequest("GET", "/api/client/info");
  assert.equal(info.status, 200);
  assert.equal(info.body.lan, null, "anonymous over LAN: still no LAN details");
});

test("LAN: an upload over the local network, and spoofed client addresses are ignored", async () => {
  const o = await owner();
  const { token, deviceId } = await pairApp(o);
  const dir = await freshFolder(o);
  // Make the next request record the address it came from (written at most
  // every 5 minutes, after the 15-second lookup cache).
  await sql(`UPDATE devices SET "lastSeenAt" = now() - interval '1 hour' WHERE id = $1`, [deviceId]);
  await new Promise((r) => setTimeout(r, 16_000));
  const data = randomBytes(1.5 * 1024 * 1024);
  const created = await lanRequest("POST", "/api/upload/sessions", {
    token,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ destDir: dir, relativePath: "lan.bin", size: data.length, mode: "chunks" })),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const s = created.body;
  for (let i = 0; i < s.chunks; i++) {
    const part = data.subarray(i * s.chunkSize, (i + 1) * s.chunkSize);
    const r = await lanRequest("PUT", `/api/upload/sessions/${s.id}?chunk=${i}`, {
      token,
      body: part,
      headers: { "x-chunk-sha256": sha256(part), "content-type": "application/octet-stream", "x-forwarded-for": "6.6.6.6", "cf-connecting-ip": "6.6.6.6" },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const done = await lanRequest("POST", `/api/upload/sessions/${s.id}/complete`, { token });
  assert.equal(done.status, 200);
  assert.equal(sha256(mediaFile(done.body.path)), sha256(data));
  const [row] = await sql(`SELECT "lastIp", "lastSeenAt" > now() - interval '1 minute' AS fresh FROM devices WHERE id = $1`, [deviceId]);
  assert.equal(row.fresh, true);
  assert.notEqual(row.lastIp, "6.6.6.6", "the LAN proxy replaces client-supplied addresses");
});
