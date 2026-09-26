"use client";
import { Video } from "lucide-react";
import { CollectionView, EmptyCollection } from "@/components/files/CollectionView";

export default function VideosPage() {
  return (
    <CollectionView
      title="Videos"
      href="/videos"
      url="/api/files/type?type=video"
      empty={<EmptyCollection icon={<Video size={44} strokeWidth={1.2} />} title="No videos yet" text="Videos anywhere in your library show up here, newest first." />}
    />
  );
}
