import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { checkAccess } from "@/lib/acl";
import { resolveAndValidate, TRASH_DIR } from "@/lib/path-security";
import { acquirePathLock } from "@/lib/fs-locks";
import { initFs } from "@/lib/fs-operations";
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "node:crypto";
import type { Role } from "@prisma/client";

export async function GET() {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { user } = session;

    const isOwner = (user as unknown as { role: Role }).role === "OWNER";
    const trashItems = await prisma.trashItem.findMany({
      where: isOwner ? undefined : { deletedByUserId: user.id },
      include: { fileNode: true },
      orderBy: { deletedAt: "desc" },
    });

    for (const item of trashItems) {
      if (item.fileNode.type === "DIRECTORY") {
        const result = await prisma.fileNode.aggregate({
          _sum: { size: true },
          where: { 
            relativePath: { startsWith: item.fileNode.relativePath + "/" },
            inTrash: true
          }
        });
        item.fileNode.size = result._sum.size ?? BigInt(0);
      }
    }

    return NextResponse.json(JSON.parse(
      JSON.stringify({ trashItems }, (_k, v) => typeof v === "bigint" ? v.toString() : v)
    ));

  } catch (err: unknown) {
    console.error("Get trash list error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}


export async function POST(req: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { user } = session;

    await initFs(); // Ensure .LoomTrash exists

    const body = await req.json();
    const { paths } = body as { paths: string[] };

    if (!Array.isArray(paths) || paths.length === 0) {
      return NextResponse.json({ error: "No paths provided" }, { status: 400 });
    }

    const results = [];

    for (const relativePath of paths) {
      const allowed = await checkAccess(user.id, (user as unknown as { role: Role }).role, relativePath);
      if (!allowed) {
        results.push({ path: relativePath, error: "Access denied" });
        continue;
      }

      let absPath;
      try {
        absPath = await resolveAndValidate(relativePath, "media", true);
      } catch {
        results.push({ path: relativePath, error: "Invalid or missing path" });
        continue;
      }

      const releaseLock = await acquirePathLock(absPath);

      try {
        const fileNode = await prisma.fileNode.findFirst({
          where: { relativePath, inTrash: false },
        });

        if (!fileNode) {
          results.push({ path: relativePath, error: "Node not found in DB or already in trash" });
          continue;
        }

        // Generate unique trash path
        const uniqueId = randomUUID();
        const baseName = path.basename(absPath);
        const trashFileName = `${uniqueId}_${baseName}`;
        const trashAbsPath = path.join(TRASH_DIR, trashFileName);
        const trashRelPath = trashFileName;

        // Physical move
        await fs.rename(absPath, trashAbsPath);

        // Update DB
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 15); // 15 days expiration

        const newRootRelPath = `.LoomTrash/${trashRelPath}`;

        await prisma.$transaction(async (tx) => {
          await tx.fileNode.update({
            where: { id: fileNode.id },
            data: { inTrash: true, relativePath: newRootRelPath },
          });

          const descendants = await tx.fileNode.findMany({
            where: { relativePath: { startsWith: relativePath + "/" } },
            select: { id: true, relativePath: true }
          });
          for (const desc of descendants) {
            const newRel = newRootRelPath + desc.relativePath.slice(relativePath.length);
            await tx.fileNode.update({
              where: { id: desc.id },
              data: { inTrash: true, relativePath: newRel }
            });
          }

          await tx.trashItem.create({
            data: {
              fileNodeId: fileNode.id,
              originalPath: relativePath,
              trashPath: trashRelPath,
              deletedByUserId: user.id,
              expiresAt,
            },
          });

          await tx.auditLog.create({
            data: {
              userId: user.id,
              action: "TRASH",
              details: { path: relativePath, trashPath: trashRelPath },
            },
          });
        });

        results.push({ path: relativePath, success: true });
      } catch (err: unknown) {
        console.error("Trash error for", relativePath, err);
        results.push({ path: relativePath, error: (err as Error).message });
      } finally {
        releaseLock();
      }
    }

    return NextResponse.json({ results });
  } catch (err: unknown) {
    console.error("Trash POST error:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { user } = session;

    if ((user as unknown as { role: Role }).role !== "OWNER") {
      return NextResponse.json({ error: "Only OWNER can empty the entire trash" }, { status: 403 });
    }

    const trashItems = await prisma.trashItem.findMany({
      include: { fileNode: true },
    });

    const results = [];
    let deletedCount = 0;

    for (const item of trashItems) {
      const trashAbsPath = path.join(TRASH_DIR, item.trashPath);
      const releaseLock = await acquirePathLock(trashAbsPath);

      try {
        await fs.rm(trashAbsPath, { recursive: true, force: true });
        
        await prisma.$transaction(async (tx) => {
          await tx.fileNode.deleteMany({
            where: { relativePath: { startsWith: `.LoomTrash/${item.trashPath}/` } },
          });
          
          await tx.fileNode.delete({
            where: { id: item.fileNodeId },
          });
        });

        deletedCount++;
      } catch (err: unknown) {
        console.error("Delete trash item error", item.id, err);
        results.push({ id: item.id, error: (err as Error).message });
      } finally {
        releaseLock();
      }
    }

    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "EMPTY_TRASH",
        details: { count: deletedCount, total: trashItems.length },
      },
    });

    return NextResponse.json({ success: true, deletedCount, results });
  } catch (err: unknown) {
    console.error("Empty Trash DELETE error:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

