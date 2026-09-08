/**
 * GET /api/health
 *
 * Unauthenticated liveness/readiness probe. Used by the Docker Compose
 * healthcheck and by installer scripts to know when the app is actually
 * ready to serve traffic (not just that the process has started).
 *
 * Intentionally does not require a session or leak any details beyond
 * "database reachable or not" — this endpoint is reachable pre-auth.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok" }, { status: 200 });
  } catch {
    return NextResponse.json({ status: "unavailable" }, { status: 503 });
  }
}
