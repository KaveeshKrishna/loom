import type { Metadata } from "next";
import { SharePage } from "@/components/share/SharePage";

export const metadata: Metadata = {
  title: "Shared with you · Loom",
  robots: "noindex, nofollow",
  referrer: "no-referrer",
};

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SharePage token={token} />;
}
