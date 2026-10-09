/**
 * GET /api/client/info — for the Loom apps: server version, API version,
 * a stable instance id, capabilities and upload settings. Public, so an app
 * can check an address before pairing; signed-in callers (an app's device
 * token) also get the LAN address and its certificate authority.
 */
import { NextResponse } from "next/server";
import { route, getSessionUser } from "@/lib/http";
import { clientInfo } from "@/lib/client-info";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await getSessionUser();
  return NextResponse.json(await clientInfo(user), { headers: { "Cache-Control": "no-store" } });
});
