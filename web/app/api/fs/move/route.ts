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
    const { sourcePaths, destDir, action = "skip" } = body as { 
      sourcePaths: string[], 
      destDir: string,
      action?: "skip" | "replace" | "keep_both"
    };

    if (!Array.isArray(sourcePaths) || sourcePaths.length === 0 || destDir == null) {
      return NextResponse.json({ error: "Invalid parameters" }, { status: 400 });
    }

    const destAllowed = await checkAccess(user.id, (user as unknown as { role: Role }).role, destDir);
    if (!destAllowed) return NextResponse.json({ error: "Access denied to destination" }, { status: 403 });

    let destDirAbs: string;
    try {
      destDirAbs = await resolveAndValidate(destDir, "media", true);
    } catch {
      return NextResponse.json({ error: "Destination directory not found or invalid" }, { status: 404 });
    }

    const results = [];

    for (const srcRel of sourcePaths) {
      const srcAllowed = await checkAccess(user.id, (user as unknown as { role: Role }).role, srcRel);
      if (!srcAllowed) {
        results.push({ path: srcRel, error: "Access denied to source" });
        continue;
      }

      let srcAbs: string;
      try {
        srcAbs = await resolveAndValidate(srcRel, "media", true);
      } catch {
        results.push({ path: srcRel, error: "Source not found" });
        continue;
      }

      const fileName = path.basename(srcAbs);
      let targetAbs = path.join(destDirAbs, fileName);
      let targetRel = path.posix.join(destDir, fileName);

      // Lock source and target
      const releaseLocks = await acquireMultiPathLock([srcAbs, targetAbs]);

      try {
        const fileNode = await prisma.fileNode.findFirst({ where: { relativePath: srcRel } });
        if (!fileNode) {
          throw new Error("Source file node not found in DB");
        }

        const collision = await checkCollision(targetAbs, targetRel);
        
        if (collision.exists) {
          if (action === "skip") {
            results.push({ path: srcRel, skipped: true });
            continue;
          } else if (action === "replace") {
            // we will overwrite (we should technically delete the old file in DB if replacing, or merge?)
            if (collision.node) {
               await prisma.fileNode.delete({ where: { id: collision.node.id } });
            }
          } else if (action === "keep_both") {
            const uniqueName = await generateUniqueFilename(destDirAbs, fileName);
            targetAbs = path.join(destDirAbs, uniqueName);
            targetRel = path.posix.join(destDir, uniqueName);
          }
        }

        // Physical move
        await fs.rename(srcAbs, targetAbs);

        // Update DB
        await prisma.$transaction(async (tx) => {
          await tx.fileNode.update({
            where: { id: fileNode.id },
            data: { relativePath: targetRel, name: path.basename(targetRel) },
          });

          const descendants = await tx.fileNode.findMany({
            where: { relativePath: { startsWith: srcRel + "/" } },
            select: { id: true, relativePath: true }
          });
          for (const desc of descendants) {
            const newRel = targetRel + desc.relativePath.slice(srcRel.length);
            await tx.fileNode.update({
              where: { id: desc.id },
              data: { relativePath: newRel }
            });
          }

          await tx.auditLog.create({
            data: {
              userId: user.id,
              action: "MOVE",
              details: { source: srcRel, dest: targetRel },
            },
          });
        });

        results.push({ path: srcRel, success: true, targetRel });
      } catch (err: unknown) {
        console.error("Move error for", srcRel, err);
        results.push({ path: srcRel, error: (err as Error).message });
      } finally {
        releaseLocks();
      }
    }

    return NextResponse.json({ results });
  } catch (err: unknown) {
    console.error("Move POST error:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
