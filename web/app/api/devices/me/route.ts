/**
 * GET    /api/devices/me — for a paired app: this device and its user
 *                          (also how an app checks its token still works)
 * PATCH  /api/devices/me { appVersion?, name? } — report a new app version
 * DELETE /api/devices/me — the app signs itself out (removes this device)
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, requireDevice, readJson } from "@/lib/http";
import { cleanDeviceName, deviceJson, removeDevice } from "@/lib/devices";

export const GET = route(async () => {
  const user = await requireDevice();
  const device = await prisma.device.findUniqueOrThrow({ where: { id: user.deviceId } });
  return NextResponse.json({
    device: deviceJson(device, device.id),
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

export const PATCH = route(async (req) => {
  const user = await requireDevice();
  const body = await readJson(req);
  const data: { appVersion?: string; name?: string } = {};
  if (typeof body.appVersion === "string" && /^[\w.+-]{1,40}$/.test(body.appVersion)) data.appVersion = body.appVersion;
  if (body.name !== undefined) data.name = cleanDeviceName(body.name);
  const device = await prisma.device.update({ where: { id: user.deviceId }, data });
  return NextResponse.json({ device: deviceJson(device, device.id) });
});

export const DELETE = route(async () => {
  const user = await requireDevice();
  await removeDevice(user, user.deviceId);
  return NextResponse.json({ success: true });
});
