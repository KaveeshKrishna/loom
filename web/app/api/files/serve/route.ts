import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { checkAccess } from "@/lib/acl";
import { sanitizePath } from "@/lib/utils";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { join } from "path";
import mime from "mime-types";
import { headers } from "next/headers";
import { Readable } from "stream";

const MEDIA_ROOT = "/media";

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

  const absolutePath = join(MEDIA_ROOT, relativePath);
  if (!absolutePath.startsWith(MEDIA_ROOT + "/") && absolutePath !== MEDIA_ROOT) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    const fileStat = await stat(absolutePath);
    if (fileStat.isDirectory()) return NextResponse.json({ error: "Cannot serve directory" }, { status: 400 });

    const isDownload = req.nextUrl.searchParams.get("download") === "1";
    const mimeType = mime.lookup(absolutePath) || "application/octet-stream";
    const fileSize = fileStat.size;
    const rangeHeader = req.headers.get("range");

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const stream = createReadStream(absolutePath, { start, end });
      return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          "Content-Type": mimeType,
          "Cache-Control": "private, max-age=3600",
        },
      });
    }

    const filename = relativePath.split("/").pop()!;
    const stream = createReadStream(absolutePath);
    return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": isDownload ? "application/octet-stream" : mimeType,
        "Content-Length": String(fileSize),
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": `${isDownload ? "attachment" : "inline"}; filename="${filename}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}
