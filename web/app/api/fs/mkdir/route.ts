import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { checkAccess } from "@/lib/acl";
import { resolveAndValidate } from "@/lib/path-security";
import { acquirePathLock } from "@/lib/fs-locks";
import { checkCollision, generateUniqueFilename } from "@/lib/collision";
import fs from "fs/promises";
import path from "path";
import type { Role } from "@prisma/client";

export async function POST(req: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { user } = session;

    const body = await req.json();
    const { parentPath, name } = body as { parentPath: string, name: string };

    if (!name || typeof parentPath !== "string") {
      return NextResponse.json({ error: "Invalid parameters" }, { status: 400 });
    }

    const parentAllowed = await checkAccess(user.id, (user as unknown as { role: Role }).role, parentPath || "/");
    if (!parentAllowed) return NextResponse.json({ error: "Access denied to parent directory" }, { status: 403 });

    let parentAbs: string;
    try {
      parentAbs = await resolveAndValidate(parentPath, "media", true);
    } catch {
      return NextResponse.json({ error: "Parent directory not found" }, { status: 404 });
    }

    let targetAbs = path.join(parentAbs, name);
    // For root-level folders, parentPath is "", so targetRel is just the name
    let targetRel = parentPath ? path.posix.join(parentPath, name) : name;

    const releaseLock = await acquirePathLock(targetAbs);

    try {
      const collision = await checkCollision(targetAbs, targetRel);
      if (collision.exists) {
        // Find a unique name
        const uniqueName = await generateUniqueFilename(parentAbs, name);
        targetAbs = path.join(parentAbs, uniqueName);
        targetRel = parentPath ? path.posix.join(parentPath, uniqueName) : uniqueName;
      }

      await fs.mkdir(targetAbs, { recursive: true });

      await prisma.$transaction(async (tx) => {
        await tx.fileNode.create({
          data: {
            relativePath: targetRel,
            name: path.basename(targetRel),
            type: "DIRECTORY",
            modifiedAt: new Date()
          }
        });

        await tx.auditLog.create({
          data: {
            userId: user.id,
            action: "MKDIR",
            details: { path: targetRel },
          },
        });
      });

      return NextResponse.json({ success: true, path: targetRel });
    } catch (err: unknown) {
      console.error("mkdir error", targetRel, err);
      return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    } finally {
      releaseLock();
    }
  } catch (err: unknown) {
    console.error("mkdir POST error:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
