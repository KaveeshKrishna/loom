/**
 * HLS Manager — Region-Based, Demand-Driven HLS Generation
 *
 * Architecture:
 *  - One FFmpeg process per (contentIdentityId, profileVersion, regionStartSegment).
 *  - Multiple clients seeking the same region share one FFmpeg process.
 *  - Activity-based lifecycle: FFmpeg is terminated after 30s of no segment/manifest requests.
 *  - Atomic segment finalization: segments written to .tmp then renamed.
 *  - Completed segments are immutable — never overwritten.
 *  - Crash-safe: only finalized segments are served. .tmp files are ignored.
 */

import { spawn, ChildProcess } from "child_process";
import { mkdir, readdir, stat } from "fs/promises";
import { join } from "path";
import { probeVideo } from "./video-compat";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const CACHE_ROOT = process.env.CACHE_ROOT ?? "/cache";
const VIDEO_CACHE_DIR = join(CACHE_ROOT, "videos");


// 6-second segments — good startup/seek balance
const SEGMENT_DURATION = 6;
// Grace period before stopping an idle FFmpeg process
const IDLE_GRACE_MS = 30_000;
// Max time to wait for a segment before returning 503
const SEGMENT_WAIT_MS = 30_000;
// How often to poll for a segment appearing on disk
const SEGMENT_POLL_MS = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GenerationJob {
  contentIdentityId: string;
  profileVersion: string;
  regionStart: number;        // segment index this job started from
  process: ChildProcess | null;
  lastActivityAt: number;
  graceTimer: NodeJS.Timeout | null;
  /** Resolves when the job terminates (naturally or via SIGTERM) */
  done: Promise<void>;
  _resolve: () => void;
}

// Key: `${contentIdentityId}/${profileVersion}/${regionStart}`
const activeJobs = new Map<string, GenerationJob>();

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function cacheDir(contentIdentityId: string, profileVersion: string): string {
  return join(VIDEO_CACHE_DIR, contentIdentityId, profileVersion);
}

function segmentPath(dir: string, index: number): string {
  return join(dir, `segment_${String(index).padStart(3, "0")}.m4s`);
}

function jobKey(contentIdentityId: string, profileVersion: string, regionStart: number): string {
  return `${contentIdentityId}/${profileVersion}/${regionStart}`;
}

// ---------------------------------------------------------------------------
// Segment validity
// ---------------------------------------------------------------------------

