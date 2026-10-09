/**
 * POST /api/upload/sessions
 *   { destDir, relativePath, size, lastModified?, mimeType?, mode?, clientRef? }
 *   → { id, chunkSize, received, … }
 *   mode "chunks" (the apps) accepts numbered chunks in any order; clientRef
 *   makes a retried create return the same session. See lib/uploads.ts.
 *
 * GET /api/upload/sessions — the caller's unfinished uploads (for resuming):
 *   a browser sees the browser's, an app sees its own.
 *
 * DELETE /api/upload/sessions?stale=1 — discard unfinished uploads nobody
 *   has touched for 10 minutes (the Owner: everyone's; others: their own),
 *   freeing their disk space now instead of after 24 hours. Uploads the apps
 *   started are left alone: they may just be paused, and the app manages them.
 *
 * See lib/uploads.ts for the whole protocol.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, requireUser, readJson, badRequest } from "@/lib/http";
import { createUploadSession, sessionJson, cancelUpload, UNFINISHED } from "@/lib/uploads";

export const POST = route(async (req) => {
  const user = await requireUser();
  const body = await readJson(req);
  const session = await createUploadSession(user, body);
  return NextResponse.json(sessionJson(session), { status: 201 });
});

export const GET = route(async () => {
  const user = await requireUser();
  const sessions = await prisma.uploadSession.findMany({
    where: { userId: user.id, deviceId: user.deviceId ?? null, expiresAt: { gt: new Date() }, ...UNFINISHED },
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
      deviceId: null,
      ...UNFINISHED,
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
