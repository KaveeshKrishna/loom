import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { checkAccess } from "@/lib/acl";
import { resolveAndValidate } from "@/lib/path-security";
import { acquireMultiPathLock } from "@/lib/fs-locks";
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
    const { sourcePath, newName, action = "skip" } = body as { 
      sourcePath: string, 
      newName: string,
      action?: "skip" | "replace" | "keep_both"
    };

    if (!sourcePath || !newName) {
      return NextResponse.json({ error: "Invalid parameters" }, { status: 400 });
    }

    const srcAllowed = await checkAccess(user.id, (user as unknown as { role: Role }).role, sourcePath);
    if (!srcAllowed) return NextResponse.json({ error: "Access denied to source" }, { status: 403 });

    let srcAbs: string;
    try {
      srcAbs = await resolveAndValidate(sourcePath, "media", true);
    } catch {
      return NextResponse.json({ error: "Source not found" }, { status: 404 });
    }

    const destDirAbs = path.dirname(srcAbs);
    const destDirRel = path.dirname(sourcePath);

    let targetAbs = path.join(destDirAbs, newName);
    let targetRel = path.posix.join(destDirRel, newName);

    // Lock both source and target
    const releaseLocks = await acquireMultiPathLock([srcAbs, targetAbs]);

    try {
      const fileNode = await prisma.fileNode.findFirst({ where: { relativePath: sourcePath } });
      if (!fileNode) {
        throw new Error("Source file node not found in DB");
      }

      const collision = await checkCollision(targetAbs, targetRel);
      
      if (collision.exists) {
        if (action === "skip") {
          return NextResponse.json({ path: sourcePath, skipped: true });
        } else if (action === "replace") {
          if (collision.node) {
             await prisma.fileNode.delete({ where: { id: collision.node.id } });
          }
        } else if (action === "keep_both") {
          const uniqueName = await generateUniqueFilename(destDirAbs, newName);
          targetAbs = path.join(destDirAbs, uniqueName);
          targetRel = path.posix.join(destDirRel, uniqueName);
        }
      }

      // Physical rename
      await fs.rename(srcAbs, targetAbs);

      // Update DB
      await prisma.$transaction(async (tx) => {
        await tx.fileNode.update({
          where: { id: fileNode.id },
          data: { relativePath: targetRel, name: newName },
        });

        const descendants = await tx.fileNode.findMany({
          where: { relativePath: { startsWith: sourcePath + "/" } },
          select: { id: true, relativePath: true }
        });
        for (const desc of descendants) {
          const newRel = targetRel + desc.relativePath.slice(sourcePath.length);
          await tx.fileNode.update({
            where: { id: desc.id },
            data: { relativePath: newRel }
          });
        }

        await tx.auditLog.create({
          data: {
            userId: user.id,
            action: "RENAME",
            details: { source: sourcePath, dest: targetRel },
          },
        });
      });

      return NextResponse.json({ path: sourcePath, success: true, targetRel });
    } catch (err: unknown) {
      console.error("Rename error for", sourcePath, err);
      return NextResponse.json({ path: sourcePath, error: (err as Error).message }, { status: 500 });
    } finally {
      releaseLocks();
    }
  } catch (err: unknown) {
    console.error("Rename POST error:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
