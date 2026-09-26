/**
 * jobs.ts — queue background work for the scanner.
 *
 * The scanner claims jobs from the scan_jobs table and is woken immediately
 * by NOTIFY loom_jobs, so derived media (thumbnails, previews, video probe,
 * EXIF) is generated seconds after an upload finishes — without the upload
 * request ever waiting for it.
 */

import { prisma } from "./prisma";
import { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient | typeof prisma;

const PROCESSABLE = /\.(jpe?g|png|webp|gif|avif|heic|heif|tiff?|bmp|thm|thim|mp4|m4v|mov|avi|mkv|webm|mpe?g|3gp|wmv|flv|mts|m2ts|ts)$/i;

/** True if the scanner can generate a thumbnail/preview for this file. */
export function needsProcessing(name: string): boolean {
  return PROCESSABLE.test(name);
}

/**
 * Queue a PROCESS_FILE job for a node (no-op for file types the scanner can't
 * process). An existing pending job for the same node is reused.
 */
export async function queueProcessFile(
  node: { id: string; relativePath: string; name: string; sourceVersion: string | null },
  requestedBy: string | null,
  tx: Tx = prisma
): Promise<boolean> {
  if (!needsProcessing(node.name)) return false;
  const pending = await tx.scanJob.findFirst({
    where: { type: "PROCESS_FILE", status: "PENDING", fileNodeId: node.id },
    select: { id: true },
  });
  if (pending) {
    await tx.scanJob.update({
      where: { id: pending.id },
      data: { sourceVersion: node.sourceVersion, targetPath: node.relativePath },
    });
  } else {
    await tx.scanJob.create({
      data: {
        type: "PROCESS_FILE",
        status: "PENDING",
        fileNodeId: node.id,
        targetPath: node.relativePath,
        sourceVersion: node.sourceVersion,
        requestedBy,
      },
    });
  }
  return true;
}

/** Wake the scanner. Safe to call outside a transaction; never throws. */
export async function notifyScanner(): Promise<void> {
  await prisma.$executeRaw`SELECT pg_notify('loom_jobs', 'wake')`.catch(() => {});
}
