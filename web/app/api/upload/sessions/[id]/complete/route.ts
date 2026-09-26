/** POST /api/upload/sessions/:id/complete[?conflict=replace|keep_both] — finalize an upload whose bytes have all arrived. */
import { NextResponse } from "next/server";
import { route, requireUser } from "@/lib/http";
import { getOwnSession, finalizeUpload, parseUploadConflict } from "@/lib/uploads";

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const user = await requireUser();
  const session = await getOwnSession(user, (await params).id);
  return NextResponse.json(await finalizeUpload(user, session, parseUploadConflict(req.nextUrl.searchParams.get("conflict"))));
});
