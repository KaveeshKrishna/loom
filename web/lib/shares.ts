/**
 * shares.ts — public share links.
 *
 * Security model:
 *  - Sharing is off until the Owner enables it (Settings → Sharing).
 *  - Tokens are 32 random bytes (base64url). Only SHA-256(token) is used for
 *    lookup; an AES-256-GCM encrypted copy (key derived from
 *    BETTER_AUTH_SECRET with HKDF) lets the creator copy the link again.
 *  - A password-protected link must be unlocked first; unlocking sets a
 *    short-lived HMAC-signed cookie scoped to that link. Unlock attempts are
 *    rate-limited per IP and link.
 *  - Every request re-checks: link not revoked or expired, item not in
 *    Trash, sharing still enabled, and the creator still allowed to read the
 *    whole shared tree. Paths inside a shared folder are confined to it.
 */

import crypto from "crypto";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import type { ShareLink, FileNode } from "@prisma/client";
import { prisma } from "./prisma";
import { getAcl } from "./acl";
import { normalizeRelPath, joinRel, isSameOrDescendant } from "./fs-guard";
import { HttpError, notFound, forbidden } from "./http";

const SHARING_KEY = "sharing_enabled";
const UNLOCK_TTL_S = 12 * 60 * 60;

function secret(): Buffer {
  return Buffer.from(process.env.BETTER_AUTH_SECRET || "development-only-secret-do-not-use-in-production-000");
}

function key(purpose: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", secret(), Buffer.from("loom-share"), Buffer.from(purpose), 32));
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function encryptToken(token: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key("token-enc"), iv);
  const enc = Buffer.concat([c.update(token, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}

export function decryptToken(blob: string | null): string | null {
  if (!blob) return null;
  try {
    const [iv, tag, enc] = blob.split(".").map((p) => Buffer.from(p, "base64url"));
    const d = crypto.createDecipheriv("aes-256-gcm", key("token-enc"), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  } catch {
    return null; // e.g. the auth secret changed; the link still works, it just can't be shown again
  }
}

export async function hashSharePassword(pw: string) {
  return bcrypt.hash(pw, 10);
}

// ─── settings ────────────────────────────────────────────────────────────────

export async function isSharingEnabled(): Promise<boolean> {
  const row = await prisma.systemStatus.findUnique({ where: { key: SHARING_KEY } });
  return row?.value === "true";
}

export async function setSharingEnabled(on: boolean) {
  await prisma.systemStatus.upsert({
    where: { key: SHARING_KEY },
    update: { value: on ? "true" : "false" },
    create: { key: SHARING_KEY, value: on ? "true" : "false" },
  });
}

// ─── unlock cookies ─────────────────────────────────────────────────────────

const cookieName = (linkId: string) => `loom_share_${linkId}`;

function sign(linkId: string, exp: number): string {
  return crypto.createHmac("sha256", key("unlock-cookie")).update(`${linkId}.${exp}`).digest("base64url");
}

export async function setUnlockCookie(link: Pick<ShareLink, "id">) {
  const exp = Math.floor(Date.now() / 1000) + UNLOCK_TTL_S;
  (await cookies()).set(cookieName(link.id), `${exp}.${sign(link.id, exp)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && (process.env.BETTER_AUTH_URL ?? "").startsWith("https://"),
    path: "/",
    maxAge: UNLOCK_TTL_S,
  });
}

async function isUnlocked(link: Pick<ShareLink, "id">): Promise<boolean> {
  const v = (await cookies()).get(cookieName(link.id))?.value;
  if (!v) return false;
  const [expS, sig] = v.split(".");
  const exp = Number(expS);
  if (!Number.isFinite(exp) || exp < Date.now() / 1000 || !sig) return false;
  const expected = sign(link.id, exp);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ─── rate limiting for password attempts ─────────────────────────────────────

const g = globalThis as unknown as { __loomShareAttempts?: Map<string, { n: number; reset: number }> };
const attempts = (g.__loomShareAttempts ??= new Map());

export function checkUnlockRate(ip: string, linkId: string) {
  const k = `${ip}|${linkId}`;
  const now = Date.now();
  const cur = attempts.get(k);
  if (!cur || cur.reset < now) {
    attempts.set(k, { n: 1, reset: now + 10 * 60_000 });
    return;
  }
  if (++cur.n > 10) throw new HttpError(429, "Too many attempts. Try again in a few minutes.");
}

export async function verifySharePassword(link: ShareLink, password: string): Promise<boolean> {
  if (!link.passwordHash) return true;
  return bcrypt.compare(password, link.passwordHash);
}

// ─── resolving a link ────────────────────────────────────────────────────────

export interface ResolvedShare {
  link: ShareLink;
  root: FileNode;
  locked: boolean;
}

/**
 * Find a usable link by token. Throws 404 for anything that shouldn't be
 * visible (unknown, revoked, expired, trashed, sharing disabled, creator lost
 * access) so a link's existence isn't leaked.
 */
export async function resolveShare(token: string): Promise<ResolvedShare> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw notFound("This link doesn't exist or has expired");
  const link = await prisma.shareLink.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { fileNode: true, createdBy: { select: { id: true, role: true } } },
  });
  const gone = notFound("This link doesn't exist or has expired");
  if (!link || link.revokedAt || (link.expiresAt && link.expiresAt < new Date())) throw gone;
  if (!link.fileNode || link.fileNode.inTrash) throw gone;
  if (!(await isSharingEnabled())) throw gone;
  const acl = await getAcl(link.createdBy);
  if (!acl.canAccessTree(link.fileNode.relativePath)) throw gone;
  const locked = !!link.passwordHash && !(await isUnlocked(link));
  return { link, root: link.fileNode, locked };
}

export async function requireUnlockedShare(token: string): Promise<ResolvedShare> {
  const r = await resolveShare(token);
  if (r.locked) throw new HttpError(401, "This link is password protected");
  return r;
}

/** Map a path inside the share (relative to the shared item) to a media path, confined to it. */
export function sharedPath(root: FileNode, sub: unknown): string {
  const rel = normalizeRelPath(sub);
  if (!rel) return root.relativePath;
  if (root.type !== "DIRECTORY") throw forbidden();
  const full = joinRel(root.relativePath, rel);
  if (!isSameOrDescendant(full, root.relativePath)) throw forbidden();
  return full;
}

/** Path of `full` relative to the shared root ("" = the root itself). */
export function relativeToShare(root: FileNode, full: string): string {
  return full === root.relativePath ? "" : full.slice(root.relativePath.length + 1);
}

export async function recordShareAccess(linkId: string) {
  await prisma.shareLink
    .update({ where: { id: linkId }, data: { accessCount: { increment: 1 }, lastAccessedAt: new Date() } })
    .catch(() => {});
}

export function shareUrl(token: string): string {
  const base = (process.env.BETTER_AUTH_URL || "").replace(/\/+$/, "");
  return `${base}/s/${token}`;
}
