/**
 * GET  /api/setup — { needsSetup } (true only while no user exists)
 * POST /api/setup { name, email, password } — create the first account as Owner.
 *
 * SECURITY: unauthenticated by necessity, so it hard-refuses once any user
 * exists. The check and the insert run in one transaction holding a
 * Postgres advisory lock, so two simultaneous requests can't both succeed.
 */
import { NextResponse } from "next/server";
import { hashPassword } from "better-auth/crypto";
import { prisma } from "@/lib/prisma";
import { route, readJson, badRequest, HttpError } from "@/lib/http";

const SETUP_LOCK_KEY = 7_726_001; // arbitrary constant for pg_advisory_xact_lock

export const GET = route(async () => {
  const userCount = await prisma.user.count();
  return NextResponse.json({ needsSetup: userCount === 0 });
});

export const POST = route(async (req) => {
  const { name, email, password } = await readJson<Record<string, unknown>>(req);
  if (typeof name !== "string" || !name.trim()) throw badRequest("Name, email, and password are all required.");
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(email)) throw badRequest("A valid email is required.");
  if (typeof password !== "string" || password.length < 8) throw badRequest("Password must be at least 8 characters.");

  const hash = await hashPassword(password);
  const normalizedEmail = email.trim().toLowerCase();

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SETUP_LOCK_KEY})`;
    if ((await tx.user.count()) > 0) throw new HttpError(403, "Setup has already been completed.");
    const user = await tx.user.create({
      data: { name: name.trim(), email: normalizedEmail, password: hash, role: "OWNER" },
    });
    await tx.account.create({
      data: { accountId: user.id, providerId: "credential", userId: user.id, password: hash },
    });
    await tx.systemStatus.upsert({
      where: { key: "scanner_status" },
      update: {},
      create: { key: "scanner_status", value: "idle" },
    });
    await tx.auditLog.create({ data: { userId: user.id, action: "SETUP_COMPLETED", details: {} } });
  });

  return NextResponse.json({ success: true, owner: true });
});
