/**
 * POST /api/devices/pair/redeem { code, name, platform, appVersion?, tokenHash? }
 * — public. Redeem a code from the Devices page (QR) → { device, user } (+
 * `token` without tokenHash). Single use, 10 minutes, rate-limited. With a
 * tokenHash, retrying the same code returns the same device.
 */
import { NextResponse } from "next/server";
import { route, readJson } from "@/lib/http";
import { redeemPairingCode, clientIp } from "@/lib/devices";

export const POST = route(async (req) => {
  return NextResponse.json(await redeemPairingCode(await readJson(req), clientIp(req.headers)), { status: 201 });
});
