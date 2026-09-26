"use client";
import { Clock } from "lucide-react";
import { CollectionView, EmptyCollection } from "@/components/files/CollectionView";

export default function RecentPage() {
  return (
    <CollectionView
      title="Recent"
      href="/recent"
      url="/api/files/recent"
      empty={<EmptyCollection icon={<Clock size={44} strokeWidth={1.2} />} title="Nothing here yet" text="The most recently modified files in your library show up here." />}
    />
  );
}
