import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { join } from "path";
import mime from "mime-types";
import { headers } from "next/headers";
import { Readable } from "stream";

const CACHE_ROOT = "/cache";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { path } = await params;
  const relativePath = path.map(decodeURIComponent).join("/");

  const absolutePath = join(CACHE_ROOT, relativePath);
  if (!absolutePath.startsWith(CACHE_ROOT + "/")) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    await stat(absolutePath);
    const mimeType = mime.lookup(absolutePath) || "image/webp";
    const stream = createReadStream(absolutePath);
    return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
