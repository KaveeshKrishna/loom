/**
 * POST /api/devices/pair/poll { pairId, secret } — public.
 * → { status: "pending" } until the user answers, then
 *   { status: "approved", device, user } (+ `token` when the app didn't send a
 *   tokenHash; that answer comes only once). Declined: 403; expired or
 *   already used: 410 (with `status`).
 */
import { NextResponse } from "next/server";
import { route, readJson } from "@/lib/http";
import { pollPairing, clientIp } from "@/lib/devices";

export const POST = route(async (req) => {
  return NextResponse.json(await pollPairing(await readJson(req), clientIp(req.headers)));
});
