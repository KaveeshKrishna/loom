/**
 * uploads.ts — chunked, resumable, integrity-checked uploads.
 *
 * Flow (see docs/ARCHITECTURE.md → Uploads):
 *   1. POST /api/upload/sessions          → create a session + empty .partial file
 *   2. PUT  /api/upload/sessions/:id?offset=N   (raw bytes, ≤ chunk size)
 *        - streamed straight to disk with backpressure (never buffered in RAM)
 *        - optional X-Chunk-SHA256 is verified; on mismatch the chunk is
 *          discarded (file truncated back) and the client re-sends it
 *        - the chunk is flushed to disk (fdatasync) before it is acknowledged
 *   3. The last chunk carries ?final=1 (or POST .../complete) and finalizes:
 *        - the name is reserved atomically (O_EXCL), then the finished file
 *          is renamed into place — it never overwrites anything
 *        - the index is updated and a background PROCESS_FILE job is queued
 *          for thumbnails/previews/probing
 *        - the request returns immediately; processing never delays it
 *
 * The file only appears in /media once every byte has arrived and been
 * verified. The scanner never looks inside .tmp-upload.
 *
 * The apps use mode "chunks" instead (POST with { mode: "chunks" }):
 *   - PUT /api/upload/sessions/:id?chunk=N sends chunk N (exactly chunkSize
 *     bytes, the last one shorter, with its X-Chunk-SHA256) out of order and
 *     several at once; each is written at its own position, flushed, then
 *     marked in a bitmap
 *   - "out of order" is bounded by a write window: a chunk may start at most
 *     LOOM_UPLOAD_WINDOW_MB past the first missing one. Filesystems without
 *     sparse files (exFAT, common on external drives) fill any gap with zeros
 *     on the spot, so a far-ahead chunk would mean gigabytes of extra writes
 *   - GET /api/upload/sessions/:id lists the chunks still `missing`
 *   - POST .../complete finalizes once all are there; repeating it returns
 *     the same result (kept for a day), so a lost response is harmless
 *   - sessions created with a device token stay resumable for
 *     LOOM_UPLOAD_RESUME_DAYS (default 7) instead of 24 hours
 */

import fs from "fs/promises";
import { createWriteStream } from "fs";
import path from "path";
import { createHash } from "crypto";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { Prisma, type UploadSession } from "@prisma/client";
import { prisma } from "./prisma";
import { UPLOAD_TEMP_DIR, MEDIA_ROOT } from "./path-security";
import { initFs } from "./fs-operations";
import { getAcl } from "./acl";
import {
  normalizeRelPath,
  validateRelativeFilePath,
  resolveMediaPath,
  parentOf,
  baseName,
  joinRel,
} from "./fs-guard";
import { ensureDirectoryNodes, upsertFileNodeFromDisk } from "./node-index";
import { queueProcessFile, notifyScanner } from "./jobs";
import { publishChange } from "./events";
import { acquireMultiPathLock } from "./fs-locks";
import { HttpError, badRequest, conflict, forbidden, notFound, type SessionUser } from "./http";
import { beginJournal, fsyncDir, JOURNAL_DIR, type JournalHandle } from "./fs-journal";
import { trashForReplace } from "./file-ops";

export const CHUNK_SIZE = Math.max(1, Math.min(95, parseInt(process.env.LOOM_UPLOAD_CHUNK_MB ?? "32", 10) || 32)) * 1024 * 1024;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** How long an app's unfinished upload stays resumable without progress. */
const DEVICE_SESSION_TTL_MS =
  Math.max(1, Math.min(30, parseInt(process.env.LOOM_UPLOAD_RESUME_DAYS ?? "7", 10) || 7)) * 24 * 60 * 60 * 1000;
/** A finished "chunks" session is kept this long to answer a repeated "complete". */
const RESULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE_SESSIONS_PER_USER = 500;
/** Parallel chunk writes (mode "chunks"): per upload, per user, and in total. */
const envInt = (name: string, def: number, min: number, max: number) =>
  Math.max(min, Math.min(max, parseInt(process.env[name] ?? "", 10) || def));
