import path from "path";
import fs from "fs/promises";
import { prisma } from "@/lib/prisma";
import type { FileNode } from "@prisma/client";

/**
 * Checks if a file or folder already exists at the given absolute path.
 * Returns the existing FileNode if it exists in the database.
 * We also perform a physical stat check to ensure safety, even if the DB is out of sync.
 */
export async function checkCollision(
  absolutePath: string,
  relativePath: string
): Promise<{ exists: boolean; node: FileNode | null; physicalType?: "FILE" | "DIRECTORY" }> {
  let physicalType: "FILE" | "DIRECTORY" | undefined;
  let existsPhysically = false;

  try {
    const stat = await fs.stat(absolutePath);
    existsPhysically = true;
    physicalType = stat.isDirectory() ? "DIRECTORY" : "FILE";
  } catch (err) {
    const error = err as { code?: string };
    if (error.code !== "ENOENT") {
      throw err; // Real error like EACCES
    }
  }

  // Check DB using relative path
  const node = await prisma.fileNode.findFirst({
    where: { relativePath },
  });

  return {
    exists: existsPhysically || !!node,
    node,
    physicalType,
  };
}

/**
 * Generates a unique filename for a given directory, Windows-style.
 * Example: if "image.jpg" exists, returns "image (1).jpg".
 * Will check physically since it is intended for writes where we want
 * absolute safety from overwriting.
 */
export async function generateUniqueFilename(
  absoluteDir: string,
  originalFilename: string
): Promise<string> {
  const ext = path.extname(originalFilename);
  const base = path.basename(originalFilename, ext);

  let candidate = originalFilename;
  let counter = 1;

  while (true) {
    const candidatePath = path.join(absoluteDir, candidate);
    try {
      await fs.stat(candidatePath);
      // Path exists physically, try next suffix
      candidate = `${base} (${counter})${ext}`;
      counter++;
    } catch (err) {
      const error = err as { code?: string };
      if (error.code === "ENOENT") {
        // Path is free physically
        break;
      }
      throw err; // Other filesystem error
    }
  }

  return candidate;
}
