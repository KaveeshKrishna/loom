import { prisma } from "./prisma";

export type ArchiveStatus = "Online";

// We assume the archive is always permanently mounted at /media
// The OS handles USB suspend/wake via runtime power management.
export async function getArchiveStatus(): Promise<ArchiveStatus> {
  return "Online";
}

export async function requestFullScan(): Promise<{ success: boolean; jobId?: string; error?: string }> {
  try {
    const job = await prisma.scanJob.create({
      data: { type: "FULL_RESCAN", status: "PENDING" }
    });
    return { success: true, jobId: job.id };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