const MAX_PARALLEL_PER_SESSION = envInt("LOOM_UPLOAD_PARALLEL_CHUNKS", 4, 1, 16);
const MAX_PARALLEL_PER_USER = envInt("LOOM_UPLOAD_PARALLEL_PER_USER", 8, 1, 64);
const MAX_PARALLEL_TOTAL = envInt("LOOM_UPLOAD_MAX_INFLIGHT", 16, 1, 128);
const WINDOW_BYTES = envInt("LOOM_UPLOAD_WINDOW_MB", 512, 64, 16_384) * 1024 * 1024;
const MIN_CHUNK = 1024 * 1024;
const MAX_CHUNK = 95 * 1024 * 1024;
const MAX_CHUNKS = 100_000;

const MAX_UPLOAD_BYTES = (() => {
  const gb = parseFloat(process.env.LOOM_MAX_UPLOAD_GB ?? "");
  return Number.isFinite(gb) && gb > 0 ? Math.floor(gb * 1024 ** 3) : Number.MAX_SAFE_INTEGER;
})();
/** Keep this much free space on the drive after an upload. */
const FREE_SPACE_MARGIN = 256 * 1024 * 1024;

/** Upload limits the apps adapt to (GET /api/client/info). */
export const UPLOAD_LIMITS = {
  chunkSize: CHUNK_SIZE,
  minChunkSize: MIN_CHUNK,
  maxChunkSize: MAX_CHUNK,
  maxChunks: MAX_CHUNKS,
  parallelChunksPerUpload: MAX_PARALLEL_PER_SESSION,
  parallelChunksPerUser: MAX_PARALLEL_PER_USER,
  windowBytes: WINDOW_BYTES,
  appSessionTtlSeconds: DEVICE_SESSION_TTL_MS / 1000,
  browserSessionTtlSeconds: SESSION_TTL_MS / 1000,
  maxUploadBytes: MAX_UPLOAD_BYTES === Number.MAX_SAFE_INTEGER ? null : MAX_UPLOAD_BYTES,
};

export function partialPath(id: string): string {
  if (!/^[a-z0-9]+$/i.test(id)) throw badRequest("Invalid upload id");
  return path.join(UPLOAD_TEMP_DIR, `${id}.partial`);
}

export type UploadMode = "stream" | "chunks";

const ttlFor = (s: Pick<UploadSession, "deviceId">) => (s.deviceId ? DEVICE_SESSION_TTL_MS : SESSION_TTL_MS);
const chunkSizeOf = (s: Pick<UploadSession, "chunkSize">) => s.chunkSize ?? CHUNK_SIZE;
const chunkCount = (size: number, chunkSize: number) => (size === 0 ? 0 : Math.ceil(size / chunkSize));

// Bitmap layout matches Postgres set_bit/get_bit on bytea: bit n is
// (byte n >> 3) & (1 << (n & 7)).
const hasBit = (map: Uint8Array | null, n: number) => !!map && ((map[n >> 3] ?? 0) & (1 << (n & 7))) !== 0;

function missingChunks(s: UploadSession): number[] {
  const n = chunkCount(Number(s.size), chunkSizeOf(s));
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (!hasBit(s.chunkMap, i)) out.push(i);
  return out;
}

/** The highest chunk that may be written now (see the write window above). */
function windowEnd(s: UploadSession): number {
  const n = chunkCount(Number(s.size), chunkSizeOf(s));
  let first = 0;
  while (first < n && hasBit(s.chunkMap, first)) first++;
  return Math.min(n - 1, first + Math.max(MAX_PARALLEL_PER_SESSION, Math.floor(WINDOW_BYTES / chunkSizeOf(s))));
}

export function sessionJson(s: UploadSession) {
  const base = {
    id: s.id,
    destDir: s.destDir,
    relativePath: s.relativePath,
    size: Number(s.size),
    received: Number(s.received),
    chunkSize: chunkSizeOf(s),
    expiresAt: s.expiresAt,
  };
  if (s.mode !== "chunks") return base;
  return {
    ...base,
    mode: "chunks" as const,
    clientRef: s.clientRef,
    chunks: chunkCount(Number(s.size), chunkSizeOf(s)),
    missing: missingChunks(s),
    windowEnd: s.result ? null : windowEnd(s),
    result: (s.result as FinalizeResult | null) ?? null,
  };
}

