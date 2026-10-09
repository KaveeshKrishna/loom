/**
 * GET  /api/devices/pair/:id            — a pairing request, for /pair/:id
 * POST /api/devices/pair/:id { allow }  — allow or decline it
 *
 * Needs a browser sign-in (not an app token). Allowing gives the app full
 * access to your files, as you.
 */
import { NextResponse } from "next/server";
import { route, requireBrowserUser, readJson, notFound } from "@/lib/http";
import { getPendingPairing, decidePairing } from "@/lib/devices";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }) => {
  await requireBrowserUser();
  const p = await getPendingPairing((await params).id);
  if (!p) throw notFound("Unknown pairing request");
  return NextResponse.json(p);
});

export const POST = route<Ctx>(async (req, { params }) => {
  const user = await requireBrowserUser();
  const { allow } = await readJson(req);
  await decidePairing(user, (await params).id, allow === true);
  return NextResponse.json({ success: true });
});
