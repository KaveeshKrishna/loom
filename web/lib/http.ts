/**
 * http.ts
 *
 * Shared plumbing for API route handlers: who is calling, typed HTTP errors,
 * and one place that turns thrown errors into safe JSON responses.
 *
 *   export const POST = route(async (req) => {
 *     const user = await requireUser();
 *     ...
 *     return NextResponse.json({ ok: true });
 *   });
 *
 * Internal error details (absolute paths, stack traces, Prisma messages) are
 * logged server-side and never sent to the client.
 */

import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { Prisma, type Role } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PathSecurityError } from "@/lib/path-security";
import { FsLockError } from "@/lib/fs-locks";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: Record<string, unknown>
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const forbidden = (msg = "Access denied") => new HttpError(403, msg);
export const notFound = (msg = "Not found") => new HttpError(404, msg);
export const conflict = (msg: string, extra?: Record<string, unknown>) =>
  new HttpError(409, msg, extra);

/**
 * Returns the signed-in user with their role read fresh from the database
 * (never trusted from the session payload), or null.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) return null;
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, email: true, name: true, role: true },
  });
  return user;
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new HttpError(401, "Unauthorized");
  return user;
}

export async function requireOwner(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "OWNER") throw forbidden("Owner only");
  return user;
}

/** Map any thrown value to a JSON response without leaking internals. */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.message, ...err.extra }, { status: err.status });
  }
  if (err instanceof PathSecurityError) {
    console.warn("[api] path rejected:", err.message);
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }
  if (err instanceof FsLockError) {
    return NextResponse.json(
      { error: "That item is busy with another operation. Try again in a moment." },
      { status: 409 }
    );
  }
  if (err instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const code = (err as { code?: string })?.code;
  if (code === "ENOENT") return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (code === "EACCES" || code === "EPERM") {
    console.error("[api] filesystem permission error:", err);
    return NextResponse.json(
      { error: "Loom does not have permission to change this item on disk." },
      { status: 500 }
    );
  }
  if (code === "ENOSPC") {
    return NextResponse.json({ error: "The disk is full." }, { status: 507 });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  console.error("[api] unhandled error:", err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

type Handler<C> = (req: NextRequest, ctx: C) => Promise<Response>;

/** Wrap a route handler so every thrown error becomes a safe JSON response. */
export function route<C = unknown>(handler: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** Parse a JSON body, turning malformed input into a 400. */
export async function readJson<T = Record<string, unknown>>(req: NextRequest): Promise<T> {
  try {
    const body = await req.json();
    if (body === null || typeof body !== "object") throw badRequest("Expected a JSON object");
    return body as T;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw badRequest("Invalid JSON body");
  }
}

/** Parse a positive integer query param with bounds (NaN-safe). */
export function intParam(value: string | null, fallback: number, min: number, max: number): number {
  const n = value == null ? NaN : parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** JSON.stringify replacer-based serialization that turns BigInt into strings. */
export function toJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