async function freeBytes(dir: string): Promise<number> {
  try {
    const s = await fs.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Number.MAX_SAFE_INTEGER; // statfs unsupported — don't block uploads
  }
}

async function assertSpace(bytesNeeded: number) {
  const free = await freeBytes(UPLOAD_TEMP_DIR);
  if (free - bytesNeeded < FREE_SPACE_MARGIN) {
    throw new HttpError(507, "Not enough free space on the drive for this upload");
  }
}

// ─── create ──────────────────────────────────────────────────────────────────

/** Sessions still accepting data (a finished "chunks" session only keeps its result). */
export const UNFINISHED = { result: { equals: Prisma.DbNull } } satisfies Prisma.UploadSessionWhereInput;

export async function createUploadSession(
  user: SessionUser,
  input: {
    destDir?: unknown;
    relativePath?: unknown;
    size?: unknown;
    lastModified?: unknown;
    mimeType?: unknown;
    mode?: unknown;
    clientRef?: unknown;
    chunkSize?: unknown;
  }
) {
  const destDir = normalizeRelPath(input.destDir);
  const relativePath = validateRelativeFilePath(input.relativePath);
  const size = Number(input.size);
  if (!Number.isSafeInteger(size) || size < 0) throw badRequest("Invalid file size");
  if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, "This file is larger than the server's upload limit");
  const mode: UploadMode = input.mode === "chunks" ? "chunks" : "stream";
  if (input.clientRef != null && (typeof input.clientRef !== "string" || !/^[\w-]{8,100}$/.test(input.clientRef))) {
    throw badRequest("Invalid clientRef");
  }
  const clientRef = (input.clientRef as string | undefined) ?? null;
  // Apps may pick their chunk size (smaller on a slow mobile link, larger on
  // the LAN), within limits that keep each request under proxy caps.
  let chunkSize = CHUNK_SIZE;
  if (mode === "chunks" && input.chunkSize != null) {
    chunkSize = Number(input.chunkSize);
    if (!Number.isSafeInteger(chunkSize) || chunkSize < MIN_CHUNK || chunkSize > MAX_CHUNK) {
      throw badRequest(`chunkSize must be between ${MIN_CHUNK} and ${MAX_CHUNK} bytes`);
    }
  }
  if (mode === "chunks" && chunkCount(size, chunkSize) > MAX_CHUNKS) throw badRequest("Too many chunks: use a larger chunkSize");

  // A retried "create" (the response got lost) returns the same session.
  if (clientRef) {
    const existing = await prisma.uploadSession.findUnique({ where: { userId_clientRef: { userId: user.id, clientRef } } });
    if (existing) {
      if (existing.destDir !== destDir || existing.relativePath !== relativePath || Number(existing.size) !== size) {
        throw conflict("clientRef is already used by a different upload");
      }
      return existing;
    }
  }

  const target = joinRel(destDir, relativePath);
  const acl = await getAcl(user);
  if (!acl.canTraverse(destDir) || !acl.canAccess(target)) throw forbidden("You can't upload here");
  const destAbs = await resolveMediaPath(destDir, true);
  if (!(await fs.stat(destAbs)).isDirectory()) throw badRequest("Destination is not a folder");

  const active = await prisma.uploadSession.count({ where: { userId: user.id, ...UNFINISHED } });
  if (active >= MAX_ACTIVE_SESSIONS_PER_USER) throw new HttpError(429, "Too many uploads in progress");

  await initFs();
  await assertSpace(size);

  const lastModified = Number(input.lastModified);
  const deviceId = user.deviceId ?? null;
  let session: UploadSession;
  try {
    session = await prisma.uploadSession.create({
      data: {
        userId: user.id,
        destDir,
        relativePath,
        size: BigInt(size),
        lastModified: Number.isSafeInteger(lastModified) && lastModified > 0 ? BigInt(lastModified) : null,
        mimeType: typeof input.mimeType === "string" ? input.mimeType.slice(0, 200) : null,
        mode,
        chunkSize: mode === "chunks" ? chunkSize : null,
        // Must not be NULL: set_bit(NULL, …) is NULL and would lose every chunk.
        chunkMap: mode === "chunks" ? new Uint8Array(Math.ceil(chunkCount(size, chunkSize) / 8)) : null,
        clientRef,
        deviceId,
        expiresAt: new Date(Date.now() + (deviceId ? DEVICE_SESSION_TTL_MS : SESSION_TTL_MS)),
      },
    });
  } catch (err) {
    // Two creates with the same clientRef raced: return the winner.
    if (clientRef && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return prisma.uploadSession.findUniqueOrThrow({ where: { userId_clientRef: { userId: user.id, clientRef } } });
    }
    throw err;
  }
  try {
    const fh = await fs.open(partialPath(session.id), "wx");
    await fh.close();
  } catch (err) {
    await prisma.uploadSession.delete({ where: { id: session.id } }).catch(() => {});
    throw err;
  }
  return session;
}

