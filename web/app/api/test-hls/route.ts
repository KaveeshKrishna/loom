import { NextResponse } from "next/server";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";

export async function GET() {
  const absolutePath = "/srv/apps/loom/web/package.json";
  try {
    const fileStat = await stat(absolutePath);
    const stream = createReadStream(absolutePath);
    const nodeReadable = Readable.toWeb(stream) as ReadableStream;
    return new NextResponse(nodeReadable, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(fileStat.size),
        "Cache-Control": "public, max-age=31536000, immutable",
        "Accept-Ranges": "bytes",
      },
    });
  } catch (err) {
    console.error(`[TEST] streamFile failed for ${absolutePath}:`, err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
