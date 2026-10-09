/**
 * devices.ts — the Loom desktop and mobile apps.
 *
 * A paired app calls the API with `Authorization: Bearer loomd_…`. The token
 * is 32 random bytes; only its SHA-256 is stored (Device.tokenHash), so a
 * database leak doesn't leak working tokens. Removing the Device row cuts
 * the app off immediately (the lookup cache below lives 15 seconds) and
 * cascades to its embedded browser's session and its unfinished uploads.
 *
 * Pairing (DevicePairing rows, valid for 10 minutes, single use):
 *  - "approve": the app calls POST /api/devices/pair/start and opens
 *    /pair/<id> (normally in its own window). A signed-in user checks the
 *    short code matches the one the app shows and clicks Allow; the app polls
 *    POST /api/devices/pair/poll with its secret.
 *  - "code": a signed-in user creates a code on the Devices page (shown as a
 *    QR code); the app redeems it with POST /api/devices/pair/redeem.
 * Apps should generate their token themselves and send only its SHA-256
 * (`tokenHash`): then no token ever crosses the wire, and a lost response is
 * harmless because asking again returns the same device. Without tokenHash
 * the server makes the token and hands it out exactly once.
 *
 * The app's embedded browser is signed in with a normal better-auth session
 * through a one-time link (createWebLogin / consumeWebLogin), so the web UI
 * works exactly as in a browser.
 */

import crypto from "crypto";
import { cookies } from "next/headers";
import type { Device } from "@prisma/client";
import { prisma } from "./prisma";
import { auth } from "./auth";
import { HttpError, badRequest, notFound } from "./http-errors";
import type { SessionUser } from "./http";

export const TOKEN_PREFIX = "loomd_";
const PAIRING_TTL_MS = 10 * 60_000;
const MAX_ACTIVE_CODES = 5;
const WEB_LOGIN_TTL_MS = 60_000;
const LAST_SEEN_EVERY_MS = 5 * 60_000;
const CACHE_MS = 15_000;
export const PLATFORMS = ["windows", "macos", "linux", "android", "ios"] as const;

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// ─── input cleaning ──────────────────────────────────────────────────────────

export function cleanDeviceName(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  if (!s) throw badRequest("A device name is required");
  return s.slice(0, 80);
}

export function cleanPlatform(v: unknown): string {
  if (typeof v !== "string" || !(PLATFORMS as readonly string[]).includes(v)) throw badRequest("Unknown platform");
  return v;
}

export function cleanVersion(v: unknown): string | null {
  return typeof v === "string" && /^[\w.+-]{1,40}$/.test(v) ? v : null;
}

function cleanTokenHash(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) throw badRequest("tokenHash must be a SHA-256 hex digest");
  return v;
}

/** Client IP as seen by the reverse proxy (first X-Forwarded-For hop). */
export function clientIp(headers: Headers): string {
  return (headers.get("x-forwarded-for")?.split(",")[0] || headers.get("x-real-ip") || "unknown").trim().slice(0, 64);
}

// ─── rate limiting (per process; Loom runs one web process) ──────────────────

const g = globalThis as unknown as {
  __loomDeviceRate?: Map<string, { n: number; reset: number }>;
  __loomDeviceCache?: Map<string, { device: Device | null; at: number }>;
  __loomWebLogins?: Map<string, { deviceId: string; exp: number }>;
};
const rate = (g.__loomDeviceRate ??= new Map());

/** Allow `max` calls per `windowMs` for `key`; throws 429 beyond that. */
export function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  if (rate.size > 10_000) for (const [k, v] of rate) if (v.reset < now) rate.delete(k);
  const cur = rate.get(key);
  if (!cur || cur.reset < now) {
    rate.set(key, { n: 1, reset: now + windowMs });
    return;
  }
  if (++cur.n > max) {
    throw new HttpError(429, "Too many attempts. Wait a few minutes and try again.", {
      retryAfter: Math.ceil((cur.reset - now) / 1000),
    });
  }
}

// ─── tokens and lookup ───────────────────────────────────────────────────────

const cache = (g.__loomDeviceCache ??= new Map());

/** The bearer token from an Authorization header, if it is a device token. */
export function bearerToken(headers: Headers): string | null {
  const h = headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m && m[1].startsWith(TOKEN_PREFIX) ? m[1] : null;
}