export async function getOwnSession(user: SessionUser, id: string) {
  const s = await prisma.uploadSession.findUnique({ where: { id } });
  if (!s || s.userId !== user.id) throw notFound("Upload not found or expired");
  return s;
}

// ─── chunks ──────────────────────────────────────────────────────────────────

const g = globalThis as unknown as { __loomUploadLocks?: Set<string> };
const busy = (g.__loomUploadLocks ??= new Set<string>());

/**
 * Append one chunk at `offset`. Returns the new received count.
 * Throws 409 (with the server's `received`) if the client is out of sync.
 */
export async function writeChunk(
  session: UploadSession,
  offset: number,
  body: ReadableStream<Uint8Array> | null,
  expectedSha256: string | null,
  contentLength: number | null,
  signal: AbortSignal
): Promise<number> {
  if (session.mode === "chunks") throw badRequest("This upload takes numbered chunks (?chunk=N)");
  if (busy.has(session.id)) throw conflict("A chunk for this upload is already being written", { received: Number(session.received) });
  busy.add(session.id);
  const file = partialPath(session.id);
  try {
    const received = Number(session.received);
    const size = Number(session.size);

    // The DB `received` is only advanced after a chunk is fully written and
    // flushed, so anything beyond it on disk is an unacknowledged leftover.
    const st = await fs.stat(file).catch(() => null);
    if (!st) throw notFound("Upload data is missing — please start the upload again");
    if (st.size !== received) await fs.truncate(file, received);

    if (offset !== received) throw conflict("Offset mismatch", { received });
    if (!body) throw badRequest("Missing chunk body");
    const maxBytes = Math.min(CHUNK_SIZE, size - received);
    if (contentLength !== null && contentLength > maxBytes) throw new HttpError(413, "Chunk too large");

    const hash = createHash("sha256");
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > maxBytes) return cb(new HttpError(413, "Chunk too large"));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    const out = createWriteStream(file, { flags: "r+", start: offset });
    try {
      await pipeline(Readable.fromWeb(body as import("stream/web").ReadableStream), meter, out, { signal });
      if (contentLength !== null && bytes !== contentLength) throw badRequest("Chunk was cut short");
      if (expectedSha256 && hash.digest("hex") !== expectedSha256.toLowerCase()) {
        throw new HttpError(422, "Chunk checksum mismatch — it will be re-sent");
      }
      const fh = await fs.open(file, "r+");
      try {
        await fh.datasync();
      } finally {
        await fh.close();
      }
    } catch (err) {
      await fs.truncate(file, offset).catch(() => {});
      throw err;
    }

    const next = offset + bytes;
    await prisma.uploadSession.update({
      where: { id: session.id },
      data: { received: BigInt(next), expiresAt: new Date(Date.now() + ttlFor(session)) },
    });
    session.received = BigInt(next);
    return next;
  } finally {
    busy.delete(session.id);
  }
}

// ─── numbered chunks (mode "chunks") ────────────────────────────────────────

