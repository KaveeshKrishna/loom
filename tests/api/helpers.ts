/**
 * Helpers for the API integration tests (tests/README.md). They talk to the
 * disposable Loom from tests/stack/ over HTTP, read its media folder
 * directly, and use its database for things the API can't do (time travel).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { execFileSync } from "node:child_process";
import pg from "pg";

export const BASE = process.env.LOOM_TEST_URL ?? `http://localhost:${process.env.LOOM_TEST_PORT ?? 18085}`;
export const LAN_BASE = `https://127.0.0.1:${process.env.LOOM_TEST_LAN_PORT ?? 18443}`;
export const TEST_DIR = process.env.LOOM_TEST_DIR ?? path.join(process.env.HOME ?? "/root", ".cache/loomtest");
export const MEDIA = path.join(TEST_DIR, "media");
export const LAN_CA = path.join(TEST_DIR, "lan-pki/public/root.crt");
export const OWNER = { name: "Test Owner", email: "owner@loom.test", password: "owner-password-123" };

export const sha256 = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
export const randomBytes = (n: number) => crypto.randomBytes(n);
export const uniq = (p: string) => `${p}-${crypto.randomBytes(4).toString("hex")}`;

// ─── HTTP ────────────────────────────────────────────────────────────────────

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

/** A caller: a browser (cookie), an app (bearer) or anonymous. Each gets its own client IP. */
export class Client {
  cookie = "";
  token: string | null;
  ip: string;
  constructor(token: string | null = null, ip = `10.9.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`) {
    this.token = token;
    this.ip = ip;
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { "x-forwarded-for": this.ip, ...extra };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    if (this.cookie) h.cookie = this.cookie;
    return h;
  }

  async raw(method: string, url: string, init: { body?: BodyInit | null; headers?: Record<string, string>; redirect?: RequestRedirect } = {}) {
    return fetch(url.startsWith("http") ? url : BASE + url, {
      method,
      body: init.body ?? null,
      headers: this.headers(init.headers),
      redirect: init.redirect ?? "manual",
      // @ts-expect-error Node's fetch needs this for streamed bodies
      duplex: "half",
    });
  }

  async req<T = any>(method: string, url: string, json?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
    const res = await this.raw(method, url, {
      body: json === undefined ? null : JSON.stringify(json),
      headers: json === undefined ? headers : { "content-type": "application/json", ...headers },
    });
    const text = await res.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, body, headers: res.headers };
  }

  get = <T = any>(url: string) => this.req<T>("GET", url);
  post = <T = any>(url: string, json?: unknown) => this.req<T>("POST", url, json ?? {});
  patch = <T = any>(url: string, json?: unknown) => this.req<T>("PATCH", url, json ?? {});
  del = <T = any>(url: string) => this.req<T>("DELETE", url);
}

