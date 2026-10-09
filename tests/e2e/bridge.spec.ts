/**
 * Inside a Loom app (window.LoomApp injected before the page loads),
 * uploads, downloads and transfer status go through the app. A fake bridge
 * records every call.
 */
import { test, expect, type Page } from "@playwright/test";
import { dropFiles } from "./helpers";

type Call = [string, ...unknown[]];

/**
 * A fake app. `answer`: how a version 2 app answers requests ("ok", or
 * "never" for an app that doesn't respond); version 1 apps return nothing.
 */
async function withBridge(page: Page, capabilities: string[], opts: { version?: 1 | 2; answer?: "ok" | "never" } = {}) {
  await page.addInitScript(
    ({ caps, version, answer }) => {
      const calls: unknown[] = [];
      (window as any).__calls = calls;
      const rec =
        (name: string, request = false) =>
        (...args: unknown[]) => {
          calls.push([name, ...args.map((a) => (Array.isArray(a) && a[0] instanceof File ? a.map((f: File) => `file:${f.name}:${f.size}`) : a))]);
          if (version === 1 || !request) return undefined;
          return answer === "never" ? new Promise(() => {}) : Promise.resolve(null);
        };
      (window as any).LoomApp = {
        apiVersion: version,
        platform: "windows",
        appVersion: "1.0.0-test",
        capabilities: caps,
        uploadFiles: rec("uploadFiles", true),
        uploadDropped: rec("uploadDropped", true),
        pickUpload: rec("pickUpload", true),
        download: rec("download", true),
        openTransfers: rec("openTransfers", true),
        openSettings: rec("openSettings", true),
        setLocation: rec("setLocation"),
        signedOut: rec("signedOut"),
        ready: rec("ready"),
        log: rec("log"),
      };
    },
    { caps: capabilities, version: opts.version ?? 2, answer: opts.answer ?? "ok" }
  );
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
  await expect(page.getByRole("banner").getByRole("button", { name: "Transfers", exact: true })).toBeVisible();
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

test("a version 1 app (no answers) still gets the picker request", async ({ page }) => {
  await withBridge(page, ["uploads.picker"], { version: 1 });
  let chooser = false;
  page.on("filechooser", () => (chooser = true));
  await page.goto("/files/Documents");
  await expect(page.getByText("Notes.txt")).toBeVisible();
  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("menuitem", { name: "Upload files" }).click();
  await page.waitForTimeout(3500);
  expect(await callsOf(page, "pickUpload")).toEqual([["pickUpload", "Documents", "files"]]);
  expect(chooser).toBe(false);
});

test("when the app doesn't answer, the page uses its own picker and ZIP download", async ({ page }) => {
  await withBridge(page, ["uploads.picker", "downloads", "transfers"], { answer: "never" });
  await page.goto("/files/Documents");
  await expect(page.getByText("Notes.txt")).toBeVisible();
  // Right-click on empty space → Upload files: the app is asked, then the page's chooser opens.
  const chooser = page.waitForEvent("filechooser", { timeout: 6000 });
  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("menuitem", { name: "Upload files" }).click();
  await chooser;
  expect(await callsOf(page, "pickUpload")).toHaveLength(1);
  expect((await callsOf(page, "log")).map((c) => c[2])).toContainEqual(expect.stringContaining("pickUpload: no answer"));
  // Download (the app's download manager) falls back to the browser's download.
  const download = page.waitForEvent("download", { timeout: 6000 });
  await page.locator('[aria-label="Packing list.md"]').first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Download", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("Packing list.md");
  await expect(page.getByText(/didn't answer, so your browser is downloading it/)).toHaveCount(1);
  // …once: the browser's own download isn't sent to the app again.
  await page.waitForTimeout(3000);
  await expect(page.getByText(/didn't answer, so your browser is downloading it/)).toHaveCount(1);
  expect(await callsOf(page, "download")).toHaveLength(1);
  // Transfers can't fall back: say so instead of doing nothing.
  await page.locator("#topbar-user-menu").click();
  await page.getByRole("banner").getByRole("button", { name: "Transfers", exact: true }).click();
  await expect(page.getByText(/didn't respond/)).toBeVisible({ timeout: 6000 });
});

test("folders: Download goes to the app, Download as ZIP to the browser", async ({ page }) => {
  await withBridge(page, ["downloads", "transfers"]);
  await page.goto("/files");
  const folder = page.locator('[aria-label="Documents"]').first();
  await expect(folder).toBeVisible();
  await folder.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Download as ZIP" })).toBeVisible();
  await page.screenshot({ path: "e2e-results/screens/desktop/bridge-folder-menu.png" });
  await page.getByRole("menuitem", { name: "Download", exact: true }).click();
  expect(await callsOf(page, "download")).toEqual([["download", { items: [{ path: "Documents", name: "Documents", type: "DIRECTORY" }] }]]);
  const zip = page.waitForRequest((r) => r.url().endsWith("/api/download/zip") && r.method() === "POST");
  await folder.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Download as ZIP" }).click();
  expect((await zip).postData()).toContain("path=Documents");
  expect(await callsOf(page, "download")).toHaveLength(1);
});

test("the sidebar has the app's Transfers (with a count) and settings", async ({ page }) => {
  await withBridge(page, ["transfers", "settings"]);
  await page.goto("/files");
  await ready(page);
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByText("This PC")).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("loomapp:transfers", {
        detail: { active: 2, queued: 3, paused: 0, failed: 0, bytesDone: 1, bytesTotal: 10, bytesPerSecond: 0, via: null },
      })
    )
  );
  await expect(nav.getByRole("button", { name: /Transfers/ })).toContainText("5");
  await page.screenshot({ path: "e2e-results/screens/desktop/bridge-sidebar.png" });
  await nav.getByRole("button", { name: /Transfers/ }).click();
  await nav.getByRole("button", { name: "App settings" }).click();
  expect((await calls(page)).filter((c) => c[0] === "openTransfers" || c[0] === "openSettings").map((c) => c[0])).toEqual(["openTransfers", "openSettings"]);
  // The user menu has both too.
  await page.locator("#topbar-user-menu").click();
  await expect(page.getByRole("button", { name: "App settings" })).toHaveCount(2);
});

test("the app's messages show as toasts, with a way to its Transfers", async ({ page }) => {
  await withBridge(page, ["transfers"]);
  await page.goto("/files");
  await ready(page);
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("loomapp:toast", { detail: { kind: "info", message: "Uploading 3 items to Photos", action: "transfers" } }))
  );
  await expect(page.getByText("Uploading 3 items to Photos")).toBeVisible();
  await page.getByRole("button", { name: "Open Transfers" }).click();
  expect(await callsOf(page, "openTransfers")).toHaveLength(1);
});

test("without the app there's no This PC section and folder menus offer the ZIP as before", async ({ page }) => {
  await page.goto("/files");
  const folder = page.locator('[aria-label="Documents"]').first();
  await expect(folder).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByText("This PC")).toHaveCount(0);
  await folder.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Download as ZIP" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Download", exact: true })).toHaveCount(0);
});

test("dropped items go to the app as they are, after confirming", async ({ page }) => {
  await withBridge(page, ["uploads.files", "uploads.dropped", "transfers"]);
  await page.goto("/files/Documents");
  const tile = page.locator('[aria-label="Notes.txt"]').first();
  await expect(tile).toBeVisible();
  await ready(page);
  await dropFiles(page, tile, [
    { name: "holiday.jpg", content: "jpeg" },
    { name: "notes.md", content: "# notes" },
  ]);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Upload to Documents?")).toBeVisible();
  await dialog.getByRole("button", { name: "Upload" }).click();
  await expect.poll(() => callsOf(page, "uploadDropped")).toHaveLength(1);
  const [[, destDir, items, files]] = await callsOf(page, "uploadDropped");
  expect(destDir).toBe("Documents");
  expect(items).toEqual([
    { name: "holiday.jpg", kind: "file" },
    { name: "notes.md", kind: "file" },
  ]);
  expect(files).toEqual(["file:holiday.jpg:4", "file:notes.md:7"]);
  // The page didn't upload them itself.
  await expect(page.getByText(/Uploading \d+ file/)).toHaveCount(0);
});
