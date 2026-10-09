/**
 * Housekeeping that runs hourly (and at the end of a full rescan). None of it
 * walks the media folder, so it doesn't keep the drive awake: it only touches
 * Loom's own .LoomTrash / .tmp-upload folders and the cache.
 */
import { readdir, rm, stat, unlink } from "fs/promises";
import { join } from "path";
import {
  prisma,
  log,
  CACHE_ROOT,
  THUMB_DIR,
  PREVIEW_DIR,
  VIDEO_CACHE_DIR,
  TEMP_DIR,
  TRASH_DIR,
  UPLOAD_TEMP_DIR,
  publishChange,
} from "./common.js";

const DAY = 86_400_000;
const AUDIT_RETENTION_DAYS = Math.max(1, parseInt(process.env.LOOM_AUDIT_RETENTION_DAYS ?? "180", 10) || 180);

/** Permanently delete trash items older than their expiry (15 days by default). */
export async function expireTrash(): Promise<number> {
  const expired = await prisma.trashItem.findMany({ where: { expiresAt: { lt: new Date() } } });
  let deleted = 0;
  for (const item of expired) {
    if (!/^[^/\\]+$/.test(item.trashPath) || item.trashPath === "." || item.trashPath === "..") continue;
    try {
      const root = `.LoomTrash/${item.trashPath}`;
      await prisma.$transaction([
        prisma.fileNode.deleteMany({ where: { relativePath: { startsWith: root + "/" } } }),
        prisma.fileNode.deleteMany({ where: { id: item.fileNodeId } }),
        prisma.auditLog.create({ data: { action: "EXPIRE_TRASH", details: { originalPath: item.originalPath, trashPath: item.trashPath } } }),
      ]);
      await rm(join(TRASH_DIR, item.trashPath), { recursive: true, force: true });
      deleted++;
    } catch (err) {
      log("ERROR", `Failed to expire trash item ${item.trashPath}`, { error: String(err) });
    }
  }
  if (deleted) {
    log("INFO", `Expired ${deleted} trash item(s)`);
    await publishChange([".LoomTrash"]);
  }
  return deleted;
}

/**
 * Remove leftovers in .LoomTrash that no trash item points to (e.g. if a
 * permanent delete was interrupted). Only entries untouched for a day are
 * considered, so in-flight operations are never affected.
 */
export async function sweepOrphanTrash(): Promise<number> {
  let names: string[];
  try {
    names = await readdir(TRASH_DIR);
  } catch {
    return 0;
  }
  const known = new Set((await prisma.trashItem.findMany({ select: { trashPath: true } })).map((t) => t.trashPath));
  let removed = 0;
  for (const name of names) {
    if (known.has(name)) continue;
    const st = await stat(join(TRASH_DIR, name)).catch(() => null);
    if (!st || Date.now() - st.ctimeMs < DAY) continue;
    await rm(join(TRASH_DIR, name), { recursive: true, force: true }).catch(() => {});
    await prisma.fileNode.deleteMany({ where: { OR: [{ relativePath: `.LoomTrash/${name}` }, { relativePath: { startsWith: `.LoomTrash/${name}/` } }] } });
    removed++;
  }
  if (removed) log("INFO", `Removed ${removed} orphaned item(s) from .LoomTrash`);
  return removed;
}

/** Expired upload sessions and stray .partial files. */
export async function purgeUploads(): Promise<number> {
  let removed = 0;
  const expired = await prisma.uploadSession.findMany({ where: { expiresAt: { lt: new Date() } }, select: { id: true } });
  for (const s of expired) {
    await rm(join(UPLOAD_TEMP_DIR, `${s.id}.partial`), { force: true }).catch(() => {});
    await prisma.uploadSession.deleteMany({ where: { id: s.id } });
    removed++;
  }
  const live = new Set((await prisma.uploadSession.findMany({ select: { id: true } })).map((s) => s.id));
  for (const f of await readdir(UPLOAD_TEMP_DIR).catch(() => [] as string[])) {
    if (live.has(f.replace(/\.partial$/, "")) || f === "journal") continue; // journal: web/lib/fs-journal.ts
    const st = await stat(join(UPLOAD_TEMP_DIR, f)).catch(() => null);
    if (st && Date.now() - st.mtimeMs > DAY) {
      await rm(join(UPLOAD_TEMP_DIR, f), { recursive: true, force: true }).catch(() => {});
      removed++;
    }
  }
  if (removed) log("INFO", `Purged ${removed} abandoned upload(s)`);
  return removed;
}

