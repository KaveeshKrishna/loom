/**
 * The website's own uploads: dropped files are confirmed first, uploads can
 * be paused, resumed and cancelled, and the page copes with Loom going away
 * (a "reconnecting" bar) and coming back updated (it reloads itself).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { dropFiles } from "./helpers";

test.beforeEach(async ({}, info) => {
  test.skip(info.project.name !== "desktop", "the same code on every size");
});

const uploadsStarted = (page: Page) => {
  const started: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/upload/sessions")) started.push(r.postData() ?? "");
  });
  return started;
};

test("dropped files are only uploaded after confirming", async ({ page }) => {
  const started = uploadsStarted(page);
  await page.goto("/files/Documents");
  const tile = page.locator('[aria-label="Notes.txt"]').first();
  await expect(tile).toBeVisible();
  const stamp = Date.now();
  const files = [
    { name: `dropped-a-${stamp}.txt`, content: "first" },
    { name: `dropped-b-${stamp}.txt`, content: "second one" },
  ];

  await dropFiles(page, tile, files);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Upload to Documents?")).toBeVisible();
  await expect(dialog.getByText("2 files")).toBeVisible();
  await expect(dialog.getByText(files[0].name)).toBeVisible();
  await page.screenshot({ path: "e2e-results/screens/desktop/upload-confirm.png" });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.waitForTimeout(1000);
  expect(started, "nothing is uploaded after Cancel").toEqual([]);

  await dropFiles(page, tile, files);
  await page.getByRole("dialog").getByRole("button", { name: "Upload" }).click();
  await expect(page.getByText(/2 uploads complete/)).toBeVisible({ timeout: 15_000 });
  expect(started).toHaveLength(2);
});

test("an uploaded folder appears in the open folder without reloading", async ({ page }) => {
  const name = `Trip-${Date.now()}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-folder-"));
  fs.mkdirSync(path.join(root, name, "day one"), { recursive: true });
  fs.writeFileSync(path.join(root, name, "day one", "notes.txt"), "beach");
  fs.writeFileSync(path.join(root, name, "plan.txt"), "go");
  await page.goto("/files/Documents");
  await expect(page.getByText("Notes.txt")).toBeVisible();
  let reloads = 0;
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) reloads++;
  });
  await page.locator('input[type="file"][webkitdirectory]').setInputFiles(path.join(root, name));
  await expect(page.getByText(/2 uploads complete/)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(`[aria-label="${name}"]`).first()).toBeVisible({ timeout: 5_000 });
  expect(reloads, "the page wasn't reloaded").toBe(0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("uploads can be paused, resumed and cancelled", async ({ page }) => {
  // Slow the chunks down so there's time to press the buttons.
  await page.route(/\/api\/upload\/sessions\/[^/?]+\?offset=/, async (route) => {
    await new Promise((r) => setTimeout(r, 600));
    await route.continue();
  });
  await page.goto("/files/Documents");
  await expect(page.getByText("Notes.txt")).toBeVisible();
  const big = Buffer.alloc(4 * 1024 * 1024 + 123, 7);
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles([{ name: `paused-${Date.now()}.bin`, mimeType: "application/octet-stream", buffer: big }]);

  const panel = page.getByRole("region", { name: "Uploads" });
  await expect(panel.getByText(/Uploading 1 file/)).toBeVisible();
  await panel.getByRole("button", { name: "Pause all" }).click();
  await expect(panel.getByText("1 upload paused")).toBeVisible();
  await expect(panel.getByText(/Paused/).last()).toBeVisible();
  await page.screenshot({ path: "e2e-results/screens/desktop/upload-paused.png" });
  // Nothing is sent while paused.
  let sent = 0;
  page.on("request", (r) => {
    if (r.method() === "PUT") sent++;
  });
  await page.waitForTimeout(1500);
  expect(sent).toBe(0);

  await panel.getByRole("button", { name: /Resume/ }).first().click();
  await expect(panel.getByText(/1 upload complete/)).toBeVisible({ timeout: 30_000 });

  // Cancel all stops the next one for good.
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles([{ name: `cancelled-${Date.now()}.bin`, mimeType: "application/octet-stream", buffer: big }]);
  await expect(panel.getByText(/Uploading 1 file/)).toBeVisible();
  await panel.getByRole("button", { name: "Cancel all" }).click();
  await expect(panel.getByText("Cancelled", { exact: true })).toBeVisible();
});

test("when Loom can't be reached the page says so, and recovers by itself", async ({ page }) => {
  await page.route("**/api/events", (route) => route.abort());
  await page.goto("/files");
  await expect(page.getByText("Can't reach Loom. Reconnecting…")).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: "e2e-results/screens/desktop/reconnecting.png" });
  await page.unroute("**/api/events");
  await expect(page.getByText("Can't reach Loom. Reconnecting…")).toBeHidden({ timeout: 30_000 });
});

test("after Loom was updated, an open page reloads itself", async ({ page }) => {
  await page.route("**/api/events", (route) => route.abort());
  await page.route("**/api/health", (route) => route.fulfill({ json: { status: "ok", version: "9.9.9", build: "a-newer-build" } }));
  await page.goto("/files");
  await expect(page.getByText("Can't reach Loom. Reconnecting…")).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => ((window as unknown as { __before: boolean }).__before = true));
  const reloaded = page.waitForEvent("load", { timeout: 30_000 });
  await page.unroute("**/api/events");
  await reloaded;
  expect(await page.evaluate(() => (window as unknown as { __before?: boolean }).__before)).toBeUndefined();
});
