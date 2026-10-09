/**
 * POST /api/devices/web-login — for a paired app: a one-time link (valid one
 *   minute) that signs the app's embedded browser in → { path }.
 * GET  /api/devices/web-login?t=…&next=/files — opened in that browser: sets
 *   a normal session cookie (tied to the device) and redirects to `next` (a
 *   path on this site). An invalid or used link goes to the sign-in page.
 *   Refused when another site started the navigation (login CSRF).
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, requireDevice, forbidden } from "@/lib/http";
import { createWebLogin, consumeWebLogin, clientIp, rateLimit } from "@/lib/devices";

export const POST = route(async () => {
  const user = await requireDevice();
  rateLimit(`web-login|${user.deviceId}`, 30, 10 * 60_000);
  const device = await prisma.device.findUniqueOrThrow({ where: { id: user.deviceId } });
  return NextResponse.json({ path: `/api/devices/web-login?t=${createWebLogin(device)}` });
});

function safeNext(v: string | null): string {
  return v && /^\/(?![/\\])[\x21-\x7e]*$/.test(v) ? v : "/files";
}

export const GET = route(async (req) => {
  const site = req.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") throw forbidden("Open this link from the Loom app");
  const ip = clientIp(req.headers);
  rateLimit(`web-login|${ip}`, 30, 10 * 60_000);
  const t = req.nextUrl.searchParams.get("t") ?? "";
  const ok = t.length > 20 && (await consumeWebLogin(t, req.headers.get("user-agent"), ip));
  const base = process.env.BETTER_AUTH_URL || req.nextUrl.origin;
  const to = ok ? safeNext(req.nextUrl.searchParams.get("next")) : "/login";
  const res = NextResponse.redirect(new URL(to, base), 303);
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
});
