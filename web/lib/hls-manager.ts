/**
 * HLS Manager — region-based, demand-driven HLS generation.
 *
 *  - Caches live in /cache/videos/{contentIdentityId}/{HLS_PROFILE}/, so the
 *    same video at several paths shares one cache, and the scanner's cleanup
 *    recognises (and keeps) it via its VideoCache row.
 *  - One FFmpeg process per region (the segment where playback/seek began).
 *    Requests for segments at or slightly ahead of a running region's
 *    progress join it; a seek further ahead starts a new region instead of
 *    waiting for the old one to crawl there.
 *  - A global cap limits concurrent transcodes; the least recently used
 *    region is stopped to make room.
 *  - Regions nobody is requesting are stopped after IDLE_GRACE_MS. Finished
 *    segments stay on disk and are never regenerated.
 *  - FFmpeg writes segments to temp files and renames them, so only complete
 *    segments are ever served.
 */

import { spawn, ChildProcess } from "child_process";
import { mkdir, readdir, stat, copyFile, rename } from "fs/promises";
import { join } from "path";
import { probeVideo } from "./video-compat";
import { prisma } from "./prisma";

const CACHE_ROOT = process.env.CACHE_ROOT ?? "/cache";
const VIDEO_CACHE_DIR = join(CACHE_ROOT, "videos");

/** Bump when FFmpeg output settings change so old caches aren't reused. */
export const HLS_PROFILE = "v2";

const SEGMENT_DURATION = 6;
const IDLE_GRACE_MS = 20_000;
const SEGMENT_WAIT_MS = 25_000;
const SEGMENT_POLL_MS = 150;
/** How far ahead of a region's progress a request may be and still join it. */
const JOIN_LOOKAHEAD = 4;
const MAX_TRANSCODES = Math.max(1, parseInt(process.env.LOOM_MAX_TRANSCODES ?? "2", 10) || 2);

interface GenerationJob {
  contentIdentityId: string;
  regionStart: number;
  /** Highest contiguous finished segment index (regionStart - 1 if none yet). */
  frontier: number;
  process: ChildProcess | null;
  lastActivityAt: number;
}

const g = globalThis as unknown as { __loomHlsJobs?: Map<string, GenerationJob> };
const activeJobs = (g.__loomHlsJobs ??= new Map<string, GenerationJob>());

function cacheDir(ci: string): string {
  return join(VIDEO_CACHE_DIR, ci, HLS_PROFILE);
}

function segmentFile(index: number): string {
  return `segment_${String(index).padStart(3, "0")}.m4s`;
}

async function isSegmentValid(dir: string, index: number): Promise<boolean> {
  try {
    return (await stat(join(dir, segmentFile(index)))).size > 0;
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

async function advanceFrontier(job: GenerationJob): Promise<void> {
  const dir = cacheDir(job.contentIdentityId);
  while (await isSegmentValid(dir, job.frontier + 1)) job.frontier++;
}

/** Jobs whose range covers `index` get their idle timer refreshed. */
export function recordActivity(ci: string, index?: number): void {
  for (const job of activeJobs.values()) {
    if (job.contentIdentityId !== ci) continue;
    if (index === undefined || (index >= job.regionStart && index <= job.frontier + JOIN_LOOKAHEAD + 1)) {
      job.lastActivityAt = Date.now();
    }
  }
}

function runningCount(): number {
  let n = 0;
  for (const j of activeJobs.values()) if (j.process) n++;
  return n;
}

function stopLeastRecentlyUsed(): boolean {
  let victim: GenerationJob | null = null;
  for (const j of activeJobs.values()) {
    if (j.process && (!victim || j.lastActivityAt < victim.lastActivityAt)) victim = j;
  }
  if (!victim?.process) return false;
  victim.process.kill("SIGTERM");
  return true;
}

function spawnFfmpeg(absoluteSource: string, dir: string, job: GenerationJob): void {
  const start = job.regionStart;
  const startTime = start * SEGMENT_DURATION;
  const initName = `init_r${start}.mp4`;
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", String(startTime),
    "-i", absoluteSource,
    // Only the first video and (optional) audio stream: subtitle/data tracks
    // in MKV files can't go into fMP4 and would make FFmpeg fail.
    "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    // 8-bit output (10-bit HEVC sources would otherwise produce High10
    // H.264 that browsers can't decode) and at most 1080p.
    "-pix_fmt", "yuv420p",
    "-vf", "scale=w=-2:h='min(1080,ih)':flags=bicubic",
    "-c:a", "aac", "-b:a", "160k", "-ac", "2",
    "-force_key_frames", `expr:gte(t,n_forced*${SEGMENT_DURATION})`,
    "-hls_time", String(SEGMENT_DURATION),
    "-hls_segment_type", "fmp4",
    "-hls_flags", "independent_segments+temp_file",
    "-hls_list_size", "0",
    "-start_number", String(start),
    "-output_ts_offset", String(startTime),
    "-hls_segment_filename", join(dir, "segment_%03d.m4s"),
    "-hls_fmp4_init_filename", initName,
    join(dir, `_region_${start}.m3u8`),
  ];

  const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  job.process = ffmpeg;
  let errTail = "";
  ffmpeg.stderr?.on("data", (c: Buffer) => {
    errTail = (errTail + c.toString()).slice(-2000);
  });

  // Publish this region's init segment as the shared init.mp4 once the first
  // segment is out (FFmpeg has fully written the init file by then).
  const initPoll = setInterval(async () => {
    if (await exists(join(dir, "init.mp4"))) return clearInterval(initPoll);
    if (await isSegmentValid(dir, start)) {
      clearInterval(initPoll);
      const tmp = join(dir, `init.mp4.${process.pid}.${start}.tmp`);
      await copyFile(join(dir, initName), tmp)
        .then(() => rename(tmp, join(dir, "init.mp4")))
        .catch(() => {});
    }
  }, 200);

  const done = (code: number | null) => {
    clearInterval(initPoll);
    if (code !== 0 && code !== null && code !== 255) {
      console.warn(`[HLS] FFmpeg exited ${code} for ${job.contentIdentityId} region=${start}: ${errTail.trim().split("\n").slice(-3).join(" | ")}`);
    }
    job.process = null;
    activeJobs.delete(`${job.contentIdentityId}/${start}`);
  };
  ffmpeg.on("close", done);
  ffmpeg.on("error", (err) => {
    console.error("[HLS] FFmpeg spawn error:", err.message);
    done(-1);
  });
}

/**
 * Make sure something is producing `segmentIndex`. Returns false if the
 * transcode limit is reached and nothing could be stopped (caller -> 503).
 */
export async function ensureGeneration(
  ci: string,
  segmentIndex: number,
  absoluteSource: string
): Promise<boolean> {
  const dir = cacheDir(ci);
  await mkdir(dir, { recursive: true });
  if (await isSegmentValid(dir, segmentIndex)) return true;

  for (const job of activeJobs.values()) {
    if (job.contentIdentityId !== ci || !job.process) continue;
    await advanceFrontier(job);
    if (segmentIndex >= job.regionStart && segmentIndex <= job.frontier + JOIN_LOOKAHEAD) {
      job.lastActivityAt = Date.now();
      return true;
    }
  }

  const key = `${ci}/${segmentIndex}`;
  if (activeJobs.has(key)) return true;

  if (runningCount() >= MAX_TRANSCODES && !stopLeastRecentlyUsed()) return false;

  const job: GenerationJob = {
    contentIdentityId: ci,
    regionStart: segmentIndex,
    frontier: segmentIndex - 1,
    process: null,
    lastActivityAt: Date.now(),
  };
  activeJobs.set(key, job);
  spawnFfmpeg(absoluteSource, dir, job);
  return true;
}

setInterval(() => {
  for (const job of activeJobs.values()) {
    if (job.process && Date.now() - job.lastActivityAt >= IDLE_GRACE_MS) job.process.kill("SIGTERM");
  }
}, 5_000).unref?.();

export async function waitForFile(path: string, timeoutMs = SEGMENT_WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await stat(path)).size > 0) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, SEGMENT_POLL_MS));
  }
  return false;
}

