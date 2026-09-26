/** DELETE /api/fs/trash/[id] — permanently delete one trash item. */
import { NextResponse } from "next/server";
import { route, requireUser } from "@/lib/http";
import { deleteTrashItemForever } from "@/lib/file-ops";

export const DELETE = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const user = await requireUser();
  const { id } = await params;
  await deleteTrashItemForever(user, id);
  return NextResponse.json({ success: true });
});