const inFlight = ((globalThis as unknown as { __loomChunkFlight?: Map<string, number> }).__loomChunkFlight ??= new Map());
const bump = (k: string, d: number) => {
  const v = (inFlight.get(k) ?? 0) + d;
  if (v <= 0) inFlight.delete(k);
  else inFlight.set(k, v);
};

export interface ChunkState {
  received: number;
  missing: number;
  /** The chunk had already been stored; nothing was written. */
  duplicate?: boolean;
}

/**
 * Write chunk `index` at its own position. Chunks may arrive in any order
 * and several at once (different indexes). Nothing is ever truncated: a
 * failed write leaves its region unacknowledged and it is simply re-sent.
 */
export async function writeChunkAt(
  user: SessionUser,
  session: UploadSession,
  index: number,
  body: ReadableStream<Uint8Array> | null,
  expectedSha256: string | null,
  contentLength: number | null,
  signal: AbortSignal
): Promise<ChunkState> {
  if (session.mode !== "chunks") throw badRequest("This upload takes chunks in order (?offset=N)");
  if (session.result) throw conflict("This upload is already complete", { result: session.result });
  const size = Number(session.size);
  const cs = chunkSizeOf(session);
  const n = chunkCount(size, cs);
  if (!Number.isSafeInteger(index) || index < 0 || index >= n) throw badRequest("Invalid chunk number");
  const offset = index * cs;
  const length = Math.min(cs, size - offset);
  const missingNow = () => missingChunks(session).length;

  if (hasBit(session.chunkMap, index)) {
    // Already stored (e.g. the acknowledgement was lost). Read and discard
    // the body so the connection stays usable.
    if (body) await body.pipeTo(new WritableStream(), { signal }).catch(() => {});
    return { received: Number(session.received), missing: missingNow(), duplicate: true };
  }
  if (contentLength !== null && contentLength !== length) {
    throw new HttpError(contentLength > length ? 413 : 400, `Chunk ${index} must be exactly ${length} bytes`);
  }
  if (!body) throw badRequest("Missing chunk body");
  if (!expectedSha256) throw badRequest("X-Chunk-SHA256 is required for numbered chunks");
  const end = windowEnd(session);
  if (index > end) throw conflict("Chunk is too far ahead — send earlier chunks first", { windowEnd: end, retry: true });

  const key = `${session.id}:${index}`;
  if (busy.has(key)) throw conflict("This chunk is already being written", { retry: true });
  if (
    (inFlight.get(session.id) ?? 0) >= MAX_PARALLEL_PER_SESSION ||
    (inFlight.get(user.id) ?? 0) >= MAX_PARALLEL_PER_USER ||
    (inFlight.get("*") ?? 0) >= MAX_PARALLEL_TOTAL
  ) {
    throw new HttpError(429, "Too many chunks at once — slow down", { retryAfter: 1 });
  }
  busy.add(key);
  bump(session.id, 1);
  bump(user.id, 1);
  bump("*", 1);
  const file = partialPath(session.id);
  try {
    if (!(await fs.stat(file).catch(() => null))) throw notFound("Upload data is missing — please start the upload again");
    const hash = createHash("sha256");
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > length) return cb(new HttpError(413, "Chunk too large"));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(body as import("stream/web").ReadableStream),
      meter,
      createWriteStream(file, { flags: "r+", start: offset }),
      { signal }
    );
    if (bytes !== length) throw badRequest("Chunk was cut short");
    if (expectedSha256 && hash.digest("hex") !== expectedSha256.toLowerCase()) {
      throw new HttpError(422, "Chunk checksum mismatch — it will be re-sent");
    }
    const fh = await fs.open(file, "r+");
    try {
      await fh.datasync();
    } finally {
      await fh.close();
    }

    // Mark it in one statement, so parallel chunks never lose each other's bits.
    const rows = await prisma.$queryRaw<{ received: bigint; chunkMap: Uint8Array }[]>`
      UPDATE upload_sessions
      SET "chunkMap" = set_bit("chunkMap", ${index}::int, 1),
          received = received + CASE WHEN get_bit("chunkMap", ${index}::int) = 1 THEN 0 ELSE ${length}::bigint END,
          "expiresAt" = ${new Date(Date.now() + ttlFor(session))},
          "updatedAt" = now()
      WHERE id = ${session.id}
      RETURNING received, "chunkMap"`;
    if (!rows.length) throw notFound("Upload not found or expired");
    session.received = rows[0].received;
    session.chunkMap = rows[0].chunkMap;
    return { received: Number(session.received), missing: missingNow() };
  } finally {
    busy.delete(key);
    bump(session.id, -1);
    bump(user.id, -1);
    bump("*", -1);
  }
}

