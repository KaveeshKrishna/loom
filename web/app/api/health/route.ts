/**
 * GET /api/health
 *
 * Unauthenticated liveness/readiness probe. Used by the Docker Compose
 * healthcheck and by the install/update scripts to know when the app is
 * actually ready to serve traffic (not just that the process has started).
 *
 * Reveals only "database reachable or not", the Loom version (the source
 * is public, so the version isn't a secret; the update script uses it to
 * confirm the new version is the one running) and the build id (a hash of
 * the code; open pages reload themselves when it changes).
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import pkg from "@/package.json";

export const dynamic = "force-dynamic";

const BUILD = process.env.NEXT_PUBLIC_LOOM_BUILD ?? "dev";
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", version: pkg.version, build: BUILD }, { status: 200, headers: NO_STORE });
  } catch {
    return NextResponse.json({ status: "unavailable", version: pkg.version, build: BUILD }, { status: 503, headers: NO_STORE });
  }
}
