/**
 * POST /api/devices/pair/start { name, platform, appVersion?, tokenHash? } — public.
 * An app asks to be paired. → { pairId, secret, checkCode, approvePath,
 * expiresAt, pollInterval }. The app opens approvePath for the user, shows
 * checkCode, and polls /api/devices/pair/poll. tokenHash = SHA-256 (hex) of a
 * token the app generated itself (recommended, see lib/devices.ts).
 * Rate-limited.
 */
import { NextResponse } from "next/server";
import { route, readJson } from "@/lib/http";
import { startPairing, clientIp } from "@/lib/devices";

export const POST = route(async (req) => {
  return NextResponse.json(await startPairing(await readJson(req), clientIp(req.headers)), { status: 201 });
});
