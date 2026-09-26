/**
 * GET /api/health
 *
 * Unauthenticated liveness/readiness probe. Used by the Docker Compose
 * healthcheck and by the install/update scripts to know when the app is
 * actually ready to serve traffic (not just that the process has started).
 *
 * Reveals only "database reachable or not" and the Loom version (the source
 * is public, so the version isn't a secret; the update script uses it to
 * confirm the new version is the one running).
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import pkg from "@/package.json";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", version: pkg.version }, { status: 200 });
  } catch {
    return NextResponse.json({ status: "unavailable", version: pkg.version }, { status: 503 });
  }
}