/** Resolve a device token; null for unknown or removed ones. */
export async function deviceForToken(token: string, ip: string): Promise<Device | null> {
  const hash = sha256(token);
  const now = Date.now();
  let entry = cache.get(hash);
  if (!entry || now - entry.at > CACHE_MS) {
    const device = await prisma.device.findUnique({ where: { tokenHash: hash } });
    entry = { device, at: now };
    if (cache.size > 5_000) cache.clear();
    cache.set(hash, entry);
  }
  const device = entry.device;
  // "Last active" is shown on the Devices page; keep its writes rare and off
  // the request's critical path.
  if (device && (!device.lastSeenAt || now - device.lastSeenAt.getTime() > LAST_SEEN_EVERY_MS)) {
    device.lastSeenAt = new Date(now);
    device.lastIp = ip;
    prisma.device
      .update({ where: { id: device.id }, data: { lastSeenAt: device.lastSeenAt, lastIp: ip } })
      .catch(() => {}); // removed meanwhile; the next lookup will miss
  }
  return device;
}

/** Forget cached lookups so a removal takes effect right away. */
export function forgetDeviceCache() {
  cache.clear();
}

interface DeviceInfo {
  name: string;
  platform: string;
  appVersion: string | null;
}

/** Create a device. With `tokenHash` the app holds the token; otherwise one is made and returned. */
async function issueDevice(
  userId: string,
  info: DeviceInfo,
  ip: string,
  tokenHash: string | null
): Promise<{ device: Device; token: string | null }> {
  const token = tokenHash ? null : TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
  const device = await prisma.device.create({
    data: {
      userId,
      name: info.name,
      platform: info.platform,
      appVersion: info.appVersion,
      tokenHash: tokenHash ?? sha256(token!),
      lastSeenAt: new Date(),
      lastIp: ip,
    },
  });
  forgetDeviceCache();
  await audit(userId, "DEVICE_ADDED", { deviceId: device.id, name: device.name, platform: device.platform });
  return { device, token };
}

async function audit(userId: string | null, action: string, details: Record<string, unknown>) {
  await prisma.auditLog.create({ data: { userId, action, details: details as object } }).catch(() => {});
}

export function deviceJson(d: Device, currentDeviceId?: string | null) {
  return {
    id: d.id,
    name: d.name,
    platform: d.platform,
    appVersion: d.appVersion,
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    lastIp: d.lastIp,
    current: currentDeviceId === d.id,
  };
}

async function userJson(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, role: true } });
  if (!u) throw notFound("User not found");
  return u;
}

/** What the app gets once paired. `token` only when the server made it. */
async function pairedJson(device: Device, token: string | null) {
  return {
    status: "approved" as const,
    ...(token ? { token } : {}),
    device: deviceJson(device, device.id),
    user: await userJson(device.userId),
  };
}

// ─── pairing: "approve" flow ─────────────────────────────────────────────────

/** Six digits split as "123 456": easy to compare between app and page. */
function newCheckCode(): string {
  const n = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  return `${n.slice(0, 3)} ${n.slice(3)}`;
}

export async function startPairing(input: Record<string, unknown>, ip: string) {
  rateLimit(`pair-start|${ip}`, 20, 10 * 60_000);
  rateLimit("pair-start", 60, 10 * 60_000);
  const name = cleanDeviceName(input.name);
  const platform = cleanPlatform(input.platform);
  const tokenHash = cleanTokenHash(input.tokenHash);
  const secret = crypto.randomBytes(32).toString("base64url");
  const pairing = await prisma.devicePairing.create({
    data: {
      kind: "approve",
      secretHash: sha256(secret),
      checkCode: newCheckCode(),
      deviceName: name,
      platform,
      appVersion: cleanVersion(input.appVersion),
      requestIp: ip,
      tokenHash,
      expiresAt: new Date(Date.now() + PAIRING_TTL_MS),
    },
  });
  return {
    pairId: pairing.id,
    secret,
    checkCode: pairing.checkCode,
    approvePath: `/pair/${pairing.id}`,
    expiresAt: pairing.expiresAt,
    pollInterval: 2,
  };
}

/** What the approval page shows. */
export async function getPendingPairing(id: string) {
  const p = await prisma.devicePairing.findUnique({ where: { id } });
  if (!p || p.kind !== "approve") return null;
  const state = p.consumedAt || p.approvedAt ? "approved" : p.deniedAt ? "denied" : p.expiresAt < new Date() ? "expired" : "pending";
  return {
    id: p.id,
    state,
    deviceName: p.deviceName ?? "",
    platform: p.platform ?? "",
    checkCode: p.checkCode ?? "",
    requestIp: p.requestIp,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
  };
}

