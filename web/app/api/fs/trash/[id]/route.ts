import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { TRASH_DIR } from "@/lib/path-security";
import { acquirePathLock } from "@/lib/fs-locks";
import fs from "fs/promises";
import path from "path";


export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { user } = session;

    const { id } = await params;

    const trashItem = await prisma.trashItem.findUnique({
      where: { id },
      include: { fileNode: true },
    });

    if (!trashItem) {
      return NextResponse.json({ error: "Trash item not found" }, { status: 404 });
    }

    // Only OWNER can delete other users' trash.
    if (trashItem.deletedByUserId !== user.id && (user as unknown as { role: string }).role !== "OWNER") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const trashAbsPath = path.join(TRASH_DIR, trashItem.trashPath);
    const releaseLock = await acquirePathLock(trashAbsPath);

    try {
      // Physical delete
      await fs.rm(trashAbsPath, { recursive: true, force: true });

      // Delete DB records
      await prisma.$transaction(async (tx) => {
        await tx.fileNode.deleteMany({
          where: { relativePath: { startsWith: `.LoomTrash/${trashItem.trashPath}/` } },
        });

        // fileNode cascading delete should ideally drop the trashItem as well,
        // but let's be explicit if there are relationships to manage.
        await tx.fileNode.delete({
          where: { id: trashItem.fileNodeId },
        });

        await tx.auditLog.create({
          data: {
            userId: user.id,
            action: "PERMANENT_DELETE",
            details: { originalPath: trashItem.originalPath, trashPath: trashItem.trashPath },
          },
        });
      });

      return NextResponse.json({ success: true });
    } catch (err: unknown) {
      console.error("Permanent delete error for", trashItem.originalPath, err);
      return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    } finally {
      releaseLock();
    }
  } catch (err: unknown) {
    console.error("Trash DELETE error:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
