/**
 * GET    /api/upload/sessions/:id              → { received, size, ... } (resume point)
 * PUT    /api/upload/sessions/:id?offset=N[&final=1]
 *        body: raw bytes (application/octet-stream), at most chunkSize
 *        header X-Chunk-SHA256: hex digest of the chunk (recommended)
 *        → { received } or, with final=1 on the last chunk, the finished file
 * DELETE /api/upload/sessions/:id              → cancel and discard
 */
import { NextResponse } from "next/server";
import { route, requireUser, badRequest } from "@/lib/http";
import { getOwnSession, writeChunk, finalizeUpload, cancelUpload, sessionJson } from "@/lib/uploads";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const session = await getOwnSession(user, (await params).id);
  return NextResponse.json(sessionJson(session));
});

export const PUT = route<Ctx>(async (req, { params }) => {
  const user = await requireUser();
  const session = await getOwnSession(user, (await params).id);
  const offset = Number(req.nextUrl.searchParams.get("offset"));
  if (!Number.isSafeInteger(offset) || offset < 0) throw badRequest("Invalid offset");
  const sha = req.headers.get("x-chunk-sha256");
  if (sha && !/^[a-f0-9]{64}$/i.test(sha)) throw badRequest("Invalid X-Chunk-SHA256");
  const lenHeader = req.headers.get("content-length");
  const contentLength = lenHeader != null && /^\d+$/.test(lenHeader) ? Number(lenHeader) : null;

  const received = await writeChunk(session, offset, req.body, sha, contentLength, req.signal);

  if (req.nextUrl.searchParams.get("final") === "1" && received === Number(session.size)) {
    return NextResponse.json(await finalizeUpload(user, session));
  }
  return NextResponse.json({ received });
});

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const session = await getOwnSession(user, (await params).id);
  await cancelUpload(session);
  return NextResponse.json({ success: true });
});
