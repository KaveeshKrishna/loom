/**
 * client-info.ts — what the Loom apps need to know about this server
 * (GET /api/client/info).
 *
 * LAN access: with the optional loom-lan service (compose.yml, profile
 * "lan", set up by scripts/lan.sh), a small Caddy listens on the local
 * network with HTTPS from a private certificate authority. loom-web reads that
 * authority's public certificate from the read-only lan_public volume (never
 * its key) and hands it to signed-in apps together with the LAN address
 * (LOOM_LAN_HOST/LOOM_LAN_PORT, or LOOM_LAN_URL). Apps trust that CA for the LAN address only (pinned at
 * pairing, over the normal HTTPS address), so uploads at home skip the
 * internet round trip without trusting any certificate blindly.
 */

import crypto from "crypto";
import fs from "fs/promises";
import { prisma } from "./prisma";
import { UPLOAD_LIMITS } from "./uploads";
import type { SessionUser } from "./http";
import pkg from "@/package.json";

const INSTANCE_KEY = "instance_id";
// The LAN authority's public certificate, published by the loom-lan service
// into the read-only lan_public volume (scripts/lan.sh creates the authority).
const LAN_CA_PATH = process.env.LOOM_LAN_CA_PATH || "/lan-pki/root.crt";

/** LOOM_LAN_URL, or https://LOOM_LAN_HOST:LOOM_LAN_PORT. */
function lanUrl(): string | null {
  const explicit = process.env.LOOM_LAN_URL?.trim();
  if (explicit) return explicit;
  const host = process.env.LOOM_LAN_HOST?.trim();
  if (!host) return null;
  const port = parseInt(process.env.LOOM_LAN_PORT ?? "8443", 10) || 8443;
  return `https://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/** Bumped when the app-facing API changes incompatibly. */
export const API_VERSION = 1;

/** A random id for this Loom installation, created on first use. */
export async function instanceId(): Promise<string> {
  const row = await prisma.systemStatus.findUnique({ where: { key: INSTANCE_KEY } });
  if (row) return row.value;
  const id = crypto.randomUUID();
  await prisma.systemStatus.createMany({ data: [{ key: INSTANCE_KEY, value: id }], skipDuplicates: true });
  return (await prisma.systemStatus.findUniqueOrThrow({ where: { key: INSTANCE_KEY } })).value;
}

export interface LanInfo {
  url: string;
  /** PEM of the LAN certificate authority's root certificate */
  caPem: string;
  /** SHA-256 of the root certificate (DER), hex — for display/comparison */
  caSha256: string;
}

let lanCache: { at: number; value: LanInfo | null } | null = null;

/** LAN address + CA, or null when LAN access isn't set up. Cached for a minute. */
export async function lanInfo(): Promise<LanInfo | null> {
  const url = lanUrl();
  if (!url || !/^https:\/\/[^/\s]+\/?$/.test(url)) return null;
  if (lanCache && Date.now() - lanCache.at < 60_000) return lanCache.value;
  let value: LanInfo | null = null;
  try {
    const caPem = (await fs.readFile(LAN_CA_PATH, "utf8")).trim();
    const cert = new crypto.X509Certificate(caPem);
    value = {
      url: url.replace(/\/$/, ""),
      caPem,
      caSha256: crypto.createHash("sha256").update(cert.raw).digest("hex"),
    };
  } catch {
    value = null; // the lan service hasn't created its CA yet, or isn't running
  }
  lanCache = { at: Date.now(), value };
  return value;
}

export async function clientInfo(user: SessionUser | null) {
  return {
    product: "loom",
    version: pkg.version,
    apiVersion: API_VERSION,
    instanceId: await instanceId(),
    publicUrl: process.env.BETTER_AUTH_URL || null,
    capabilities: ["devices.v1", "pair.approve", "pair.code", "pair.tokenHash", "weblogin.v1", "upload.chunks.v1", "lan.v1"],
    upload: UPLOAD_LIMITS,
    // Only for signed-in callers: who they are, and the LAN address (a
    // private detail of the network) with its certificate authority.
    user: user ? { id: user.id, name: user.name, email: user.email, role: user.role } : null,
    deviceId: user?.deviceId ?? null,
    lan: user ? await lanInfo() : null,
  };
}
