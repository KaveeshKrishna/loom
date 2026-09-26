"use client";
import { FileText } from "lucide-react";
import { CollectionView, EmptyCollection } from "@/components/files/CollectionView";

export default function DocumentsPage() {
  return (
    <CollectionView
      title="Documents"
      href="/documents"
      url="/api/files/type?type=document"
      empty={<EmptyCollection icon={<FileText size={44} strokeWidth={1.2} />} title="No documents yet" text="PDFs, text, Office and other documents anywhere in your library show up here." />}
    />
  );
}
