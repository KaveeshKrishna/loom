"use client";
import { Image as ImageIcon } from "lucide-react";
import { CollectionView, EmptyCollection } from "@/components/files/CollectionView";

export default function PhotosPage() {
  return (
    <CollectionView
      title="Photos"
      href="/photos"
      url="/api/files/type?type=image"
      empty={<EmptyCollection icon={<ImageIcon size={44} strokeWidth={1.2} />} title="No photos yet" text="Photos anywhere in your library show up here, newest first." />}
    />
  );
}
