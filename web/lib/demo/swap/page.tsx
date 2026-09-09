/**
 * DEMO BUILD ONLY — replaces web/app/page.tsx (copied over it by
 * loom-demo/build.sh). The real version checks `prisma.user.count()`
 * server-side; the demo has no database and no first-run concept at all,
 * so this is just a static redirect straight into the file browser.
 */
import { redirect } from "next/navigation";

export default function RootPage() {
  redirect("/files");
}