// ─── finalize ────────────────────────────────────────────────────────────────

export interface FinalizeResult {
  success: true;
  path: string;
  name: string;
  renamed: boolean;
  replaced: boolean;
  nodeId: string | null;
  processing: boolean;
}

export type UploadConflict = "keep_both" | "replace";

export function parseUploadConflict(v: unknown): UploadConflict {
  return v === "replace" ? "replace" : "keep_both";
}

export async function finalizeUpload(
  user: SessionUser,
  session: UploadSession,
  onConflict: UploadConflict = "keep_both"
): Promise<FinalizeResult> {
  if (session.mode !== "chunks") return finalizeOnce(user, session, onConflict);
  if (session.result) return session.result as unknown as FinalizeResult;
  const missing = missingChunks(session);
  if (missing.length) throw conflict("Upload is not complete yet", { received: Number(session.received), missing });
  if ((inFlight.get(session.id) ?? 0) > 0) throw conflict("Chunks are still being written — try again in a moment", { retry: true });
  // Two "complete" calls at once: the second waits for a retry and then gets
  // the stored result.
  const key = `${session.id}:finalize`;
  if (busy.has(key)) throw conflict("This upload is being finished — try again in a moment", { retry: true });
  busy.add(key);
  try {
    return await finalizeOnce(user, session, onConflict);
  } finally {
    busy.delete(key);
  }
}

async function finalizeOnce(user: SessionUser, session: UploadSession, onConflict: UploadConflict): Promise<FinalizeResult> {
  const file = partialPath(session.id);
  const st = await fs.stat(file).catch(() => null);
  if (!st) throw notFound("Upload data is missing — please start the upload again");
  if (BigInt(st.size) !== session.size || session.received !== session.size) {
    throw conflict("Upload is not complete yet", { received: Number(session.received) });
  }

  // Permissions may have changed while the upload was running.
  const target = joinRel(session.destDir, session.relativePath);
  const acl = await getAcl(user);
  if (!acl.canAccess(target)) throw forbidden("You can no longer upload here");

  const dirRel = parentOf(target);
  const wanted = baseName(target);
  const dirAbs = await resolveMediaPath(dirRel);
  await fs.mkdir(dirAbs, { recursive: true });

  const release = await acquireMultiPathLock([path.join(dirAbs, wanted)]);
  let finalName = wanted;
  let replaced = false;
  let pendingJournal: JournalHandle | null = null;
  try {
    // "Replace": the existing file (never a folder) goes to Trash first, so
    // it can be restored. Its name is then free for the new upload.
    if (onConflict === "replace") {
      const existing = await fs.lstat(path.join(dirAbs, wanted)).catch(() => null);
      if (existing?.isFile() && acl.canAccess(target)) {
        await trashForReplace(user, target, path.join(dirAbs, wanted));
        replaced = true;
      }
    }

    // Journal first: if the power goes out from here on, the next start
    // either finishes indexing the file or removes the empty placeholder.
    const lastModified = session.lastModified ? Number(session.lastModified) : null;
    const journal = await beginJournal({
      kind: "upload",
      sessionId: session.id,
      partialAbs: file,
      finalAbs: path.join(dirAbs, wanted),
      size: Number(session.size),
      lastModified,
    });

    // Reserve a free name with O_EXCL, then atomically rename the finished
    // upload over our own empty placeholder. Nothing else is ever replaced.
    const ext = path.extname(wanted);
    const base = ext ? wanted.slice(0, -ext.length) : wanted;
    try {
      for (let n = 1; ; n++) {
        try {
          const fh = await fs.open(path.join(dirAbs, finalName), "wx");
          await fh.close();
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST" || n > 10_000) throw err;
          finalName = `${base} (${n})${ext}`;
        }
      }
    } catch (err) {
      await journal.done();
      throw err;
    }
    const finalAbs = path.join(dirAbs, finalName);
    // Only now is there a placeholder of ours that recovery may remove.
    await journal.update({ finalAbs, placeholder: true });
    try {
      await fs.rename(file, finalAbs);
    } catch (err) {
      await fs.rm(finalAbs, { force: true }).catch(() => {});
      await journal.done();
      throw err;
    }
    await fsyncDir(dirAbs);
    if (lastModified) {
      const mtime = new Date(lastModified);
      if (mtime.getTime() > 0 && mtime.getTime() < Date.now() + 86_400_000) {
        await fs.utimes(finalAbs, new Date(), mtime).catch(() => {});
      }
    }
    pendingJournal = journal;
  } finally {
    release();
  }

  const finalRel = joinRel(dirRel, finalName);
  let nodeId: string | null = null;
  let processing = false;
  try {
    await ensureDirectoryNodes(dirRel);
    const node = await upsertFileNodeFromDisk(finalRel);
    nodeId = node.id;
    processing = await queueProcessFile(node, user.id);
    await forgetSession(session, { success: true, path: finalRel, name: finalName, renamed: finalName !== wanted, replaced, nodeId, processing });
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "UPLOAD",
        details: { originalName: wanted, finalPath: finalRel, size: Number(session.size), renamed: finalName !== wanted, replaced },
      },
    });
    await pendingJournal?.done();
  } catch (err) {
    // The file itself is safely in place; the journal entry stays, so the
    // next start (or a rescan) indexes it.
    console.error("[upload] indexing after upload failed for", finalRel, err);
  }
  if (processing) await notifyScanner();
  await publishChange([dirRel], nodeId ? [nodeId] : undefined);

  return { success: true, path: finalRel, name: finalName, renamed: finalName !== wanted, replaced, nodeId, processing };
}

