import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { checkAccess } from "@/lib/acl";
import { resolveAndValidate, TRASH_DIR, ensureUnderMediaRoot } from "@/lib/path-security";
import { checkCollision } from "@/lib/collision";
import { acquireMultiPathLock } from "@/lib/fs-locks";
import { initFs } from "@/lib/fs-operations";
import fs from "fs/promises";
import path from "path";
import type { Role } from "@prisma/client";

export async function POST(req: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { user } = session;

    await initFs();

    const body = await req.json();
    const { fileNodeIds } = body as { fileNodeIds: string[] };

    if (!Array.isArray(fileNodeIds) || fileNodeIds.length === 0) {
      return NextResponse.json({ error: "No fileNodeIds provided" }, { status: 400 });
    }

    const results = [];

    for (const fileNodeId of fileNodeIds) {
      // Find TrashItem and FileNode
      const trashItem = await prisma.trashItem.findUnique({
        where: { fileNodeId },
        include: { fileNode: true },
      });

      if (!trashItem) {
        results.push({ id: fileNodeId, error: "Trash item not found" });
        continue;
      }

      const { originalPath, trashPath, fileNode } = trashItem;

      // Check ACL for the original path
      const allowed = await checkAccess(user.id, (user as unknown as { role: Role }).role, originalPath);
      if (!allowed) {
        results.push({ id: fileNodeId, error: "Access denied to original path" });
        continue;
      }

      // Resolve destination (original path) and trash source path
      let destAbsPath: string;
      try {
        // mustExist = false because we are restoring it to this location
        destAbsPath = await resolveAndValidate(originalPath, "media", false);
        ensureUnderMediaRoot(destAbsPath);
      } catch {
        results.push({ id: fileNodeId, error: "Invalid destination path" });
        continue;
      }

      const trashAbsPath = path.join(TRASH_DIR, trashPath);

      // Lock both source and destination
      const releaseLocks = await acquireMultiPathLock([trashAbsPath, destAbsPath]);

      try {
        // Verify source physically exists in trash
        try {
          await fs.access(trashAbsPath);
        } catch {
          throw new Error("Physical file is missing from trash");
        }

        // Check for collision at destination
        const collision = await checkCollision(destAbsPath, originalPath);
        if (collision.exists) {
          results.push({ id: fileNodeId, error: "Conflict: File or folder already exists at destination", code: 409 });
          continue;
        }

        // Physical move
        await fs.rename(trashAbsPath, destAbsPath);

        // Update DB
        await prisma.$transaction(async (tx) => {
          await tx.fileNode.update({
            where: { id: fileNode.id },
            data: { inTrash: false, relativePath: originalPath },
          });

          const rootTrashPath = `.LoomTrash/${trashPath}`;
          const descendants = await tx.fileNode.findMany({
            where: { 
              relativePath: { startsWith: rootTrashPath + "/" },
              trashItem: { is: null }
            },
            select: { id: true, relativePath: true }
          });
          
          for (const desc of descendants) {
            const newRel = originalPath + desc.relativePath.slice(rootTrashPath.length);
            await tx.fileNode.update({
              where: { id: desc.id },
              data: { inTrash: false, relativePath: newRel },
            });
          }

          await tx.trashItem.delete({
            where: { id: trashItem.id },
          });

          await tx.auditLog.create({
            data: {
              userId: user.id,
              action: "RESTORE",
              details: { path: originalPath, trashPath },
            },
          });
        });

        results.push({ id: fileNodeId, success: true });
      } catch (err: unknown) {
        console.error("Restore error for", originalPath, err);
        results.push({ id: fileNodeId, error: (err as Error).message });
      } finally {
        releaseLocks();
      }
    }

    return NextResponse.json({ results });
  } catch (err: unknown) {
    console.error("Restore POST error:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
