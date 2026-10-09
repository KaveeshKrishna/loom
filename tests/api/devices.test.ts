/**
 * Paired apps: pairing flows, bearer tokens, what a token may not do,
 * removal, password resets, and signing the app's browser in.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Client, owner, familyUser, pairApp, sha256, sql, closeDb, uniq, cookieHeader, BASE } from "./helpers.ts";

after(closeDb);

const newToken = () => `loomd_${crypto.randomBytes(32).toString("base64url")}`;

test("approve flow: pending until allowed, then the app's own token works; polling again is harmless", async () => {
  const o = await owner();
  const app = new Client();
  const token = newToken();
  const start = await app.post("/api/devices/pair/start", { name: "Study PC", platform: "windows", appVersion: "1.2.3", tokenHash: sha256(token) });
  assert.equal(start.status, 201);
  assert.match(start.body.checkCode, /^\d{3} \d{3}$/);
  assert.equal(start.body.approvePath, `/pair/${start.body.pairId}`);

  const poll = () => app.post("/api/devices/pair/poll", { pairId: start.body.pairId, secret: start.body.secret });
  assert.deepEqual((await poll()).body, { status: "pending" });

  // A wrong secret learns nothing.
  const bad = await app.post("/api/devices/pair/poll", { pairId: start.body.pairId, secret: "nope" });
  assert.equal(bad.status, 404);

  // The approval page sees the request…
  const info = await o.get(`/api/devices/pair/${start.body.pairId}`);
  assert.equal(info.status, 200);
  assert.equal(info.body.state, "pending");
  assert.equal(info.body.deviceName, "Study PC");
  assert.equal(info.body.checkCode, start.body.checkCode);
  // …and allows it.
  assert.equal((await o.post(`/api/devices/pair/${start.body.pairId}`, { allow: true })).status, 200);
  // A second answer is refused.
  assert.equal((await o.post(`/api/devices/pair/${start.body.pairId}`, { allow: false })).status, 410);

  const done = await poll();
  assert.equal(done.status, 200);
  assert.equal(done.body.status, "approved");
  assert.equal(done.body.token, undefined, "a committed token is never sent back");
  assert.equal(done.body.user.email, "owner@loom.test");
  const again = await poll();
  assert.equal(again.status, 200, "polling again (lost response) returns the same device");
  assert.equal(again.body.device.id, done.body.device.id);

  const me = await new Client(token).get("/api/devices/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.device.name, "Study PC");
  assert.equal(me.body.device.appVersion, "1.2.3");
  assert.equal(me.body.device.current, true);
});

test("approve flow without a token commitment hands the token out exactly once", async () => {
  const o = await owner();
  const app = new Client();
  const start = await app.post("/api/devices/pair/start", { name: "Old app", platform: "android" });
  await o.post(`/api/devices/pair/${start.body.pairId}`, { allow: true });
  const first = await app.post("/api/devices/pair/poll", { pairId: start.body.pairId, secret: start.body.secret });
  assert.equal(first.status, 200);
  assert.match(first.body.token, /^loomd_/);
  const second = await app.post("/api/devices/pair/poll", { pairId: start.body.pairId, secret: start.body.secret });
  assert.equal(second.status, 410);
  assert.equal(second.body.status, "used");
  assert.equal((await new Client(first.body.token).get("/api/devices/me")).status, 200);
});

test("declined requests stay declined", async () => {
  const o = await owner();
  const app = new Client();
  const start = await app.post("/api/devices/pair/start", { name: "Stranger", platform: "windows", tokenHash: sha256(newToken()) });
  await o.post(`/api/devices/pair/${start.body.pairId}`, { allow: false });
  const r = await app.post("/api/devices/pair/poll", { pairId: start.body.pairId, secret: start.body.secret });
  assert.equal(r.status, 403);
  assert.equal(r.body.status, "denied");
});

test("expired requests can't be approved or polled", async () => {
  const o = await owner();
  const app = new Client();
  const start = await app.post("/api/devices/pair/start", { name: "Slow", platform: "windows" });
  await sql(`UPDATE device_pairings SET "expiresAt" = now() - interval '1 minute' WHERE id = $1`, [start.body.pairId]);
  assert.equal((await o.post(`/api/devices/pair/${start.body.pairId}`, { allow: true })).status, 410);
  const r = await app.post("/api/devices/pair/poll", { pairId: start.body.pairId, secret: start.body.secret });
  assert.equal(r.status, 410);
  assert.equal(r.body.status, "expired");
});

test("pairing input is validated", async () => {
  const app = new Client();
  assert.equal((await app.post("/api/devices/pair/start", { name: "", platform: "windows" })).status, 400);
  assert.equal((await app.post("/api/devices/pair/start", { name: "x", platform: "toaster" })).status, 400);
  assert.equal((await app.post("/api/devices/pair/start", { name: "x", platform: "windows", tokenHash: "abc" })).status, 400);
  assert.equal((await app.post("/api/devices/pair/redeem", { code: "short", name: "x", platform: "windows" })).status, 400);
});

test("QR codes work once; a retry with the same token commitment gets the same device", async () => {
  const o = await owner();
  const code = await o.post("/api/devices/codes");
  assert.equal(code.status, 201);
  assert.match(code.body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const token = newToken();
  const body = { code: code.body.code.toLowerCase().replace(/-/g, " "), name: "Pixel", platform: "android", tokenHash: sha256(token) };
  const a = await new Client().post("/api/devices/pair/redeem", body);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const b = await new Client().post("/api/devices/pair/redeem", body);
  assert.equal(b.status, 201);
  assert.equal(b.body.device.id, a.body.device.id);
  const c = await new Client().post("/api/devices/pair/redeem", { ...body, tokenHash: sha256(newToken()) });
  assert.equal(c.status, 404, "someone else can't reuse the code");
  assert.equal((await new Client(token).get("/api/devices/me")).body.device.platform, "android");
});

test("expired codes are refused", async () => {
  const o = await owner();
  const code = await o.post("/api/devices/codes");
  await sql(`UPDATE device_pairings SET "expiresAt" = now() - interval '1 second' WHERE kind = 'code' AND "consumedAt" IS NULL`);
  const r = await new Client().post("/api/devices/pair/redeem", { code: code.body.code, name: "Late", platform: "android" });
  assert.equal(r.status, 404);
});

test("a device token works on file APIs but not on administration or device management", async () => {
  const o = await owner();
  const { app } = await pairApp(o);
  assert.equal((await app.get("/api/files?path=")).status, 200);
  assert.equal((await app.get("/api/storage")).status, 200);
  assert.equal((await app.get("/api/client/info")).body.user.email, "owner@loom.test");
  // Owner-only administration needs a real sign-in, even for the Owner's own app.
  for (const url of ["/api/users", "/api/acl?userId=x", "/api/audit", "/api/scan"]) {
    const r = await app.get(url);
    assert.equal(r.status, 403, `${url} → ${r.status}`);
  }
  // A token can't mint more access or manage devices.
  assert.equal((await app.post("/api/devices/codes")).status, 403);
  assert.equal((await app.get("/api/devices")).status, 403);
  assert.equal((await app.post("/api/shares", { fileNodeId: "x" })).status, 403);
  // But it can sign itself out.
  assert.equal((await app.del("/api/devices/me")).status, 200);
  assert.equal((await app.get("/api/files?path=")).status, 401);
});

test("an unknown device token is a 401, never a fallback to the cookie", async () => {
  const o = await owner();
  const both = new Client(newToken());
  both.cookie = o.cookie;
  assert.equal((await both.get("/api/files?path=")).status, 401);
  // Other bearer schemes are ignored (cookie still works).
  const r = await o.req("GET", "/api/files?path=", undefined, { authorization: "Bearer something-else" });
  assert.equal(r.status, 200);
});

test("the Devices list: your own; the Owner sees everyone's; rename and remove", async () => {
  const o = await owner();
  const fam = await familyUser();
  const mine = await pairApp(fam.client, { name: "Family tablet", platform: "android" });
  const ownerApp = await pairApp(o, { name: uniq("Owner laptop") });

  const famList = await fam.client.get("/api/devices");
  assert.equal(famList.status, 200);
  assert.deepEqual(famList.body.devices.map((d: any) => d.id), [mine.deviceId]);
  assert.equal((await fam.client.del(`/api/devices/${ownerApp.deviceId}`)).status, 404, "can't remove someone else's");

  const all = await o.get("/api/devices");
  const ids = all.body.devices.map((d: any) => d.id);
  assert.ok(ids.includes(mine.deviceId) && ids.includes(ownerApp.deviceId));
  assert.equal(all.body.devices.find((d: any) => d.id === mine.deviceId).mine, false);

  assert.equal((await fam.client.patch(`/api/devices/${mine.deviceId}`, { name: "Kitchen tablet" })).body.device.name, "Kitchen tablet");

  // The Owner removes the family member's app: it stops working right away.
  assert.equal((await mine.app.get("/api/files?path=")).status, 200);
  assert.equal((await o.del(`/api/devices/${mine.deviceId}`)).status, 200);
  assert.equal((await mine.app.get("/api/files?path=")).status, 401);
  const audit = await sql(`SELECT action FROM audit_logs WHERE details->>'deviceId' = $1 ORDER BY timestamp`, [mine.deviceId]);
  assert.deepEqual(audit.map((a) => a.action), ["DEVICE_ADDED", "DEVICE_REMOVED"]);
});

test("the Owner resetting a password removes that user's apps; deleting the user too", async () => {
  const o = await owner();
  const fam = await familyUser();
  const { app } = await pairApp(fam.client);
  assert.equal((await app.get("/api/files?path=")).status, 200);
  assert.equal((await o.patch(`/api/users/${fam.id}`, { password: "a-brand-new-password" })).status, 200);
  assert.equal((await app.get("/api/files?path=")).status, 401);

  const fam2 = await familyUser();
  const p2 = await pairApp(fam2.client);
  assert.equal((await o.del(`/api/users/${fam2.id}`)).status, 200);
  assert.equal((await p2.app.get("/api/files?path=")).status, 401);
});

test("web login: a one-time link signs the app's browser in, tied to the device", async () => {
  const o = await owner();
  const { app, deviceId } = await pairApp(o);
  const link = await app.post("/api/devices/web-login");
  assert.equal(link.status, 200);
  assert.match(link.body.path, /^\/api\/devices\/web-login\?t=/);

  const browser = new Client();
  const res = await browser.raw("GET", `${link.body.path}&next=/files/Photos`);
  assert.equal(res.status, 303);
  assert.equal(new URL(res.headers.get("location")!).pathname, "/files/Photos");
  const setCookie = res.headers.getSetCookie().join("\n");
  assert.match(setCookie, /better-auth\.session_token=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  browser.cookie = cookieHeader(res);

  // better-auth accepts the cookie, and so does every API route.
  const session = await browser.get("/api/auth/get-session");
  assert.equal(session.status, 200);
  assert.equal(session.body?.user?.email, "owner@loom.test");
  assert.equal((await browser.get("/api/files?path=")).status, 200);

  // The link works once.
  const reuse = await new Client().raw("GET", link.body.path);
  assert.equal(new URL(reuse.headers.get("location")!).pathname, "/login");

  // A second link reuses the same session row instead of piling them up.
  const link2 = await app.post("/api/devices/web-login");
  await new Client().raw("GET", link2.body.path);
  const rows = await sql(`SELECT count(*)::int AS n FROM sessions WHERE "deviceId" = $1`, [deviceId]);
  assert.equal(rows[0].n, 1);

  // Removing the device signs its browser out too.
  await o.del(`/api/devices/${deviceId}`);
  assert.equal((await browser.get("/api/files?path=")).status, 401);
});

test("web login refuses other sites, unsafe redirects and browser callers", async () => {
  const o = await owner();
  const { app } = await pairApp(o);
  const link = await app.post("/api/devices/web-login");
  const cross = await new Client().raw("GET", link.body.path, { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(cross.status, 403);

  const link2 = await app.post("/api/devices/web-login");
  const evil = await new Client().raw("GET", `${link2.body.path}&next=//evil.example/x`);
  assert.equal(new URL(evil.headers.get("location")!).pathname, "/files");
  assert.equal(new URL(evil.headers.get("location")!).origin, new URL(BASE).origin);

  assert.equal((await o.post("/api/devices/web-login")).status, 401, "only apps create these links");
});

test("lastSeenAt is recorded for device requests", async () => {
  const o = await owner();
  const { app, deviceId } = await pairApp(o);
  await sql(`UPDATE devices SET "lastSeenAt" = now() - interval '1 hour' WHERE id = $1`, [deviceId]);
  await new Promise((r) => setTimeout(r, 16_000)); // let the 15 s lookup cache expire
  await app.get("/api/files?path=");
  await new Promise((r) => setTimeout(r, 300));
  const rows = await sql(`SELECT "lastSeenAt" > now() - interval '1 minute' AS fresh FROM devices WHERE id = $1`, [deviceId]);
  assert.equal(rows[0].fresh, true);
});