export async function decidePairing(user: SessionUser, id: string, allow: boolean) {
  rateLimit(`pair-decide|${user.id}`, 30, 10 * 60_000);
  // One atomic transition from pending, so a request can't be decided twice.
  const res = await prisma.devicePairing.updateMany({
    where: { id, kind: "approve", approvedAt: null, deniedAt: null, consumedAt: null, expiresAt: { gt: new Date() } },
    data: allow ? { approvedAt: new Date(), userId: user.id } : { deniedAt: new Date(), userId: user.id },
  });
  if (res.count === 0) throw new HttpError(410, "This request has expired or was already answered. Start again in the app.");
  await audit(user.id, allow ? "DEVICE_PAIR_APPROVED" : "DEVICE_PAIR_DENIED", { pairId: id });
}

export async function pollPairing(input: Record<string, unknown>, ip: string) {
  rateLimit(`pair-poll|${ip}`, 600, 10 * 60_000);
  const pairId = typeof input.pairId === "string" ? input.pairId : "";
  const secret = typeof input.secret === "string" ? input.secret : "";
  const p = pairId ? await prisma.devicePairing.findUnique({ where: { id: pairId } }) : null;
  if (!p || p.kind !== "approve" || !secret || p.secretHash !== sha256(secret)) throw notFound("Unknown pairing request");
  if (p.deniedAt) throw new HttpError(403, "The request was declined.", { status: "denied" });
  if (p.consumedAt) {
    // With a token commitment, asking again is harmless: same device.
    if (p.tokenHash && p.deviceId) {
      const device = await prisma.device.findUnique({ where: { id: p.deviceId } });
      if (device) return pairedJson(device, null);
    }
    throw new HttpError(410, "This request was already used.", { status: "used" });
  }
  if (!p.approvedAt) {
    if (p.expiresAt < new Date()) throw new HttpError(410, "The request expired. Start again.", { status: "expired" });
    return { status: "pending" as const };
  }
  // Claim it exactly once, even if two polls race.
  const claimed = await prisma.devicePairing.updateMany({ where: { id: p.id, consumedAt: null }, data: { consumedAt: new Date() } });
  if (claimed.count === 0) return pollPairing(input, ip);
  const { device, token } = await issueDevice(
    p.userId!,
    { name: p.deviceName ?? "Device", platform: p.platform ?? "windows", appVersion: p.appVersion },
    ip,
    p.tokenHash
  );
  await prisma.devicePairing.update({ where: { id: p.id }, data: { deviceId: device.id } });
  return pairedJson(device, token);
}

// ─── pairing: "code" flow (QR) ───────────────────────────────────────────────

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I

