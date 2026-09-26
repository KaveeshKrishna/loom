/** Server-side file categories used by the Photos / Videos / Documents / Audio views and search filters. */
import type { Prisma } from "@prisma/client";

export type Category = "image" | "video" | "audio" | "document" | "folder";

const DOCUMENT_MIME_PARTS = [
  "pdf",
  "msword",
  "wordprocessingml",
  "spreadsheetml",
  "presentationml",
  "ms-excel",
  "ms-powerpoint",
  "opendocument",
  "rtf",
  "epub",
];

export function categoryWhere(cat: string): Prisma.FileNodeWhereInput | null {
  switch (cat) {
    case "image":
      return { type: "FILE", mimeType: { startsWith: "image/" } };
    case "video":
      return { type: "FILE", mimeType: { startsWith: "video/" } };
    case "audio":
      return { type: "FILE", mimeType: { startsWith: "audio/" } };
    case "document":
      return {
        type: "FILE",
        OR: [
          { mimeType: { startsWith: "text/" } },
          { mimeType: "application/json" },
          ...DOCUMENT_MIME_PARTS.map((p) => ({ mimeType: { contains: p } })),
        ],
      };
    case "folder":
      return { type: "DIRECTORY" };
    default:
      return null;
  }
}
