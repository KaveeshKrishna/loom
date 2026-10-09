/**
 * PATCH  /api/devices/:id { name } — rename a paired app
 * DELETE /api/devices/:id          — remove it; it is signed out at once
 *
 * Your own devices; the Owner can also remove anyone's. Browser sign-in only:
 * an app can remove itself with DELETE /api/devices/me.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, requireBrowserUser, readJson, notFound } from "@/lib/http";
import { cleanDeviceName, deviceJson, removeDevice } from "@/lib/devices";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (req, { params }) => {
  const user = await requireBrowserUser();
  const { id } = await params;
  const { name } = await readJson(req);
  const d = await prisma.device.findUnique({ where: { id } });
  if (!d || d.userId !== user.id) throw notFound("Device not found");
  const updated = await prisma.device.update({ where: { id }, data: { name: cleanDeviceName(name) } });
  return NextResponse.json({ device: deviceJson(updated, user.deviceId) });
});

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const user = await requireBrowserUser();
  await removeDevice(user, (await params).id);
  return NextResponse.json({ success: true });
});