/**
 * Full-length VOD manifest built from the probed duration, so the player
 * shows the whole timeline immediately and can seek anywhere.
 */
export function synthesizeManifest(durationSeconds: number): string {
  const total = Math.max(1, Math.ceil(durationSeconds / SEGMENT_DURATION));
  const last = durationSeconds - (total - 1) * SEGMENT_DURATION;
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${SEGMENT_DURATION}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-MAP:URI="init.mp4"`,
  ];
  for (let i = 0; i < total; i++) {
    lines.push(`#EXTINF:${i === total - 1 ? Math.max(last, 0.1).toFixed(6) : SEGMENT_DURATION.toFixed(6)},`);
    lines.push(segmentFile(i));
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}

/** Duration from the VideoCache row (set by the scanner or a previous probe), else ffprobe once. */
export async function getOrProbeDuration(ci: string, absoluteSource: string): Promise<number | null> {
  const cached = await prisma.videoCache.findUnique({
    where: { contentIdentityId_profileVersion: { contentIdentityId: ci, profileVersion: HLS_PROFILE } },
    select: { durationSeconds: true },
  });
  if (cached?.durationSeconds) return cached.durationSeconds;

  const probe = await probeVideo(absoluteSource);
  if (!probe.durationSeconds) return null;
  await prisma.videoCache
    .upsert({
      where: { contentIdentityId_profileVersion: { contentIdentityId: ci, profileVersion: HLS_PROFILE } },
      update: { durationSeconds: probe.durationSeconds, lastAccessedAt: new Date() },
      create: {
        contentIdentityId: ci,
        profileVersion: HLS_PROFILE,
        cacheDir: `videos/${ci}/${HLS_PROFILE}`,
        durationSeconds: probe.durationSeconds,
      },
    })
    .catch((err) => console.warn("[HLS] could not record duration:", err?.message));
  return probe.durationSeconds;
}

export async function touchVideoCache(ci: string): Promise<void> {
  await prisma.videoCache
    .updateMany({ where: { contentIdentityId: ci, profileVersion: HLS_PROFILE }, data: { lastAccessedAt: new Date() } })
    .catch(() => {});
}

export function getInitSegmentPath(ci: string): string {
  return join(cacheDir(ci), "init.mp4");
}

export function getSegmentPath(ci: string, index: number): string {
  return join(cacheDir(ci), segmentFile(index));
}

/** Size of everything in a cache dir (for the Settings "video cache" figure). */
export async function cacheDirSize(ci: string): Promise<number> {
  const dir = cacheDir(ci);
  let total = 0;
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    total += (await stat(join(dir, f)).catch(() => null))?.size ?? 0;
  }
  return total;
}
