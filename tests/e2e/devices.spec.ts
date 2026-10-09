/** The Devices page and approving an app's sign-in. */
import { test, expect } from "@playwright/test";
import { Client, owner, sha256, OWNER } from "../api/helpers.ts";
import crypto from "node:crypto";

test("Devices: pairing code as a QR code, then the app shows up; rename and remove it", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop" && info.project.name !== "iphone", "layout covered by the smoke test");
  await page.goto("/devices");
  await expect(page.getByRole("heading", { name: "Devices", exact: true })).toBeVisible();
  // Direct downloads of the newest apps (fixed names in the rolling "updates" release).
  await expect(page.getByRole("link", { name: /Loom for Windows/ })).toHaveAttribute("href", /\/releases\/download\/updates\/Loom-Windows-Setup\.exe$/);
  await expect(page.getByRole("link", { name: /Loom for Android/ })).toHaveAttribute("href", /\/releases\/download\/updates\/Loom-Android\.apk$/);
  await page.getByRole("button", { name: "Show pairing code" }).click();
  await expect(page.getByRole("img", { name: "Pairing code for the Loom app" })).toBeVisible();
  const code = (await page.getByText(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/).textContent())!.trim();
  await expect(page.getByText(/Works once · expires in \d+:\d\d/)).toBeVisible();
  await page.screenshot({ path: `e2e-results/screens/${info.project.name}/devices-pairing.png` });

  const name = `Phone ${crypto.randomBytes(2).toString("hex")}`;
  const token = `loomd_${crypto.randomBytes(32).toString("base64url")}`;
  const r = await new Client().post("/api/devices/pair/redeem", { code, name, platform: "android", appVersion: "1.0.0", tokenHash: sha256(token) });
  expect(r.status).toBe(201);

  await page.reload();
  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toContainText("Android 1.0.0");
  await page.screenshot({ path: `e2e-results/screens/${info.project.name}/devices-list.png` });

  await row.getByRole("button", { name: `Rename ${name}` }).click();
  await page.getByRole("dialog").getByRole("textbox").fill(`${name} renamed`);
  await page.getByRole("dialog").getByRole("button", { name: "Rename" }).click();
  const renamed = page.getByRole("listitem").filter({ hasText: `${name} renamed` });
  await expect(renamed).toBeVisible();

  await renamed.getByRole("button", { name: `Remove ${name} renamed` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  await expect(renamed).toHaveCount(0);
  expect((await new Client(token).get("/api/devices/me")).status).toBe(401);
});

test.describe("approving an app", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("signed out: sign in first, come back, check the code, allow", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop" && info.project.name !== "iphone", "flow, not layout");
    await owner();
    const app = new Client();
    const token = `loomd_${crypto.randomBytes(32).toString("base64url")}`;
    const start = await app.post("/api/devices/pair/start", { name: "Study PC", platform: "windows", tokenHash: sha256(token) });
    await page.goto(start.body.approvePath);
    await expect(page).toHaveURL(/\/login\?next=%2Fpair%2F/);
    await page.locator("#email").fill(OWNER.email);
    await page.locator("#password").fill(OWNER.password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(new RegExp(`/pair/${start.body.pairId}$`));
    await expect(page.getByRole("heading", { name: "Allow this app?" })).toBeVisible();
    await expect(page.getByText(start.body.checkCode)).toBeVisible();
    await expect(page.getByText("Study PC")).toBeVisible();
    await page.screenshot({ path: `e2e-results/screens/${info.project.name}/pair-approve.png` });
    await page.getByRole("button", { name: "Allow" }).click();
    await expect(page.getByRole("heading", { name: "App connected" })).toBeVisible();
    await page.screenshot({ path: `e2e-results/screens/${info.project.name}/pair-done.png` });
    const poll = await app.post("/api/devices/pair/poll", { pairId: start.body.pairId, secret: start.body.secret });
    expect(poll.body.status).toBe("approved");
    expect((await new Client(token).get("/api/devices/me")).status).toBe(200);
  });

  test("an unknown request says so", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "once is enough");
    await page.goto("/login");
    await page.locator("#email").fill(OWNER.email);
    await page.locator("#password").fill(OWNER.password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(/\/files/);
    await page.goto("/pair/doesnotexist");
    await expect(page.getByRole("heading", { name: "Request not found" })).toBeVisible();
  });
});
