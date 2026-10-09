/**
 * POST /api/devices/codes — a one-time pairing code (10 minutes) for adding
 * an app; the Devices page shows it as a QR code. Needs a browser sign-in:
 * an app can't mint codes for more apps.
 */
import { NextResponse } from "next/server";
import { route, requireBrowserUser } from "@/lib/http";
import { createPairingCode } from "@/lib/devices";

export const POST = route(async () => {
  const user = await requireBrowserUser();
  return NextResponse.json(await createPairingCode(user), { status: 201 });
});
