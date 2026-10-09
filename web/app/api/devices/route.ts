/**
 * GET /api/devices — paired apps. Your own; the Owner sees everyone's, with
 * the user each one belongs to. Browser sign-in only. See lib/devices.ts.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, requireBrowserUser } from "@/lib/http";
import { deviceJson } from "@/lib/devices";

export const GET = route(async () => {
  const user = await requireBrowserUser();
  const all = user.role === "OWNER";
  const devices = await prisma.device.findMany({
    where: all ? {} : { userId: user.id },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: [{ lastSeenAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
  });
  return NextResponse.json({
    devices: devices.map((d) => ({ ...deviceJson(d, user.deviceId), user: d.user, mine: d.userId === user.id })),
  });
});
