/** GET /api/notifications?unread=true — the caller's notifications (newest 50). */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, requireUser } from "@/lib/http";

export const GET = route(async (req) => {
  const user = await requireUser();
  const unreadOnly = req.nextUrl.searchParams.get("unread") === "true";
  const notifications = await prisma.notification.findMany({
    where: { userId: user.id, ...(unreadOnly ? { read: false } : {}) },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return NextResponse.json(notifications);
});