/** 12 characters (60 bits), shown as XXXX-XXXX-XXXX. */
function newPairingCode(): string {
  let s = "";
  for (let i = 0; i < 12; i++) s += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

function normalizeCode(v: unknown): string {
  const raw = typeof v === "string" ? v.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
  if (raw.length !== 12) throw badRequest("That code isn't valid");
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

export async function createPairingCode(user: SessionUser) {
  rateLimit(`pair-code|${user.id}`, 20, 10 * 60_000);
  const active = await prisma.devicePairing.count({
    where: { kind: "code", userId: user.id, consumedAt: null, expiresAt: { gt: new Date() } },
  });
  if (active >= MAX_ACTIVE_CODES) throw new HttpError(429, "You already have several unused codes. Wait for them to expire.");
  const code = newPairingCode();
  const p = await prisma.devicePairing.create({
    data: {
      kind: "code",
      secretHash: sha256(code),
      userId: user.id,
      approvedAt: new Date(),
      expiresAt: new Date(Date.now() + PAIRING_TTL_MS),
    },
  });
  await audit(user.id, "DEVICE_CODE_CREATED", { pairId: p.id });
  return { code, expiresAt: p.expiresAt };
}

export async function redeemPairingCode(input: Record<string, unknown>, ip: string) {
  rateLimit(`pair-redeem|${ip}`, 10, 10 * 60_000);
  rateLimit("pair-redeem", 30, 10 * 60_000);
  const code = normalizeCode(input.code);
  const name = cleanDeviceName(input.name);
  const platform = cleanPlatform(input.platform);
  const tokenHash = cleanTokenHash(input.tokenHash);
  const p = await prisma.devicePairing.findUnique({ where: { secretHash: sha256(code) } });
  if (!p || p.kind !== "code" || !p.userId) throw notFound("That code is wrong or has expired");
  if (p.consumedAt) {
    // A retry by the same app (same token commitment) gets the same device.
    if (tokenHash && p.tokenHash === tokenHash && p.deviceId) {
      const device = await prisma.device.findUnique({ where: { id: p.deviceId } });
      if (device) return pairedJson(device, null);
    }
    throw notFound("That code was already used");
  }
  if (p.expiresAt < new Date()) throw notFound("That code is wrong or has expired");
  const claimed = await prisma.devicePairing.updateMany({
    where: { id: p.id, consumedAt: null },
    data: { consumedAt: new Date(), deviceName: name, platform, requestIp: ip, tokenHash },
  });
  if (claimed.count === 0) throw notFound("That code was already used");
  const { device, token } = await issueDevice(p.userId, { name, platform, appVersion: cleanVersion(input.appVersion) }, ip, tokenHash);
  await prisma.devicePairing.update({ where: { id: p.id }, data: { deviceId: device.id } });
  return pairedJson(device, token);
}

// ─── management ──────────────────────────────────────────────────────────────

export async function removeDevice(actor: SessionUser, id: string) {
  const d = await prisma.device.findUnique({ where: { id } });
  if (!d || (d.userId !== actor.id && actor.role !== "OWNER")) throw notFound("Device not found");
  // Cascades to the app's browser session and its unfinished uploads.
  await prisma.device.delete({ where: { id } });
  forgetDeviceCache();
  await audit(actor.id, "DEVICE_REMOVED", { deviceId: d.id, name: d.name, ownerId: d.userId });
}

// ─── signing the app's embedded browser in ───────────────────────────────────

const webLogins = (g.__loomWebLogins ??= new Map());

/** A one-time, one-minute link that signs the app's web view in as the device's user. */
export function createWebLogin(device: Device): string {
  const now = Date.now();
  for (const [k, v] of webLogins) if (v.exp < now) webLogins.delete(k);
  const t = crypto.randomBytes(32).toString("base64url");
  webLogins.set(sha256(t), { deviceId: device.id, exp: now + WEB_LOGIN_TTL_MS });
  return t;
}

/**
 * Exchange a one-time link for a normal better-auth session cookie, tied to
 * the device (removing the device signs the web view out too). The device's
 * existing session is reused, so opening the app every day doesn't pile up
 * rows. The cookie is named, configured and signed exactly as better-auth
 * does it (better-call: `token.base64(HMAC-SHA256(secret, token))`), read
 * from auth.$context so it can't drift from lib/auth.ts; tests/api covers it.
 */
export async function consumeWebLogin(t: string, userAgent: string | null, ip: string): Promise<boolean> {
  const key = sha256(t);
  const entry = webLogins.get(key);
  webLogins.delete(key);
  if (!entry || entry.exp < Date.now()) return false;
  const device = await prisma.device.findUnique({ where: { id: entry.deviceId } });
  if (!device) return false;

  const ctx = await auth.$context;
  const expiresIn = ctx.sessionConfig.expiresIn; // seconds
  const minLeft = new Date(Date.now() + 24 * 3600_000);
  let session = await prisma.session.findFirst({
    where: { deviceId: device.id, userId: device.userId, expiresAt: { gt: minLeft } },
    orderBy: { expiresAt: "desc" },
  });
  if (!session) {
    session = await prisma.session.create({
      data: {
        userId: device.userId,
        deviceId: device.id,
        token: crypto.randomBytes(24).toString("base64url"),
        expiresAt: new Date(Date.now() + expiresIn * 1000),
        ipAddress: ip,
        userAgent: (userAgent ?? `Loom for ${device.platform}`).slice(0, 500),
      },
    });
    await audit(device.userId, "DEVICE_WEB_LOGIN", { deviceId: device.id });
  }
  const sig = crypto.createHmac("sha256", ctx.secret).update(session.token).digest("base64");
  const { name, attributes } = ctx.authCookies.sessionToken;
  (await cookies()).set(name, `${session.token}.${sig}`, {
    httpOnly: attributes.httpOnly ?? true,
    sameSite: "lax",
    secure: !!attributes.secure,
    path: attributes.path ?? "/",
    maxAge: Math.max(60, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000)),
  });
  return true;
}
