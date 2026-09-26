/**
 * Derived media: content identity, thumbnails, previews, video posters and
 * metadata.
 *
 * Safety: original files are only ever opened for reading. Every output is
 * written to a temp file in the cache and renamed into place, so a crash or
 * a concurrent reader never sees a half-written thumbnail.
 */
import { createHash, randomUUID } from "crypto";
import { createReadStream } from "fs";
import { access, mkdir, rename, rm, stat } from "fs/promises";
import { constants } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import sharp from "sharp";
import exifReader from "exif-reader";
import { Prisma } from "@prisma/client";
import {
  prisma,
  log,
  CACHE_ROOT,
  THUMB_DIR,
  PREVIEW_DIR,
  TEMP_DIR,
  THUMB_PROFILE,
  PREVIEW_PROFILE,
  HLS_PROFILE,
} from "./common.js";

// Keep libvips' memory use modest on small home servers.
sharp.cache({ memory: 64, files: 0 });
sharp.concurrency(Math.max(1, Math.min(4, parseInt(process.env.LOOM_SHARP_THREADS ?? "2", 10) || 2)));

const HASH_CHUNK = 1024 * 1024;

async function hashRange(hash: ReturnType<typeof createHash>, path: string, start: number, end: number) {
  if (end < start) return;
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(path, { start, end });
    s.on("data", (c) => hash.update(c));
    s.on("end", resolve);
    s.on("error", reject);
  });
}

/** SHA-256(first 1 MB || last 1 MB) — must match web/lib/content-identity.ts. */
export async function computeFastHash(absolutePath: string, fileSize: number): Promise<string> {
  const hash = createHash("sha256");
  await hashRange(hash, absolutePath, 0, Math.min(HASH_CHUNK, fileSize) - 1);
  if (fileSize > HASH_CHUNK) {
    await hashRange(hash, absolutePath, Math.max(HASH_CHUNK, fileSize - HASH_CHUNK), fileSize - 1);
  }
  return hash.digest("hex");
}

export async function resolveContentIdentity(absolutePath: string, fileSize: number, fileNodeId: string) {
  const fastHash = await computeFastHash(absolutePath, fileSize);
  const size = BigInt(fileSize);
  const identity = await prisma.contentIdentity.upsert({
    where: { size_fastHash: { size, fastHash } },
    update: {},
    create: { size, fastHash },
    include: { thumbnail: true, preview: true },
  });
  await prisma.fileNode.update({ where: { id: fileNodeId }, data: { contentIdentityId: identity.id } });
  return identity;
}

export const thumbCachePath = (ci: string) => `thumbnails/${ci}_${THUMB_PROFILE}.webp`;
export const previewCachePath = (ci: string) => `previews/${ci}_${PREVIEW_PROFILE}.webp`;
export const videoPosterCachePath = (ci: string) => `previews/video-${ci}_${THUMB_PROFILE}.webp`;

export async function cacheFileExists(rel: string): Promise<boolean> {
  return access(join(CACHE_ROOT, rel), constants.R_OK).then(() => true, () => false);
}

function tempPath(ext: string) {
  return join(TEMP_DIR, `${randomUUID()}${ext}`);
}

async function publish(tmp: string, rel: string) {
  await rename(tmp, join(CACHE_ROOT, rel));
}

async function markHealth(fileNodeId: string, err: unknown) {
  const text = String((err as Error)?.message ?? err);
  const unsupported = /unsupported|no decoding|not supported|unknown|codec|heif: Error|bad seek/i.test(text);
  await prisma.fileNode
    .update({
      where: { id: fileNodeId },
      data: { healthStatus: unsupported ? "UNSUPPORTED" : "CORRUPT", healthError: text.slice(0, 1000) },
    })
    .catch(() => {});
}

async function markHealthy(fileNodeId: string, sourceVersion: string | null) {
  await prisma.fileNode
    .update({
      where: { id: fileNodeId },
      data: { healthStatus: "HEALTHY", healthError: null, healthCheckedVersion: sourceVersion },
    })
    .catch(() => {});
}

// ─── images ──────────────────────────────────────────────────────────────────

function dms(v: unknown, ref: unknown): number | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const deg = Number(v[0]) + Number(v[1]) / 60 + Number(v[2]) / 3600;
  if (!Number.isFinite(deg)) return null;
  return ref === "S" || ref === "W" ? -deg : deg;
}