/** A finished upload's row: deleted ("stream"), or kept a day with its result ("chunks"). */
async function forgetSession(session: UploadSession, result: FinalizeResult) {
  if (session.mode === "chunks") {
    await prisma.uploadSession
      .update({
        where: { id: session.id },
        data: { result: result as unknown as Prisma.InputJsonValue, expiresAt: new Date(Date.now() + RESULT_TTL_MS) },
      })
      .catch(() => {});
  } else {
    await prisma.uploadSession.delete({ where: { id: session.id } }).catch(() => {});
  }
}

// ─── cancel / cleanup ────────────────────────────────────────────────────────

export async function cancelUpload(session: UploadSession) {
  await prisma.uploadSession.delete({ where: { id: session.id } }).catch(() => {});
  await fs.rm(partialPath(session.id), { force: true });
}

/** Remove expired sessions and orphaned .partial files. Called by the scanner and on demand. */
export async function purgeExpiredUploads(): Promise<number> {
  let removed = 0;
  const expired = await prisma.uploadSession.findMany({ where: { expiresAt: { lt: new Date() } }, select: { id: true } });
  for (const s of expired) {
    await fs.rm(partialPath(s.id), { force: true }).catch(() => {});
    await prisma.uploadSession.delete({ where: { id: s.id } }).catch(() => {});
    removed++;
  }
  const live = new Set((await prisma.uploadSession.findMany({ select: { id: true } })).map((s) => s.id));
  for (const f of await fs.readdir(UPLOAD_TEMP_DIR).catch(() => [] as string[])) {
    const id = f.replace(/\.partial$/, "");
    if (live.has(id) || path.join(UPLOAD_TEMP_DIR, f) === JOURNAL_DIR) continue;
    const st = await fs.stat(path.join(UPLOAD_TEMP_DIR, f)).catch(() => null);
    if (st && Date.now() - st.mtimeMs > SESSION_TTL_MS) {
      await fs.rm(path.join(UPLOAD_TEMP_DIR, f), { force: true, recursive: true }).catch(() => {});
      removed++;
    }
  }
  return removed;
}

export { MEDIA_ROOT };
