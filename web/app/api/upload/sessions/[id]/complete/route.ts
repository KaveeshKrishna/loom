/** POST /api/upload/sessions/:id/complete — finalize an upload whose bytes have all arrived. */
import { NextResponse } from "next/server";
import { route, requireUser } from "@/lib/http";
import { getOwnSession, finalizeUpload } from "@/lib/uploads";

export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const user = await requireUser();
  const session = await getOwnSession(user, (await params).id);
  return NextResponse.json(await finalizeUpload(user, session));
});