function exifInfo(buf: Buffer | undefined): Record<string, unknown> {
  if (!buf) return {};
  try {
    const e = exifReader(buf);
    const takenAt = e.Photo?.DateTimeOriginal ?? e.Image?.DateTime;
    const lat = dms(e.GPSInfo?.GPSLatitude, e.GPSInfo?.GPSLatitudeRef);
    const lon = dms(e.GPSInfo?.GPSLongitude, e.GPSInfo?.GPSLongitudeRef);
    const camera = [e.Image?.Make, e.Image?.Model].filter(Boolean).join(" ").trim();
    return {
      takenAt: takenAt instanceof Date && !isNaN(takenAt.getTime()) ? takenAt.toISOString() : undefined,
      camera: camera || undefined,
      lens: e.Photo?.LensModel || undefined,
      exposureTime: e.Photo?.ExposureTime || undefined,
      fNumber: e.Photo?.FNumber || undefined,
      iso: e.Photo?.ISOSpeedRatings || undefined,
      focalLength: e.Photo?.FocalLength || undefined,
      gps: lat !== null && lon !== null ? { lat: +lat.toFixed(6), lon: +lon.toFixed(6) } : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Thumbnail (320px square), preview (≤1920px) and metadata for an image, from
 * one decode. Orientation from EXIF is applied so phone photos aren't sideways.
 */
export async function processImage(
  absolutePath: string,
  ci: { id: string; thumbnail: { profileVersion: string; cachePath: string } | null; preview: { profileVersion: string; cachePath: string } | null; mediaInfo?: unknown },
  fileNodeId: string,
  sourceVersion: string | null,
  force = false
): Promise<{ thumb: boolean; preview: boolean }> {
  const needThumb = force || !ci.thumbnail || ci.thumbnail.profileVersion !== THUMB_PROFILE || !(await cacheFileExists(ci.thumbnail.cachePath));
  const needPreview = force || !ci.preview || ci.preview.profileVersion !== PREVIEW_PROFILE || !(await cacheFileExists(ci.preview.cachePath));
  const needInfo = !ci.mediaInfo;
  if (!needThumb && !needPreview && !needInfo) return { thumb: false, preview: false };

  await mkdir(THUMB_DIR, { recursive: true });
  await mkdir(PREVIEW_DIR, { recursive: true });
  await mkdir(TEMP_DIR, { recursive: true });

  const tmpFiles: string[] = [];
  try {
    const base = sharp(absolutePath, { failOn: "error", limitInputPixels: 268_402_689, animated: false });
    const meta = await base.metadata();
    const rotated = base.clone().rotate(); // honour EXIF orientation

    if (needInfo) {
      const swap = (meta.orientation ?? 1) >= 5;
      const info = {
        kind: "image",
        width: swap ? meta.height : meta.width,
        height: swap ? meta.width : meta.height,
        format: meta.format,
        ...exifInfo(meta.exif),
      };
      await prisma.contentIdentity.update({ where: { id: ci.id }, data: { mediaInfo: info as Prisma.InputJsonValue } }).catch(() => {});
    }

    if (needThumb) {
      const t = tempPath(".webp");
      tmpFiles.push(t);
      await rotated.clone().resize(320, 320, { fit: "cover", position: "attention" }).webp({ quality: 75 }).toFile(t);
      const rel = thumbCachePath(ci.id);
      await publish(t, rel);
      await prisma.thumbnail.upsert({
        where: { contentIdentityId: ci.id },
        update: { cachePath: rel, width: 320, height: 320, profileVersion: THUMB_PROFILE, generatedAt: new Date() },
        create: { contentIdentityId: ci.id, cachePath: rel, width: 320, height: 320, profileVersion: THUMB_PROFILE },
      });
    }
    if (needPreview) {
      const p = tempPath(".webp");
      tmpFiles.push(p);
      const out = await rotated.clone().resize(1920, 1920, { fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toFile(p);
      const rel = previewCachePath(ci.id);
      await publish(p, rel);
      await prisma.preview.upsert({
        where: { contentIdentityId: ci.id },
        update: { cachePath: rel, width: out.width, height: out.height, profileVersion: PREVIEW_PROFILE, generatedAt: new Date() },
        create: { contentIdentityId: ci.id, cachePath: rel, width: out.width, height: out.height, profileVersion: PREVIEW_PROFILE },
      });
    }
    await markHealthy(fileNodeId, sourceVersion);
    return { thumb: needThumb, preview: needPreview };
  } catch (err) {
    log("WARN", `Image processing failed: ${absolutePath}`, { error: String(err) });
    await markHealth(fileNodeId, err);
    return { thumb: false, preview: false };
  } finally {
    for (const t of tmpFiles) await rm(t, { force: true }).catch(() => {});
  }
}

// ─── videos ──────────────────────────────────────────────────────────────────

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr = (stderr + d.toString()).slice(-4000)));
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(e) });
    });
  });
}

interface Probe {
  duration: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  pixFmt: string | null;
  audioCodec: string | null;
  rotation: number;
  createdAt: string | null;
}

async function probe(absolutePath: string): Promise<Probe | null> {
  const r = await run(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration:format_tags=creation_time:stream=codec_type,codec_name,pix_fmt,width,height:stream_tags=rotate:stream_side_data=rotation", "-of", "json", absolutePath],
    30_000
  );
  try {
    const j = JSON.parse(r.stdout);
    const streams: Record<string, any>[] = j.streams ?? [];
    const v = streams.find((s) => s.codec_type === "video");
    const a = streams.find((s) => s.codec_type === "audio");
    if (!v) return null;
    const rot = Number(v.tags?.rotate ?? v.side_data_list?.find((s: any) => "rotation" in s)?.rotation ?? 0) || 0;
    return {
      duration: parseFloat(j.format?.duration ?? "") || null,
      width: v.width ?? null,
      height: v.height ?? null,
      videoCodec: v.codec_name ?? null,
      pixFmt: v.pix_fmt ?? null,
      audioCodec: a?.codec_name ?? null,
      rotation: rot,
      createdAt: j.format?.tags?.creation_time ?? null,
    };
  } catch {
    return null;
  }
}

