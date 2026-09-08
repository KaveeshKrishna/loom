import React from "react";
import { Folder, FileText, Image as ImageIcon, Video, Music, File } from "lucide-react";
import { getFileCategory } from "@/lib/utils";

interface FileIconProps {
  mimeType: string | null;
  type: string;
  size?: number;
  className?: string;
}

export function FileIcon({ mimeType, type, size = 16, className }: FileIconProps) {
  if (type === "DIRECTORY") return <Folder size={size} className={`text-[hsl(var(--primary))] ${className || ""}`} />;
  const cat = getFileCategory(mimeType);
  if (cat === "image") return <ImageIcon size={size} className={`text-violet-500 ${className || ""}`} />;
  if (cat === "video") return <Video size={size} className={`text-rose-500 ${className || ""}`} />;
  if (cat === "audio") return <Music size={size} className={`text-amber-500 ${className || ""}`} />;
  if (cat === "document") return <FileText size={size} className={`text-blue-500 ${className || ""}`} />;
  return <File size={size} className={`text-[hsl(var(--muted-foreground))] ${className || ""}`} />;
}
