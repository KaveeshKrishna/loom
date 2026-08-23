import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { checkAccess } from "@/lib/acl";
import { getArchiveStatus } from "@/lib/archive";
import { sanitizePath } from "@/lib/utils";
import { join } from "path";
import { headers } from "next/headers";
import { stat } from "fs/promises";
import { spawn } from "child_process";

const MEDIA_ROOT = "/media";

/**
 * Probe the video codec of a file using ffprobe.
 * Returns the codec name (e.g. "hevc", "h264") or null if unavailable.
 */
async function probeVideoCodec(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", () => resolve(out.trim().toLowerCase() || null));
    proc.on("error", () => resolve(null));
  });
}

/**
 * GET /api/files/transcode?path=<relativePath>
 *
 * Transcodes a video file to H.264/AAC in an MP4 container using ffmpeg,
 * streaming the output directly to the browser. This allows HEVC (.MOV, .mp4)
 * files that browsers can't decode natively to be played.
 */
export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rawPath = req.nextUrl.searchParams.get("path") ?? "";
  const relativePath = sanitizePath(rawPath);
  if (!relativePath) return NextResponse.json({ error: "Path required" }, { status: 400 });

  const allowed = await checkAccess(user.id, user.role, relativePath);
  if (!allowed) return NextResponse.json({ error: "Access denied" }, { status: 403 });

  const archiveStatus = await getArchiveStatus();
  if (archiveStatus !== "Online") {
    return NextResponse.json({ error: "Archive offline" }, { status: 503 });
  }

  const absolutePath = join(MEDIA_ROOT, relativePath);
  if (!absolutePath.startsWith(MEDIA_ROOT + "/")) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    await stat(absolutePath);
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  // Stream transcode via ffmpeg: convert to H.264/AAC MP4
  const ffmpeg = spawn("ffmpeg", [
    "-i", absolutePath,
    "-c:v", "libx264",
    "-preset", "ultrafast",   // fastest encode, minimal latency
    "-crf", "23",             // good quality
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "frag_keyframe+empty_moov+faststart", // fragmented MP4 so browser can start playback immediately
    "-f", "mp4",
    "pipe:1",                 // output to stdout
  ]);

  const readableStream = new ReadableStream({
    start(controller) {
      ffmpeg.stdout.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      ffmpeg.stdout.on("end", () => controller.close());
      ffmpeg.stdout.on("error", (err) => controller.error(err));
      ffmpeg.stderr.on("data", () => {}); // suppress stderr noise
    },
    cancel() {
      ffmpeg.kill("SIGKILL");
    },
  });

  return new NextResponse(readableStream, {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-store",
      "X-Transcoded": "1",
    },
  });
}

/**
 * GET /api/files/transcode?path=<relativePath>&probe=1
 *
 * Returns the video codec info without transcoding.
 */
export async function HEAD(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return new NextResponse(null, { status: 401 });

  const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
  if (!user) return new NextResponse(null, { status: 401 });

  const rawPath = req.nextUrl.searchParams.get("path") ?? "";
  const relativePath = sanitizePath(rawPath);
  if (!relativePath) return new NextResponse(null, { status: 400 });

  const allowed = await checkAccess(user.id, user.role, relativePath);
  if (!allowed) return new NextResponse(null, { status: 403 });

  const absolutePath = join(MEDIA_ROOT, relativePath);
  const codec = await probeVideoCodec(absolutePath);

  return new NextResponse(null, {
    status: 200,
    headers: {
      "X-Video-Codec": codec ?? "unknown",
    },
  });
}