const INCOMPATIBLE_CONTAINERS = new Set(["video/quicktime", "video/x-matroska", "video/avi", "video/x-msvideo", "video/mpeg", "video/x-mpeg", "video/mp2t", "video/x-ms-wmv", "video/x-flv", "video/3gpp"]);
const NATIVE_VIDEO = new Set(["h264", "vp8", "vp9", "av1"]);
const NATIVE_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);

/** Same rule as web/lib/video-compat.ts isProbeBrowserNative. */
function browserCompatible(mimeType: string | null, p: Probe): boolean {
  if (mimeType && INCOMPATIBLE_CONTAINERS.has(mimeType)) return false;
  const c = (p.videoCodec ?? "").toLowerCase();
  if (!NATIVE_VIDEO.has(c)) return false;
  if (c === "h264" && p.pixFmt && /10|12/.test(p.pixFmt)) return false;
  if (p.audioCodec && !NATIVE_AUDIO.has(p.audioCodec.toLowerCase())) return false;
  return true;
}

/** Probe a video (duration, codecs, playability) and make a poster thumbnail. */
export async function processVideo(
  absolutePath: string,
  ci: { id: string; thumbnail: { profileVersion: string; cachePath: string } | null; mediaInfo?: unknown },
  node: { id: string; mimeType: string | null; browserCompatible: boolean | null },
  sourceVersion: string | null,
  force = false
): Promise<{ thumb: boolean }> {
  const needThumb = force || !ci.thumbnail || ci.thumbnail.profileVersion !== THUMB_PROFILE || !(await cacheFileExists(ci.thumbnail.cachePath));
  const needProbe = !ci.mediaInfo || node.browserCompatible === null;
  if (!needThumb && !needProbe) return { thumb: false };

  const p = await probe(absolutePath);
  if (!p) {
    await markHealth(node.id, new Error("ffprobe could not read a video stream (file may be damaged or unsupported)"));
    return { thumb: false };
  }

  if (needProbe) {
    const swap = Math.abs(p.rotation) === 90 || Math.abs(p.rotation) === 270;
    await prisma.contentIdentity
      .update({
        where: { id: ci.id },
        data: {
          mediaInfo: {
            kind: "video",
            durationSeconds: p.duration,
            width: swap ? p.height : p.width,
            height: swap ? p.width : p.height,
            videoCodec: p.videoCodec,
            audioCodec: p.audioCodec,
            takenAt: p.createdAt ?? undefined,
          } as Prisma.InputJsonValue,
        },
      })
      .catch(() => {});
    await prisma.fileNode.update({ where: { id: node.id }, data: { browserCompatible: browserCompatible(node.mimeType, p) } }).catch(() => {});
    if (p.duration) {
      await prisma.videoCache
        .upsert({
          where: { contentIdentityId_profileVersion: { contentIdentityId: ci.id, profileVersion: HLS_PROFILE } },
          update: { durationSeconds: p.duration },
          create: { contentIdentityId: ci.id, profileVersion: HLS_PROFILE, cacheDir: `videos/${ci.id}/${HLS_PROFILE}`, durationSeconds: p.duration },
        })
        .catch(() => {});
    }
  }

  if (!needThumb) {
    await markHealthy(node.id, sourceVersion);
    return { thumb: false };
  }

  await mkdir(PREVIEW_DIR, { recursive: true });
  await mkdir(TEMP_DIR, { recursive: true });
  const seek = p.duration ? Math.min(1, p.duration * 0.1) : 0;
  const tmp = tempPath(".webp");
  const attempt = (ss: number) =>
    run(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-y", "-ss", ss.toFixed(2), "-i", absolutePath, "-frames:v", "1",
        "-vf", "scale=w=480:h=480:force_original_aspect_ratio=decrease", "-c:v", "libwebp", "-quality", "75", tmp],
      60_000
    );
  try {
    let r = await attempt(seek);
    if (r.code !== 0 || !(await stat(tmp).then((s) => s.size > 0, () => false))) r = await attempt(0);
    if (r.code !== 0) throw new Error(`ffmpeg exited ${r.code}: ${r.stderr.trim().split("\n").slice(-2).join(" ")}`);
    const rel = videoPosterCachePath(ci.id);
    await publish(tmp, rel);
    await prisma.thumbnail.upsert({
      where: { contentIdentityId: ci.id },
      update: { cachePath: rel, width: 480, height: 480, profileVersion: THUMB_PROFILE, generatedAt: new Date() },
      create: { contentIdentityId: ci.id, cachePath: rel, width: 480, height: 480, profileVersion: THUMB_PROFILE },
    });
    await markHealthy(node.id, sourceVersion);
    return { thumb: true };
  } catch (err) {
    log("WARN", `Video poster failed: ${absolutePath}`, { error: String(err) });
    await markHealth(node.id, err);
    return { thumb: false };
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}
