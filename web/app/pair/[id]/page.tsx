/**
 * /pair/:id — allow or decline an app's request to sign in (lib/devices.ts,
 * "approve" flow). Usually opened inside the app's own window. Signed-out
 * visitors go to the sign-in page and come back here afterwards.
 */
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getPendingPairing } from "@/lib/devices";
import { PairApprove } from "@/components/devices/PairApprove";

export const dynamic = "force-dynamic";

export default async function PairPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect(`/login?next=${encodeURIComponent(`/pair/${id}`)}`);
  const request = await getPendingPairing(id);
  return <PairApprove request={request && { ...request, createdAt: request.createdAt.toISOString(), expiresAt: request.expiresAt.toISOString() }} userName={session.user.name} />;
}