/** Cache files with no DB record, identities no file uses, stale temp files. */
export async function runOrphanGC() {
  const result = { thumbsDeleted: 0, previewsDeleted: 0, videoCachesDeleted: 0, identitiesDeleted: 0 };

  // Identities no file (live or trashed) references — cascades their cache rows.
  // (Only ones older than an hour, so an identity a worker has just created
  // but not yet linked is never removed.)
  const orphaned = await prisma.contentIdentity.findMany({
    where: { nodes: { none: {} }, createdAt: { lt: new Date(Date.now() - 3_600_000) } },
    select: { id: true },
  });
  for (let i = 0; i < orphaned.length; i += 500) {
    const ids = orphaned.slice(i, i + 500).map((o) => o.id);
    const r = await prisma.contentIdentity.deleteMany({ where: { id: { in: ids } } });
    result.identitiesDeleted += r.count;
  }

  const valid = new Set<string>();
  for (const t of await prisma.thumbnail.findMany({ select: { cachePath: true } })) valid.add(join(CACHE_ROOT, t.cachePath));
  for (const p of await prisma.preview.findMany({ select: { cachePath: true } })) valid.add(join(CACHE_ROOT, p.cachePath));
  const validVideo = new Set((await prisma.videoCache.findMany({ select: { cacheDir: true } })).map((v) => join(CACHE_ROOT, v.cacheDir)));

  for (const [dir, key] of [[THUMB_DIR, "thumbsDeleted"], [PREVIEW_DIR, "previewsDeleted"]] as const) {
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      const abs = join(dir, f);
      if (!valid.has(abs)) {
        await unlink(abs).catch(() => {});
        result[key]++;
      }
    }
  }

  for (const ci of await readdir(VIDEO_CACHE_DIR).catch(() => [] as string[])) {
    const ciDir = join(VIDEO_CACHE_DIR, ci);
    const versions = await readdir(ciDir).catch(() => [] as string[]);
    for (const v of versions) {
      if (!validVideo.has(join(ciDir, v))) {
        await rm(join(ciDir, v), { recursive: true, force: true }).catch(() => {});
        result.videoCachesDeleted++;
      }
    }
    if ((await readdir(ciDir).catch(() => ["x"])).length === 0) await rm(ciDir, { recursive: true, force: true }).catch(() => {});
  }

  for (const f of await readdir(TEMP_DIR).catch(() => [] as string[])) {
    const st = await stat(join(TEMP_DIR, f)).catch(() => null);
    if (st && Date.now() - st.mtimeMs > DAY) await rm(join(TEMP_DIR, f), { force: true, recursive: true }).catch(() => {});
  }
  return result;
}

/** Old job rows, audit entries, read notifications and expired app pairing requests. */
export async function pruneHistory() {
  const now = Date.now();
  await prisma.scanJob.deleteMany({ where: { type: "PROCESS_FILE", status: "COMPLETED", completedAt: { lt: new Date(now - DAY) } } });
  await prisma.scanJob.deleteMany({ where: { type: "PROCESS_FILE", status: { in: ["FAILED", "CANCELLED"] }, completedAt: { lt: new Date(now - 7 * DAY) } } });
  const oldRescans = await prisma.scanJob.findMany({
    where: { type: { in: ["FULL_RESCAN", "INDEX_FILE"] }, status: { in: ["COMPLETED", "FAILED", "CANCELLED"] } },
    orderBy: { requestedAt: "desc" },
    skip: 20,
    select: { id: true },
  });
  if (oldRescans.length) await prisma.scanJob.deleteMany({ where: { id: { in: oldRescans.map((j) => j.id) } } });
  await prisma.auditLog.deleteMany({ where: { timestamp: { lt: new Date(now - AUDIT_RETENTION_DAYS * DAY) } } });
  await prisma.notification.deleteMany({ where: { read: true, createdAt: { lt: new Date(now - 30 * DAY) } } });
  // App pairing requests are valid for minutes (web/lib/devices.ts).
  await prisma.devicePairing.deleteMany({ where: { expiresAt: { lt: new Date(now - 3_600_000) } } });
}

export async function runMaintenance() {
  try {
    await expireTrash();
    await purgeUploads();
    await pruneHistory();
  } catch (err) {
    log("ERROR", "Maintenance failed", { error: String(err) });
  }
}
