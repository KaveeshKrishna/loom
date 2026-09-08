/**
 * POST /api/setup
 *
 * Creates the first user account and promotes it to OWNER. This replaces
 * the old build-time `prisma/seed.ts` script, which required OWNER_EMAIL /
 * OWNER_PASSWORD in .env and couldn't run reliably at image-build time.
 *
 * SECURITY: this endpoint is intentionally unauthenticated (there is no one
 * to authenticate as on a fresh install) but MUST hard-refuse once any user
 * exists — otherwise it is a permanent unauthenticated privilege-escalation
 * endpoint. That check is the authoritative guard; the /setup page's own
 * redirect is a convenience, not the security boundary.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const userCount = await prisma.user.count();
  return NextResponse.json({ needsSetup: userCount === 0 });
}

export async function POST(req: NextRequest) {
  const userCount = await prisma.user.count();
  if (userCount > 0) {
    return NextResponse.json(
      { error: "Setup has already been completed." },
      { status: 403 }
    );
  }

  const { name, email, password } = await req.json();

  if (!name || !email || !password) {
    return NextResponse.json(
      { error: "Name, email, and password are all required." },
      { status: 400 }
    );
  }
  if (typeof password !== "string" || password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters." },
      { status: 400 }
    );
  }

  try {
    await auth.api.signUpEmail({ body: { email, password, name } });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create account." },
      { status: 400 }
    );
  }

  // Re-check under a race: if two setup requests land concurrently, only
  // the first should end up as OWNER. Recount before promoting.
  const recount = await prisma.user.count();
  if (recount > 1) {
    // Someone else's request created the owner first; leave this new user
    // as FAMILY rather than granting two owners.
    return NextResponse.json({ success: true, owner: false });
  }

  await prisma.user.update({
    where: { email },
    data: { role: "OWNER" },
  });

  await prisma.systemStatus.upsert({
    where: { key: "scanner_status" },
    update: {},
    create: { key: "scanner_status", value: "idle" },
  });

  return NextResponse.json({ success: true, owner: true });
}