/** A segment is valid only if its final (non-.tmp) file exists with non-zero size. */
async function isSegmentValid(dir: string, index: number): Promise<boolean> {
  const path = segmentPath(dir, index);
  try {
    const s = await stat(path);
    return s.size > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Startup recovery: scan existing cache dirs and return knowledge of
// which segments are already finalized on disk.
// ---------------------------------------------------------------------------

export async function getCompletedSegments(contentIdentityId: string, profileVersion: string): Promise<Set<number>> {
  const dir = cacheDir(contentIdentityId, profileVersion);
  const result = new Set<number>();
  try {
    const files = await readdir(dir);
    for (const f of files) {
      const m = f.match(/^segment_(\d+)\.m4s$/);
      if (m) {
        const idx = parseInt(m[1], 10);
        // Verify non-zero size — guards against crashed partial writes
        const s = await stat(join(dir, f)).catch(() => null);
        if (s && s.size > 0) result.add(idx);
      }
    }
  } catch {}
  return result;
}

// ---------------------------------------------------------------------------
// Activity tracking
// ---------------------------------------------------------------------------

export function recordActivity(contentIdentityId: string, profileVersion: string): void {
  // Update lastActivityAt on any active job for this file
  for (const [, job] of activeJobs) {
    if (job.contentIdentityId === contentIdentityId && job.profileVersion === profileVersion) {
      job.lastActivityAt = Date.now();
      // Cancel any pending grace timer
      if (job.graceTimer) {
        clearTimeout(job.graceTimer);
        job.graceTimer = null;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// FFmpeg generation
// ---------------------------------------------------------------------------

async function spawnFfmpeg(
  absoluteSource: string,
  dir: string,
  startSegment: number,
  durationSeconds: number,
  job: GenerationJob
): Promise<void> {
  const startTimeSeconds = startSegment * SEGMENT_DURATION;

  // Build FFmpeg args
  // -ss on input side: seeks to keyframe at or before startTime, then decodes forward.
  // -output_ts_offset: shifts output PTS/DTS so segment timestamps map to the global timeline.
  // -hls_start_number: ensures output filenames match the correct segment indices.
  // Segments are output to .tmp filenames via a custom segment naming approach.
  // We write to a dummy manifest (not served) because we synthesize our own manifest.
  const args = [
    "-y",
    "-ss", String(startTimeSeconds),
    "-i", absoluteSource,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-b:a", "192k",
    // Force keyframes at exact 6s boundaries for clean segment alignment
    "-force_key_frames", `expr:gte(t,n_forced*${SEGMENT_DURATION})`,
    "-hls_time", String(SEGMENT_DURATION),
    "-hls_segment_type", "fmp4",
    "-hls_flags", "independent_segments+temp_file",
    "-hls_list_size", "0",
    "-start_number", String(startSegment),
    // Shift output timestamps to the global presentation timeline
    "-output_ts_offset", String(startTimeSeconds),
    // Segment filename pattern
    "-hls_segment_filename", join(dir, "segment_%03d.m4s"),
    "-hls_fmp4_init_filename", "init.mp4",
    // Dummy manifest (not served — we synthesize our own)
    join(dir, "_generation.m3u8"),
  ];

  console.log(`[HLS] Spawning FFmpeg: ${job.contentIdentityId} region=${startSegment} src=${absoluteSource}`);
  console.log(`[HLS] FFmpeg args: ${args.join(" ")}`);

  const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  job.process = ffmpeg;

  // Pipe FFmpeg stderr to console so we can see errors in docker logs
  ffmpeg.stderr?.on("data", (chunk: Buffer) => {
    const lines = chunk.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      // Only log important lines (errors, warnings, progress) to reduce noise
      if (/error|warning|invalid|failed|unable|cannot|no such/i.test(line)) {
        console.error(`[FFmpeg] ${line}`);
      }
    }
  });

  return new Promise((resolve) => {
    ffmpeg.on("close", async (code) => {
      if (code === 0) {
        console.log(`[HLS] Generation complete: ${job.contentIdentityId} region=${startSegment}`);
      } else {
        console.warn(`[HLS] FFmpeg exited with code ${code}: ${job.contentIdentityId} region=${startSegment}`);
      }
      job.process = null;
      job._resolve();
      resolve();
    });
    ffmpeg.on("error", (err) => {
      console.error("[HLS] FFmpeg spawn error:", err);
      job.process = null;
      job._resolve();
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Start or join a generation job for a region
// ---------------------------------------------------------------------------

/**
 * Ensures a generation job is active for the region that covers `segmentIndex`.
 * If a job already covers this region, joins it.
 * If not, starts a new FFmpeg process from `segmentIndex`.
 *
 * Deduplication: if multiple callers request the same region concurrently,
 * only one FFmpeg process is spawned.
 */
export async function ensureGeneration(
  contentIdentityId: string,
  profileVersion: string,
  segmentIndex: number,
  absoluteSource: string,
  durationSeconds: number
): Promise<void> {
  const dir = cacheDir(contentIdentityId, profileVersion);
  console.log(`[HLS] ensureGeneration: ${contentIdentityId} seg=${segmentIndex} dir=${dir}`);
  await mkdir(dir, { recursive: true });

  // Check if this specific segment is already complete
  if (await isSegmentValid(dir, segmentIndex)) {
    console.log(`[HLS] Segment ${segmentIndex} already valid on disk`);
    recordActivity(contentIdentityId, profileVersion);
    return;
  }

  // Find an existing job that will eventually produce this segment
  for (const [key, job] of activeJobs) {
    if (
      job.contentIdentityId === contentIdentityId &&
      job.profileVersion === profileVersion &&
      job.regionStart <= segmentIndex &&
      job.process !== null // still running
    ) {
      console.log(`[HLS] Joining existing job ${key} for seg=${segmentIndex}`);
      recordActivity(contentIdentityId, profileVersion);
      return; // join existing job — segment will appear eventually
    }
  }

  // No suitable active job — start a new one from this segment
  const key = jobKey(contentIdentityId, profileVersion, segmentIndex);

  // Double-check: another concurrent caller may have just started one
  if (activeJobs.has(key)) {
    console.log(`[HLS] Race: job ${key} already registered`);
    recordActivity(contentIdentityId, profileVersion);
    return;
  }

  console.log(`[HLS] Starting new FFmpeg job: key=${key}`);

  let _resolve!: () => void;
  const done = new Promise<void>((res) => { _resolve = res; });

  const job: GenerationJob = {
    contentIdentityId,
    profileVersion,
    regionStart: segmentIndex,
    process: null,
    lastActivityAt: Date.now(),
    graceTimer: null,
    done,
    _resolve,
  };

  activeJobs.set(key, job);

  // Run FFmpeg asynchronously — callers poll for the segment to appear
  spawnFfmpeg(absoluteSource, dir, segmentIndex, durationSeconds, job)
    .catch((err) => console.error(`[HLS] spawnFfmpeg threw:`, err))
    .finally(() => {
      activeJobs.delete(key);
    });
}

// ---------------------------------------------------------------------------
// Check idle and stop FFmpeg if no recent activity
// ---------------------------------------------------------------------------

// Background interval that checks all active jobs for idleness
setInterval(() => {
  for (const [, job] of activeJobs) {
    if (Date.now() - job.lastActivityAt >= IDLE_GRACE_MS && job.process) {
      console.log(`[HLS] Idle timeout — sending SIGTERM: ${job.contentIdentityId}`);
      job.process.kill("SIGTERM");
    }
  }
}, 5_000);

// ---------------------------------------------------------------------------
// Wait for a segment to appear on disk (bounded)
// ---------------------------------------------------------------------------

/**
 * Polls for a segment to become available on disk.
 * Returns true if found within SEGMENT_WAIT_MS, false otherwise (caller should 503).
 */
export async function waitForSegment(
  contentIdentityId: string,
  profileVersion: string,
  segmentIndex: number
): Promise<boolean> {
  const dir = cacheDir(contentIdentityId, profileVersion);
  const deadline = Date.now() + SEGMENT_WAIT_MS;

  while (Date.now() < deadline) {
    if (await isSegmentValid(dir, segmentIndex)) return true;
    await new Promise((r) => setTimeout(r, SEGMENT_POLL_MS));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Manifest synthesis
// ---------------------------------------------------------------------------

/**
 * Synthesizes a full VOD HLS manifest from ffprobe duration.
 * ALL segments appear in the manifest immediately, even if not yet generated.
 * This allows hls.js to display the full duration and seek to any region.
 *
 * Segments that don't yet exist will return 503 when requested — hls.js retries.
 */
export function synthesizeManifest(
  contentIdentityId: string,
  profileVersion: string,
  durationSeconds: number
): string {
  const totalSegments = Math.ceil(durationSeconds / SEGMENT_DURATION);
  const lastSegmentDuration = durationSeconds - (totalSegments - 1) * SEGMENT_DURATION;

    const lines: string[] = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      `#EXT-X-TARGETDURATION:${SEGMENT_DURATION}`,
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      `#EXT-X-MAP:URI="init.mp4"`,
    ];

    for (let i = 0; i < totalSegments; i++) {
      const dur = i === totalSegments - 1 ? lastSegmentDuration.toFixed(6) : `${SEGMENT_DURATION}.000000`;
      const name = `segment_${String(i).padStart(3, "0")}.m4s`;
      lines.push(`#EXTINF:${dur},`);
      lines.push(name);
    }

  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Duration: get or probe
// ---------------------------------------------------------------------------

export async function getOrProbeDuration(
  contentIdentityId: string,
  profileVersion: string,
  absoluteSource: string
): Promise<number | null> {
  // Check DB first
  const cached = await prisma.videoCache.findUnique({
    where: { contentIdentityId_profileVersion: { contentIdentityId, profileVersion } },
    select: { durationSeconds: true },
  });
  if (cached?.durationSeconds) return cached.durationSeconds;

  // Run ffprobe
  const probe = await probeVideo(absoluteSource);
  if (!probe.durationSeconds) return null;

  // Upsert VideoCache with duration
  await prisma.videoCache.upsert({
    where: { contentIdentityId_profileVersion: { contentIdentityId, profileVersion } },
    update: { durationSeconds: probe.durationSeconds, lastAccessedAt: new Date() },
    create: {
      contentIdentityId,
      profileVersion,
      cacheDir: `videos/${contentIdentityId}/${profileVersion}`,
      durationSeconds: probe.durationSeconds,
    },
  }).catch(() => {});

  return probe.durationSeconds;
}

// ---------------------------------------------------------------------------
// Update lastAccessedAt on VideoCache DB record
// ---------------------------------------------------------------------------

export async function touchVideoCache(contentIdentityId: string, profileVersion: string): Promise<void> {
  await prisma.videoCache.updateMany({
    where: { contentIdentityId, profileVersion },
    data: { lastAccessedAt: new Date() },
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Get init.mp4 path
// ---------------------------------------------------------------------------

export function getInitSegmentPath(contentIdentityId: string, profileVersion: string): string {
  return join(cacheDir(contentIdentityId, profileVersion), "init.mp4");
}

export function getSegmentPath(contentIdentityId: string, profileVersion: string, index: number): string {
  return segmentPath(cacheDir(contentIdentityId, profileVersion), index);
}

export function getCacheDir(contentIdentityId: string, profileVersion: string): string {
  return cacheDir(contentIdentityId, profileVersion);
}
