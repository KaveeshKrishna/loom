/**
 * Every page at every size: loads without script errors, nothing scrolls
 * sideways, touch screens can reach every control, and a screenshot of each
 * page is saved for review (e2e-results/screens/<project>/).
 */
import { test, expect, type Page } from "@playwright/test";

const PAGES: [string, string][] = [
  ["files", "/files"],
  ["folder", "/files/Photos/Trip%20to%20the%20hills"],
  ["documents", "/files/Documents"],
  ["recent", "/recent"],
  ["photos", "/photos"],
  ["videos", "/videos"],
  ["shared", "/shared"],
  ["devices", "/devices"],
  ["trash", "/trash"],
  ["settings", "/settings"],
];

/** Loaded and spinners gone ("networkidle" never comes: live updates keep a connection open). */
async function settle(page: Page) {
  await page.waitForLoadState("load");
  await page.waitForTimeout(300);
  await page.locator(".animate-spin").first().waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(300);
}

for (const [name, url] of PAGES) {
  test(`${name}: loads cleanly and fits the screen`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error" && !/favicon|Failed to load resource.*404/.test(m.text())) errors.push(m.text());
    });
    const res = await page.goto(url);
    expect(res?.status()).toBeLessThan(400);
    await settle(page);
    expect(errors, errors.join("\n")).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "nothing scrolls sideways").toBeLessThanOrEqual(1);
    await page.screenshot({ path: `e2e-results/screens/${info.project.name}/${name}.png` });
  });
}

test("touch screens show each item's ⋯ button (nothing is hover-only)", async ({ page }, info) => {
  test.skip(!info.project.use.hasTouch, "mouse devices reveal it on hover");
  await page.goto("/files/Documents");
  await settle(page);
  const more = page.getByRole("button", { name: "More actions" }).first();
  await expect(more).toBeVisible();
  expect(Number(await more.evaluate((el) => getComputedStyle(el).opacity))).toBeGreaterThan(0.5);
});

test("long-press opens the item menu on touch screens", async ({ page, browserName }, info) => {
  test.skip(!info.project.use.hasTouch, "touch only");
  test.skip(browserName === "webkit", "Playwright's WebKit can't synthesize touches; covered on Android (same code)");
  await page.goto("/files/Documents");
  await settle(page);
  const tile = page.locator(`[aria-label="Notes.txt"]`).first();
  const box = (await tile.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x, y)!;
      const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
      el.dispatchEvent(new TouchEvent("touchstart", { touches: [t], changedTouches: [t], bubbles: true, cancelable: true }));
    },
    [x, y]
  );
  await page.waitForTimeout(800);
  await expect(page.getByRole("menuitem", { name: /Rename/ })).toBeVisible();
});

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("login page fits and doesn't zoom on iPhone", async ({ page }, info) => {
    await page.goto("/login");
    await settle(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    if (info.project.name === "iphone") {
      const size = await page.locator("#email").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(size, "iOS zooms into fields smaller than 16px").toBeGreaterThanOrEqual(16);
    }
    await page.screenshot({ path: `e2e-results/screens/${info.project.name}/login.png` });
  });
});
