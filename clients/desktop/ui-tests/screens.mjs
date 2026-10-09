// Screenshots of the app's screens (mock backend), light and dark, for review.
//   docker run … mcr.microsoft.com/playwright:v1.48.0-jammy node ui-tests/screens.mjs
// Expects `vite preview` on 127.0.0.1:1420 (see ui-tests/run.sh).
import { chromium } from "../../../tests/node_modules/playwright/index.mjs";
import fs from "node:fs";

const BASE = "http://127.0.0.1:1420";
const shots = [
  ["transfers-busy", "?scenario=busy#/transfers", 1000, 660],
  ["transfers-empty", "?scenario=empty#/transfers", 1000, 660],
  ["transfers-offline", "?scenario=offline#/transfers", 1000, 660],
  ["transfers-signedout", "?scenario=signedout#/transfers", 1000, 660],
  ["settings", "?scenario=busy#/settings", 1000, 760],
  ["onboarding", "?scenario=onboarding#/onboarding", 460, 620],
  ["destination", "?scenario=busy#/destination", 560, 640],
  ["offline", "?scenario=busy#/offline?server=https%3A%2F%2Floom.example.com", 1000, 660],
];

fs.mkdirSync("ui-tests/out", { recursive: true });
const browser = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  for (const [name, url, w, h] of shots) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: 1.25 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(BASE + "/" + url);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `ui-tests/out/${name}-${scheme}.png` });
    if (errors.length) console.log(name, scheme, "ERRORS:", errors);
    await page.close();
  }
}
// Interactions worth seeing.
const page = await browser.newPage({ viewport: { width: 1000, height: 660 }, deviceScaleFactor: 1.25 });
await page.goto(BASE + "/?scenario=busy#/transfers");
await page.waitForTimeout(500);
await page.getByRole("button", { name: "Show files" }).first().click();
await page.waitForTimeout(400);
await page.screenshot({ path: "ui-tests/out/transfers-expanded-light.png" });
await page.getByRole("button", { name: "Review" }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: "ui-tests/out/conflicts-light.png" });
await browser.close();
console.log("ok");
