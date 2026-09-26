/**
 * GET /api/settings/sharing → { enabled }   (any signed-in user)
 * PUT /api/settings/sharing { enabled }     (Owner only)
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, requireUser, requireOwner, readJson, badRequest } from "@/lib/http";
import { isSharingEnabled, setSharingEnabled } from "@/lib/shares";

export const GET = route(async () => {
  await requireUser();
  return NextResponse.json({ enabled: await isSharingEnabled() });
});

export const PUT = route(async (req) => {
  const owner = await requireOwner();
  const { enabled } = await readJson<{ enabled?: unknown }>(req);
  if (typeof enabled !== "boolean") throw badRequest("enabled must be true or false");
  await setSharingEnabled(enabled);
  await prisma.auditLog.create({ data: { userId: owner.id, action: enabled ? "SHARING_ENABLED" : "SHARING_DISABLED", details: {} } });
  return NextResponse.json({ enabled });
});