/** Collect Set-Cookie name=value pairs into a Cookie header. */
export function cookieHeader(res: Response | Headers): string {
  const h = res instanceof Headers ? res : res.headers;
  return h
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

// ─── accounts ────────────────────────────────────────────────────────────────

/** Sign in through better-auth like the login page does. */
export async function signIn(email: string, password: string): Promise<Client> {
  const c = new Client();
  const res = await c.raw("POST", "/api/auth/sign-in/email", {
    body: JSON.stringify({ email, password }),
    headers: { "content-type": "application/json", origin: BASE },
  });
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  c.cookie = cookieHeader(res);
  return c;
}

let ownerClient: Client | null = null;

/** The Owner, created through first-run setup on a fresh stack. */
export async function owner(): Promise<Client> {
  if (ownerClient) return ownerClient;
  const anon = new Client();
  const setup = await anon.get("/api/setup");
  if (setup.body?.needsSetup) {
    const r = await anon.post("/api/setup", OWNER);
    if (r.status !== 200) throw new Error(`setup failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  ownerClient = await signIn(OWNER.email, OWNER.password);
  return ownerClient;
}

/** A Family user (created by the Owner), signed in. */
export async function familyUser(name = uniq("family")): Promise<{ client: Client; id: string; email: string; password: string }> {
  const o = await owner();
  const email = `${name}@loom.test`;
  const password = "family-password-123";
  const r = await o.post("/api/users", { name, email, password, role: "FAMILY" });
  if (r.status !== 200 && r.status !== 201) throw new Error(`create user failed: ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.user?.id ?? r.body.id;
  return { client: await signIn(email, password), id, email, password };
}

/**
 * Pair an app for `user` with a QR code. With `commit` (default) the app
 * generates the token and only sends its hash, as the real apps do.
 */
export async function pairApp(
  user: Client,
  opts: { name?: string; platform?: string; commit?: boolean } = {}
): Promise<{ app: Client; token: string; deviceId: string }> {
  const code = await user.post("/api/devices/codes");
  if (code.status !== 201) throw new Error(`code failed: ${code.status} ${JSON.stringify(code.body)}`);
  const anon = new Client();
  const commit = opts.commit ?? true;
  const token = commit ? `loomd_${crypto.randomBytes(32).toString("base64url")}` : null;
  const r = await anon.post("/api/devices/pair/redeem", {
    code: code.body.code,
    name: opts.name ?? uniq("Test PC"),
    platform: opts.platform ?? "windows",
    appVersion: "0.0.1-test",
    ...(token ? { tokenHash: sha256(token) } : {}),
  });
  if (r.status !== 201) throw new Error(`redeem failed: ${r.status} ${JSON.stringify(r.body)}`);
  const t = token ?? r.body.token;
  return { app: new Client(t), token: t, deviceId: r.body.device.id };
}

const shared = new Map<Client, Promise<{ app: Client; token: string; deviceId: string }>>();

/**
 * One app paired for `user`, reused across tests that don't remove it
 * (pairing is rate-limited on the server, as it should be).
 */
export function sharedApp(user: Client) {
  if (!shared.has(user)) shared.set(user, pairApp(user, { name: "Shared test app" }));
  return shared.get(user)!;
}

// ─── the stack itself ────────────────────────────────────────────────────────

/** docker compose … on the test stack (restart a service, run housekeeping). */
export function compose(...args: string[]): string {
  return execFileSync(
    "docker",
    ["compose", "-p", "loomtest", "-f", path.join(import.meta.dirname, "../stack/compose.yml"), ...args],
    { env: { ...process.env, LOOM_TEST_DIR: TEST_DIR }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
}

/** Run the scanner's hourly housekeeping now. */
export function runMaintenance() {
  return compose("exec", "-T", "loom-scanner", "npx", "tsx", "-e", "import('./src/maintenance.ts').then((m) => m.runMaintenance()).then(() => process.exit(0))");
}

/** Wait until loom-web answers again (after a restart). */
export async function waitHealthy(timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("loom-web didn't come back");
}

// ─── database ────────────────────────────────────────────────────────────────

let pool: pg.Pool | null = null;

export async function sql<T = any>(text: string, values: unknown[] = []): Promise<T[]> {
  pool ??= new pg.Pool({
    connectionString: `postgresql://loom:loomtest@127.0.0.1:${process.env.LOOM_TEST_PG_PORT ?? 18432}/loom`,
    max: 2,
  });
  return (await pool.query(text, values)).rows as T[];
}

export async function closeDb() {
  await pool?.end();
  pool = null;
}

// ─── media folder ────────────────────────────────────────────────────────────

/** A fresh, empty folder for one test, created through the API. */
export async function freshFolder(c: Client, name = uniq("t")): Promise<string> {
  const r = await c.post("/api/fs/mkdir", { parentPath: "", name });
  if (r.status !== 200 && r.status !== 201) throw new Error(`mkdir failed: ${r.status} ${JSON.stringify(r.body)}`);
  return name;
}

export const mediaFile = (rel: string) => fs.readFileSync(path.join(MEDIA, rel));
export const mediaExists = (rel: string) => fs.existsSync(path.join(MEDIA, rel));
export const mediaList = (rel: string) => fs.readdirSync(path.join(MEDIA, rel)).sort();

// ─── uploads ─────────────────────────────────────────────────────────────────

/** PUT a binary body (req() sends JSON). */
export async function putBytes(c: Client, url: string, data: Buffer, headers: Record<string, string> = {}): Promise<Res> {
  const res = await c.raw("PUT", url, {
    body: data,
    headers: { "content-type": "application/octet-stream", "content-length": String(data.length), ...headers },
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, body, headers: res.headers };
}

export function chunkPut(c: Client, id: string, index: number, data: Buffer, sha: string | null = sha256(data)) {
  return putBytes(c, `/api/upload/sessions/${id}?chunk=${index}`, data, sha ? { "x-chunk-sha256": sha } : {});
}

export function splitChunks(data: Buffer, size: number): Buffer[] {
  const out: Buffer[] = [];
  for (let o = 0; o < data.length; o += size) out.push(data.subarray(o, o + size));
  return out;
}

/** HTTPS request to the LAN listener, trusting only the test CA. */
export function lanRequest(
  method: string,
  urlPath: string,
  opts: { token?: string; cookie?: string; body?: Buffer; ca?: string | null; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: any; headers: Record<string, string | string[] | undefined>; cert: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(LAN_BASE + urlPath);
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.body) headers["content-length"] = String(opts.body.length);
    const req = https.request(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers,
        ca: opts.ca === null ? undefined : opts.ca ?? fs.readFileSync(LAN_CA, "utf8"),
        rejectUnauthorized: true,
      },
      (res) => {
        const cert = (res.socket as any)?.getPeerCertificate?.(true);
        const chunks: Buffer[] = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: any = text;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers, cert });
        });
      }
    );
    req.on("error", reject);
    if (opts.body) req.end(opts.body);
    else req.end();
  });
}
