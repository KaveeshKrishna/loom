/**
 * GET    /api/upload/sessions/:id              → { received, size, ... } (resume point)
 * PUT    /api/upload/sessions/:id?offset=N[&final=1[&conflict=replace|keep_both]]
 *        body: raw bytes (application/octet-stream), at most chunkSize
 *        header X-Chunk-SHA256: hex digest of the chunk (recommended)
 *        → { received } or, with final=1 on the last chunk, the finished file.
 *        conflict says what to do if a file with that name already exists:
 *        keep_both (default: the upload gets a numbered name) or replace
 *        (the existing file goes to Trash).
 * PUT    /api/upload/sessions/:id?chunk=N      (mode "chunks", the apps)
 *        body: exactly chunk N's bytes; chunks in any order, several at once
 *        → { received, missing } (missing = how many chunks are still to come)
 *        Finalize with POST .../complete once nothing is missing.
 * DELETE /api/upload/sessions/:id              → cancel and discard
 */
import { NextResponse } from "next/server";
import { route, requireUser, badRequest } from "@/lib/http";
import { getOwnSession, writeChunk, writeChunkAt, finalizeUpload, cancelUpload, sessionJson, parseUploadConflict } from "@/lib/uploads";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const session = await getOwnSession(user, (await params).id);
  return NextResponse.json(sessionJson(session));
});

export const PUT = route<Ctx>(async (req, { params }) => {
  const user = await requireUser();
  const session = await getOwnSession(user, (await params).id);
  const sha = req.headers.get("x-chunk-sha256");
  if (sha && !/^[a-f0-9]{64}$/i.test(sha)) throw badRequest("Invalid X-Chunk-SHA256");
  const lenHeader = req.headers.get("content-length");
  const contentLength = lenHeader != null && /^\d+$/.test(lenHeader) ? Number(lenHeader) : null;

  const chunk = req.nextUrl.searchParams.get("chunk");
  if (chunk !== null) {
    const index = /^\d+$/.test(chunk) ? Number(chunk) : NaN;
    return NextResponse.json(await writeChunkAt(user, session, index, req.body, sha, contentLength, req.signal));
  }

  const offset = Number(req.nextUrl.searchParams.get("offset"));
  if (!Number.isSafeInteger(offset) || offset < 0) throw badRequest("Invalid offset");

  const received = await writeChunk(session, offset, req.body, sha, contentLength, req.signal);

  if (req.nextUrl.searchParams.get("final") === "1" && received === Number(session.size)) {
    return NextResponse.json(await finalizeUpload(user, session, parseUploadConflict(req.nextUrl.searchParams.get("conflict"))));
  }
  return NextResponse.json({ received });
});

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const session = await getOwnSession(user, (await params).id);
  await cancelUpload(session);
  return NextResponse.json({ success: true });
});
