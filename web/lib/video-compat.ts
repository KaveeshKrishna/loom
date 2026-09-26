/**
 * video-compat.ts — decide whether a browser can play a video as-is.
 *
 * Browser-playable videos are streamed straight from disk with HTTP range
 * requests. Everything else goes through on-demand HLS (hls-manager.ts).
 */
import { spawn } from "child_process";

const INCOMPATIBLE_CONTAINERS = new Set([
  "video/quicktime", // MOV (often HEVC from phones; Firefox can't play MOV at all)
  "video/x-matroska",
  "video/avi",
  "video/x-msvideo",
  "video/mpeg",
  "video/x-mpeg",
  "video/mp2t",
  "video/x-ms-wmv",
  "video/x-flv",
  "video/3gpp",
]);

const NATIVE_VIDEO_CODECS = new Set(["h264", "vp8", "vp9", "av1"]);
const NATIVE_AUDIO_CODECS = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);

export interface VideoProbeResult {
  durationSeconds: number | null;
  codecName: string | null;
  pixFmt: string | null;
  width: number | null;
  height: number | null;
  audioCodec: string | null;
}

const EMPTY: VideoProbeResult = {
  durationSeconds: null,
  codecName: null,
  pixFmt: null,
  width: null,
  height: null,
  audioCodec: null,
};

/** ffprobe with a hard timeout so a damaged file can never hang a request. */
export async function probeVideo(absolutePath: string, timeoutMs = 20_000): Promise<VideoProbeResult> {
  return new Promise((resolve) => {
    const args = [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,codec_name,pix_fmt,width,height",
      "-of", "json",
      absolutePath,
    ];
    const chunks: Buffer[] = [];
    const proc = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.on("close", () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const streams: Record<string, unknown>[] = parsed?.streams ?? [];
        const v = streams.find((s) => s.codec_type === "video");
        const a = streams.find((s) => s.codec_type === "audio");
        resolve({
          durationSeconds: parseFloat(parsed?.format?.duration ?? "") || null,
          codecName: (v?.codec_name as string) ?? null,
          pixFmt: (v?.pix_fmt as string) ?? null,
          width: (v?.width as number) ?? null,
          height: (v?.height as number) ?? null,
          audioCodec: (a?.codec_name as string) ?? null,
        });
      } catch {
        resolve(EMPTY);
      }
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(EMPTY);
    });
  });
}

/** Pure decision from probe data. */
export function isProbeBrowserNative(mimeType: string | null, p: VideoProbeResult): boolean {
  if (mimeType && INCOMPATIBLE_CONTAINERS.has(mimeType)) return false;
  const codec = (p.codecName ?? "").toLowerCase();
  if (!NATIVE_VIDEO_CODECS.has(codec)) return false;
  // 10-bit H.264 (High 10) plays almost nowhere.
  if (codec === "h264" && p.pixFmt && /10|12/.test(p.pixFmt)) return false;
  if (p.audioCodec && !NATIVE_AUDIO_CODECS.has(p.audioCodec.toLowerCase())) return false;
  return true;
}

/**
 * Returns whether the browser can play this video natively. Uses the stored
 * result when the scanner (or an earlier request) already probed the file.
 */
export async function isBrowserNative(
  mimeType: string | null,
  absolutePath: string,
  storedCompatible: boolean | null
): Promise<{ compatible: boolean; probe: VideoProbeResult | null }> {
  if (storedCompatible !== null) return { compatible: storedCompatible, probe: null };
  if (mimeType && INCOMPATIBLE_CONTAINERS.has(mimeType)) return { compatible: false, probe: null };
  const probe = await probeVideo(absolutePath);
  return { compatible: isProbeBrowserNative(mimeType, probe), probe };
}
