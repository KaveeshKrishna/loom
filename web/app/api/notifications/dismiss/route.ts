/** POST /api/notifications/dismiss { notificationId? | dismissAll? } — mark read. */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, requireUser, readJson } from "@/lib/http";

export const POST = route(async (req) => {
  const user = await requireUser();
  const { notificationId, dismissAll } = await readJson<{ notificationId?: string; dismissAll?: boolean }>(req);
  if (dismissAll) {
    await prisma.notification.updateMany({ where: { userId: user.id, read: false }, data: { read: true } });
  } else if (typeof notificationId === "string") {
    await prisma.notification.updateMany({ where: { id: notificationId, userId: user.id }, data: { read: true } });
  }
  return NextResponse.json({ success: true });
});
