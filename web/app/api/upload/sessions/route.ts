/**
 * POST /api/upload/sessions
 *   { destDir, relativePath, size, lastModified?, mimeType? }
 *   → { id, chunkSize, received }
 *
 * GET /api/upload/sessions — the caller's unfinished uploads (for resuming).
 *
 * See lib/uploads.ts for the whole protocol.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, requireUser, readJson } from "@/lib/http";
import { createUploadSession, sessionJson } from "@/lib/uploads";

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
