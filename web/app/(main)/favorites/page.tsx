"use client";
import { Star } from "lucide-react";
import { CollectionView, EmptyCollection } from "@/components/files/CollectionView";
import type { LNode } from "@/lib/client/types";

export default function FavoritesPage() {
  return (
    <CollectionView
      title="Starred"
      href="/favorites"
      url="/api/favorites"
      nodesKey="favorites"
      map={(f) => (f as { fileNode: LNode }).fileNode}
      empty={<EmptyCollection icon={<Star size={44} strokeWidth={1.2} />} title="Nothing starred yet" text="Star files and folders from their menu to keep them one click away." />}
    />
  );
}
