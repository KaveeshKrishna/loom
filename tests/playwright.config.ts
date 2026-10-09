/**
 * Browser tests against the test stack (tests/README.md). Runs in the
 * Playwright Docker image (see tests/run-e2e.sh). Screenshots of every page
 * at every size land in e2e-results/ for review.
 */
import { defineConfig, devices } from "@playwright/test";

const BASE = process.env.LOOM_TEST_URL ?? `http://localhost:${process.env.LOOM_TEST_PORT ?? 18085}`;

export default defineConfig({
  testDir: "e2e",
  outputDir: "e2e-results/artifacts",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"]],
  use: {
    baseURL: BASE,
    storageState: "e2e-results/owner.json",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "iphone", use: { ...devices["iPhone 13"] } },
    { name: "android-tablet", use: { ...devices["Galaxy Tab S4 landscape"] } },
    { name: "android-tablet-portrait", use: { ...devices["Galaxy Tab S4"] } },
    { name: "android-phone", use: { ...devices["Pixel 7"] } },
  ],
});
