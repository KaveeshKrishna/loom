import { PrismaClient } from "@prisma/client";
import { rename, access } from "fs/promises";
import { join } from "path";
import { constants } from "fs";

const prisma = new PrismaClient();
const CACHE_ROOT = process.env.CACHE_ROOT || "/cache";

async function fileExists(path: string) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log("Starting derived media migration...");

  const files = await prisma.fileNode.findMany({
    include: { thumbnail: true, preview: true }
  });

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of files) {
    if (file.size === null || file.modifiedAt === null) {
      skipped++;
      continue;
    }

    const sourceVersion = `${file.size}-${file.modifiedAt.getTime()}`;

    // Update FileNode sourceVersion if null
    if (!file.sourceVersion) {
      await prisma.fileNode.update({
        where: { id: file.id },
        data: { sourceVersion }
      });
    }

    if (file.thumbnail && file.thumbnail.sourceVersion === "legacy") {
      const oldPath = join(CACHE_ROOT, file.thumbnail.cachePath);
      const newCacheRel = `thumbnails/${file.id}_${sourceVersion}.webp`;
      const newPath = join(CACHE_ROOT, newCacheRel);

      if (await fileExists(oldPath)) {
        try {
          await rename(oldPath, newPath);
          await prisma.thumbnail.update({
            where: { id: file.thumbnail.id },
            data: { cachePath: newCacheRel, sourceVersion }
          });
          migrated++;
        } catch (err) {
          console.error(`Failed to migrate thumbnail for ${file.id}:`, err);
          errors++;
        }
      } else {
        // Old file doesn't exist, we can just delete the record so it's regenerated
        await prisma.thumbnail.delete({ where: { id: file.thumbnail.id } });
        skipped++;
      }
    }

    if (file.preview && file.preview.sourceVersion === "legacy") {
      const isVideo = file.preview.cachePath.includes("video-");
      const oldPath = join(CACHE_ROOT, file.preview.cachePath);
      
      const newCacheRel = isVideo 
        ? `previews/video-${file.id}_${sourceVersion}.webp`
        : `previews/${file.id}_${sourceVersion}.webp`;
        
      const newPath = join(CACHE_ROOT, newCacheRel);

      if (await fileExists(oldPath)) {
        try {
          await rename(oldPath, newPath);
          await prisma.preview.update({
            where: { id: file.preview.id },
            data: { cachePath: newCacheRel, sourceVersion }
          });
          migrated++;
        } catch (err) {
          console.error(`Failed to migrate preview for ${file.id}:`, err);
          errors++;
        }
      } else {
        await prisma.preview.delete({ where: { id: file.preview.id } });
        skipped++;
      }
    }
  }

  console.log(`Migration complete. Migrated: ${migrated}, Skipped/Deleted: ${skipped}, Errors: ${errors}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
