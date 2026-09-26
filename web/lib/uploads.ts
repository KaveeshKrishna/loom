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
 */

import fs from "fs/promises";
import { createWriteStream } from "fs";
import path from "path";
import { createHash } from "crypto";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import type { UploadSession } from "@prisma/client";
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

export const CHUNK_SIZE = Math.max(1, Math.min(95, parseInt(process.env.LOOM_UPLOAD_CHUNK_MB ?? "32", 10) || 32)) * 1024 * 1024;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE_SESSIONS_PER_USER = 500;
const MAX_UPLOAD_BYTES = (() => {
  const gb = parseFloat(process.env.LOOM_MAX_UPLOAD_GB ?? "");
  return Number.isFinite(gb) && gb > 0 ? Math.floor(gb * 1024 ** 3) : Number.MAX_SAFE_INTEGER;
})();
/** Keep this much free space on the drive after an upload. */
const FREE_SPACE_MARGIN = 256 * 1024 * 1024;

export function partialPath(id: string): string {
  if (!/^[a-z0-9]+$/i.test(id)) throw badRequest("Invalid upload id");
  return path.join(UPLOAD_TEMP_DIR, `${id}.partial`);
}

export function sessionJson(s: UploadSession) {
  return {
    id: s.id,
    destDir: s.destDir,
    relativePath: s.relativePath,
    size: Number(s.size),
    received: Number(s.received),
    chunkSize: CHUNK_SIZE,
    expiresAt: s.expiresAt,
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

export async function createUploadSession(
  user: SessionUser,
  input: { destDir?: unknown; relativePath?: unknown; size?: unknown; lastModified?: unknown; mimeType?: unknown }
) {
  const destDir = normalizeRelPath(input.destDir);
  const relativePath = validateRelativeFilePath(input.relativePath);
  const size = Number(input.size);
  if (!Number.isSafeInteger(size) || size < 0) throw badRequest("Invalid file size");
  if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, "This file is larger than the server's upload limit");

  const target = joinRel(destDir, relativePath);
  const acl = await getAcl(user);
  if (!acl.canTraverse(destDir) || !acl.canAccess(target)) throw forbidden("You can't upload here");
  const destAbs = await resolveMediaPath(destDir, true);
  if (!(await fs.stat(destAbs)).isDirectory()) throw badRequest("Destination is not a folder");

  const active = await prisma.uploadSession.count({ where: { userId: user.id } });
  if (active >= MAX_ACTIVE_SESSIONS_PER_USER) throw new HttpError(429, "Too many uploads in progress");

  await initFs();
  await assertSpace(size);

  const lastModified = Number(input.lastModified);
  const session = await prisma.uploadSession.create({
    data: {
      userId: user.id,
      destDir,
      relativePath,
      size: BigInt(size),
      lastModified: Number.isSafeInteger(lastModified) && lastModified > 0 ? BigInt(lastModified) : null,
      mimeType: typeof input.mimeType === "string" ? input.mimeType.slice(0, 200) : null,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
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
      data: { received: BigInt(next), expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
    });
    session.received = BigInt(next);
    return next;
  } finally {
    busy.delete(session.id);
  }
}

// ─── finalize ────────────────────────────────────────────────────────────────

export interface FinalizeResult {
  success: true;
  path: string;
  name: string;
  renamed: boolean;
  nodeId: string | null;
  processing: boolean;
}

export async function finalizeUpload(user: SessionUser, session: UploadSession): Promise<FinalizeResult> {
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
  try {
    // Reserve a free name with O_EXCL, then atomically rename the finished
    // upload over our own empty placeholder. Nothing else is ever replaced.
    const ext = path.extname(wanted);
    const base = ext ? wanted.slice(0, -ext.length) : wanted;
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
    const finalAbs = path.join(dirAbs, finalName);
    try {
      await fs.rename(file, finalAbs);
    } catch (err) {
      await fs.rm(finalAbs, { force: true }).catch(() => {});
      throw err;
    }
    if (session.lastModified) {
      const mtime = new Date(Number(session.lastModified));
      if (mtime.getTime() > 0 && mtime.getTime() < Date.now() + 86_400_000) {
        await fs.utimes(finalAbs, new Date(), mtime).catch(() => {});
      }
    }
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
    await prisma.uploadSession.delete({ where: { id: session.id } }).catch(() => {});
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "UPLOAD",
        details: { originalName: wanted, finalPath: finalRel, size: Number(session.size), renamed: finalName !== wanted },
      },
    });
  } catch (err) {
    // The file itself is safely in place; a rescan will index it.
    console.error("[upload] indexing after upload failed for", finalRel, err);
  }
  if (processing) await notifyScanner();
  await publishChange([dirRel], nodeId ? [nodeId] : undefined);

  return { success: true, path: finalRel, name: finalName, renamed: finalName !== wanted, nodeId, processing };
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
    if (live.has(id)) continue;
    const st = await fs.stat(path.join(UPLOAD_TEMP_DIR, f)).catch(() => null);
    if (st && Date.now() - st.mtimeMs > SESSION_TTL_MS) {
      await fs.rm(path.join(UPLOAD_TEMP_DIR, f), { force: true, recursive: true }).catch(() => {});
      removed++;
    }
  }
  return removed;
}

export { MEDIA_ROOT };
