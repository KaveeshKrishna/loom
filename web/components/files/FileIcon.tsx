import React from "react";
import { Folder, FileText, Image as ImageIcon, Video, Music, File, FileCode, FileArchive, FileSpreadsheet, Presentation } from "lucide-react";
import { getFileCategory, getExtension } from "@/lib/utils";

interface FileIconProps {
  mimeType: string | null;
  type: string;
  size?: number;
  className?: string;
  name?: string;
}

const CODE = new Set(["js", "ts", "tsx", "jsx", "py", "go", "rs", "java", "c", "cpp", "h", "cs", "rb", "php", "sh", "json", "yml", "yaml", "toml", "xml", "html", "css", "sql", "kt", "swift"]);
const ARCHIVE = new Set(["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst"]);
const SHEET = new Set(["xls", "xlsx", "ods", "csv"]);
const SLIDES = new Set(["ppt", "pptx", "odp", "key"]);

export function FileIcon({ mimeType, type, size = 16, className, name }: FileIconProps) {
  const cls = (c: string) => `${c} ${className || ""}`;
  if (type === "DIRECTORY") return <Folder size={size} className={cls("text-[hsl(var(--primary))]")} />;
  const ext = name ? getExtension(name) : "";
  if (CODE.has(ext)) return <FileCode size={size} className={cls("text-emerald-500")} />;
  if (ARCHIVE.has(ext)) return <FileArchive size={size} className={cls("text-orange-500")} />;
  if (SHEET.has(ext)) return <FileSpreadsheet size={size} className={cls("text-green-600")} />;
  if (SLIDES.has(ext)) return <Presentation size={size} className={cls("text-orange-600")} />;
  const cat = getFileCategory(mimeType, name);
  if (cat === "image") return <ImageIcon size={size} className={cls("text-violet-500")} />;
  if (cat === "video") return <Video size={size} className={cls("text-rose-500")} />;
  if (cat === "audio") return <Music size={size} className={cls("text-amber-500")} />;
  if (cat === "document") return <FileText size={size} className={cls("text-blue-500")} />;
  return <File size={size} className={cls("text-[hsl(var(--muted-foreground))]")} />;
}
