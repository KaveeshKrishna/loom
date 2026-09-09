/**
 * DEMO BUILD ONLY — replaces web/app/(main)/settings/page.tsx.
 * The real version checks the session server-side and requires the OWNER
 * role; the demo's fixed fabricated user is always an Owner (enforced
 * already by the (main)/layout.tsx swap's auth guard), so this just
 * renders the settings shell directly.
 */
import { SettingsShell } from "@/components/settings/SettingsShell";

export default function SettingsPage() {
  return <SettingsShell />;
}
