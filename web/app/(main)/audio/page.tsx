"use client";
import { Music } from "lucide-react";
import { CollectionView, EmptyCollection } from "@/components/files/CollectionView";

export default function AudioPage() {
  return (
    <CollectionView
      title="Audio"
      href="/audio"
      url="/api/files/type?type=audio"
      empty={<EmptyCollection icon={<Music size={44} strokeWidth={1.2} />} title="No audio yet" text="Music, voice notes and other audio anywhere in your library show up here." />}
    />
  );
}
