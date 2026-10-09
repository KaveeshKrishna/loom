/** Shared bits for the browser tests. */
import type { Page, Locator } from "@playwright/test";

/** Drop files on `target` the way the browser does for a drag from the desktop. */
export async function dropFiles(page: Page, target: Locator, files: { name: string; content: string }[]) {
  const dt = await page.evaluateHandle((list) => {
    const dt = new DataTransfer();
    for (const f of list) dt.items.add(new File([f.content], f.name, { type: "text/plain" }));
    return dt;
  }, files);
  await target.dispatchEvent("dragenter", { dataTransfer: dt });
  await target.dispatchEvent("dragover", { dataTransfer: dt });
  await target.dispatchEvent("drop", { dataTransfer: dt });
}
