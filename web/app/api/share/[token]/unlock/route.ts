/** POST /api/share/:token/unlock { password } — unlock a password-protected link (rate-limited). */
import { NextResponse } from "next/server";
import { route, readJson, HttpError } from "@/lib/http";
import { resolveShare, verifySharePassword, setUnlockCookie, checkUnlockRate } from "@/lib/shares";

export const POST = route<{ params: Promise<{ token: string }> }>(async (req, { params }) => {
  const { link } = await resolveShare((await params).token);
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
  checkUnlockRate(ip, link.id);
  const { password } = await readJson<{ password?: unknown }>(req);
  if (typeof password !== "string" || !(await verifySharePassword(link, password))) {
    throw new HttpError(401, "Wrong password");
  }
  await setUnlockCookie(link);
  return NextResponse.json({ success: true });
});
