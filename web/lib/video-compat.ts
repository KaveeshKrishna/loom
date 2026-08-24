import { spawn } from "child_process";

// ---------------------------------------------------------------------------
// Browser-compatible MIME types (fast path — no ffprobe needed)
// ---------------------------------------------------------------------------



const INCOMPATIBLE_MIME_TYPES = new Set([
  "video/quicktime",       // MOV
  "video/x-matroska",     // MKV
  "video/avi",
  "video/x-msvideo",      // AVI alternate
  "video/mpeg",
  "video/x-mpeg",
  "video/mp2t",           // MPEG-TS
]);

// Codecs that all modern browsers (Chrome, Firefox, Safari) support natively
const NATIVE_CODECS = new Set([
  "h264", "avc1", "avc",   // H.264
  "vp8",
  "vp9",
  "av1", "av01",
  "theora",
]);

// Codecs that require HLS transcoding
const INCOMPATIBLE_CODECS = new Set([
  "hevc", "hvc1", "hev1", "h265",   // H.265/HEVC
  "mpeg4",
  "divx", "xvid",
  "wmv1", "wmv2", "wmv3",
  "vc-1",
  "mpeg2video",
  "prores",
  "dnxhd",
]);

// ---------------------------------------------------------------------------
// ffprobe utilities
// ---------------------------------------------------------------------------

export interface VideoProbeResult {
  durationSeconds: number | null;
  codecName: string | null;
  mimeType: string | null;
}

export async function probeVideo(absolutePath: string): Promise<VideoProbeResult> {
  return new Promise((resolve) => {
    const args = [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_name,codec_type",
      "-select_streams", "v:0",
      "-of", "json",
      absolutePath,
    ];

    const chunks: Buffer[] = [];
    const proc = spawn("ffprobe", args);
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.on("close", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const parsed = JSON.parse(raw);
        const duration = parseFloat(parsed?.format?.duration ?? "0") || null;
        const codecName = parsed?.streams?.[0]?.codec_name ?? null;
        resolve({ durationSeconds: duration, codecName, mimeType: null });
      } catch {
        resolve({ durationSeconds: null, codecName: null, mimeType: null });
      }
    });
    proc.on("error", () => resolve({ durationSeconds: null, codecName: null, mimeType: null }));
  });
}

// ---------------------------------------------------------------------------
// Compatibility check
// ---------------------------------------------------------------------------

/**
 * Returns true if the browser can play this video natively (HTTP Range, no FFmpeg).
 * Returns false if HLS transcoding is required.
 *
 * Fast path: MIME type only. Slow path: ffprobe codec probe.
 */
export async function isBrowserNative(
  mimeType: string | null,
  absolutePath: string,
  storedCompatible: boolean | null
): Promise<{ compatible: boolean; codecName: string | null }> {
  // If already probed and stored in DB, trust it
  if (storedCompatible !== null) {
    return { compatible: storedCompatible, codecName: null };
  }

  // Definite incompatible by MIME type alone
  if (mimeType && INCOMPATIBLE_MIME_TYPES.has(mimeType)) {
    return { compatible: false, codecName: null };
  }

  // Probe codec for ambiguous types (video/mp4 could be H.264 or HEVC)
  const probe = await probeVideo(absolutePath);
  const codec = (probe.codecName ?? "").toLowerCase();

  if (INCOMPATIBLE_CODECS.has(codec)) {
    return { compatible: false, codecName: probe.codecName };
  }
  if (NATIVE_CODECS.has(codec)) {
    return { compatible: true, codecName: probe.codecName };
  }

  // Unknown codec — treat as incompatible (safe default)
  return { compatible: false, codecName: probe.codecName };
}
