/**
 * POST /api/upload/sessions
 *   { destDir, relativePath, size, lastModified?, mimeType? }
 *   → { id, chunkSize, received }
 *
 * GET /api/upload/sessions — the caller's unfinished uploads (for resuming).
 *
 * DELETE /api/upload/sessions?stale=1 — discard unfinished uploads nobody
 *   has touched for 10 minutes (the Owner: everyone's; others: their own),
 *   freeing their disk space now instead of after 24 hours.
 *
 * See lib/uploads.ts for the whole protocol.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, requireUser, readJson, badRequest } from "@/lib/http";
import { createUploadSession, sessionJson, cancelUpload } from "@/lib/uploads";

export const POST = route(async (req) => {
  const user = await requireUser();
  const body = await readJson(req);
  const session = await createUploadSession(user, body);
  return NextResponse.json(sessionJson(session), { status: 201 });
});

export const GET = route(async () => {
  const user = await requireUser();
  const sessions = await prisma.uploadSession.findMany({
    where: { userId: user.id, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  return NextResponse.json({ sessions: sessions.map(sessionJson) });
});

export const DELETE = route(async (req) => {
  const user = await requireUser();
  if (req.nextUrl.searchParams.get("stale") !== "1") throw badRequest("Pass stale=1");
  const sessions = await prisma.uploadSession.findMany({
    where: {
      updatedAt: { lt: new Date(Date.now() - 10 * 60_000) },
      ...(user.role === "OWNER" ? {} : { userId: user.id }),
    },
  });
  let bytes = 0;
  for (const s of sessions) {
    bytes += Number(s.received);
    await cancelUpload(s);
  }
  return NextResponse.json({ removed: sessions.length, bytes });
});
