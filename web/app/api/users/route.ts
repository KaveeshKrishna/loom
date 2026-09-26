/**
 * GET  /api/users — list users (Owner only)
 * POST /api/users { name, email, password, role } — create a user (Owner only).
 * Public sign-up is disabled; this is the only way new accounts are made.
 */
import { NextResponse } from "next/server";
import { hashPassword } from "better-auth/crypto";
import { prisma } from "@/lib/prisma";
import { route, requireOwner, readJson, badRequest, conflict } from "@/lib/http";

export const GET = route(async () => {
  await requireOwner();
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, role: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ users });
});

export const POST = route(async (req) => {
  const owner = await requireOwner();
  const { name, email, password, role } = await readJson<Record<string, unknown>>(req);
  if (typeof name !== "string" || !name.trim()) throw badRequest("Name is required");
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(email)) throw badRequest("A valid email is required");
  if (typeof password !== "string" || password.length < 8) throw badRequest("Password must be at least 8 characters");
  const normalizedEmail = email.trim().toLowerCase();

  if (await prisma.user.findUnique({ where: { email: normalizedEmail } })) throw conflict("Email already in use");

  // Better Auth's own hashPassword, so its sign-in verification accepts it.
  const hash = await hashPassword(password);
  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: { name: name.trim(), email: normalizedEmail, password: hash, role: role === "OWNER" ? "OWNER" : "FAMILY" },
      select: { id: true, name: true, email: true, role: true, createdAt: true },
    });
    await tx.account.create({
      data: { accountId: u.id, providerId: "credential", userId: u.id, password: hash },
    });
    await tx.auditLog.create({
      data: { userId: owner.id, action: "USER_CREATED", details: { targetEmail: normalizedEmail, role: u.role } },
    });
    return u;
  });
  return NextResponse.json({ user });
});
