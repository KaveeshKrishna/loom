/**
 * Inside a Loom app (window.LoomApp injected before the page loads),
 * uploads, downloads and transfer status go through the app. A fake bridge
 * records every call.
 */
import { test, expect, type Page } from "@playwright/test";

type Call = [string, ...unknown[]];

async function withBridge(page: Page, capabilities: string[]) {
  await page.addInitScript((caps) => {
    const calls: unknown[] = [];
    (window as any).__calls = calls;
    const rec = (name: string) => (...args: unknown[]) => {
      calls.push([name, ...args.map((a) => (Array.isArray(a) && a[0] instanceof File ? a.map((f: File) => `file:${f.name}:${f.size}`) : a))]);
    };
    (window as any).LoomApp = {
      apiVersion: 1,
      platform: "windows",
      appVersion: "1.0.0-test",
      capabilities: caps,
      uploadFiles: rec("uploadFiles"),
      pickUpload: rec("pickUpload"),
      download: rec("download"),
      openTransfers: rec("openTransfers"),
      setLocation: rec("setLocation"),
      signedOut: rec("signedOut"),
      ready: rec("ready"),
    };
  }, capabilities);
}

const calls = (page: Page) => page.evaluate(() => (window as any).__calls as Call[]);
const callsOf = async (page: Page, name: string) => (await calls(page)).filter((c) => c[0] === name);
/** Wait until the page told the app it's listening. */
const ready = (page: Page) => expect.poll(() => callsOf(page, "ready")).not.toHaveLength(0);

test.beforeEach(async ({}, info) => {
  test.skip(info.project.name !== "desktop", "the bridge is the same on every size");
});

test("the app's picker replaces the page's file inputs, and knows the current folder", async ({ page }) => {
  await withBridge(page, ["uploads.picker", "downloads", "transfers"]);
  let chooser = false;
  page.on("filechooser", () => (chooser = true));
  await page.goto("/files/Documents");
  await expect(page.getByText("Notes.txt")).toBeVisible();
  expect(await callsOf(page, "setLocation")).toContainEqual(["setLocation", { path: "Documents", canWrite: true }]);
  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("menuitem", { name: "Upload folder" }).click();
  expect(await callsOf(page, "pickUpload")).toEqual([["pickUpload", "Documents", "folder"]]);
  expect(chooser).toBe(false);
});

test("files given to the page go to the app after the conflict question", async ({ page }) => {
  await withBridge(page, ["uploads.files", "transfers"]);
  await page.goto("/files/Documents");
  await expect(page.getByText("Notes.txt")).toBeVisible();
  await ready(page);
  const input = page.locator('input[type="file"]:not([webkitdirectory])');
  await input.setInputFiles([
    { name: "fresh.txt", mimeType: "text/plain", buffer: Buffer.from("new file") },
    { name: "Notes.txt", mimeType: "text/plain", buffer: Buffer.from("a newer version") },
  ]);
  // Notes.txt exists: the usual Replace / Skip / Keep both question first.
  await page.getByRole("button", { name: /^Replace/ }).click();
  await expect.poll(() => callsOf(page, "uploadFiles")).toHaveLength(1);
  const [[, destDir, items, files]] = await callsOf(page, "uploadFiles");
  expect(destDir).toBe("Documents");
  expect(items).toEqual([
    expect.objectContaining({ relativePath: "fresh.txt", size: 8, conflict: "keep_both" }),
    expect.objectContaining({ relativePath: "Notes.txt", size: 15, conflict: "replace" }),
  ]);
  expect(files).toEqual(["file:fresh.txt:8", "file:Notes.txt:15"]);
  // Nothing was uploaded by the page itself.
  await expect(page.getByText(/Uploading \d+ file/)).toHaveCount(0);
});

test("downloads go to the app (toolbar and links), never to the browser", async ({ page }) => {
  await withBridge(page, ["downloads"]);
  const served: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/files/serve") || r.url().includes("/api/download/zip")) served.push(r.url());
  });
  await page.goto("/files/Documents");
  const tile = page.locator('[aria-label="Notes.txt"]').first();
  await tile.getByRole("button", { name: "Select" }).click({ force: true });
  await page.locator('[aria-label="Packing list.md"]').first().getByRole("button", { name: "Select" }).click({ force: true });
  await page.getByRole("button", { name: "Download" }).click();
  const [[, req]] = await callsOf(page, "download");
  expect((req as any).items).toEqual(
    expect.arrayContaining([
      { path: "Documents/Notes.txt", name: "Notes.txt", type: "FILE" },
      { path: "Documents/Packing list.md", name: "Packing list.md", type: "FILE" },
    ])
  );
  // A plain download link elsewhere in the UI is caught too.
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.href = "/api/files/serve?path=Documents%2FNotes.txt&download=1";
    a.download = "Notes.txt";
    document.body.appendChild(a);
    a.click();
  });
  expect((await callsOf(page, "download")).length).toBe(2);
  expect(served).toEqual([]);
});

test("the app's transfer progress shows as a pill that opens its Transfers window", async ({ page }) => {
  await withBridge(page, ["transfers"]);
  await page.goto("/files");
  await ready(page);
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("loomapp:transfers", {
        detail: { active: 2, queued: 1, paused: 0, failed: 0, bytesDone: 420, bytesTotal: 1000, bytesPerSecond: 8 * 1024 * 1024, via: "lan" },
      })
    )
  );
  const pill = page.getByRole("button", { name: "Show transfers" });
  await expect(pill).toContainText("42% · 3 left · 8 MB/s");
  await expect(pill).toContainText("LAN");
  await page.screenshot({ path: "e2e-results/screens/desktop/bridge-pill.png" });
  await pill.click();
  expect(await callsOf(page, "openTransfers")).toHaveLength(1);
  // The user menu gets a Transfers entry too.
  await page.locator("#topbar-user-menu").click();
  await expect(page.getByRole("button", { name: "Transfers", exact: true })).toBeVisible();
});

test("the app can open a folder", async ({ page }) => {
  await withBridge(page, ["transfers"]);
  await page.goto("/files");
  await ready(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("loomapp:navigate", { detail: { path: "Photos/Trip to the hills" } })));
  await expect(page).toHaveURL(/\/files\/Photos\/Trip%20to%20the%20hills$/);
});

test("without the bridge, uploads happen in the page as before", async ({ page }) => {
  await page.goto("/files/Documents");
  await expect(page.getByText("Notes.txt")).toBeVisible();
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles([
    { name: `browser-${Date.now()}.txt`, mimeType: "text/plain", buffer: Buffer.from("from the browser") },
  ]);
  await expect(page.getByText(/upload(s)? complete|1 uploaded/i)).toBeVisible({ timeout: 15_000 });
});
