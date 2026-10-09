"use client";

/** The "allow this app?" card for /pair/:id. */

import { useState } from "react";
import Link from "next/link";
import { Monitor, Smartphone, Laptop, Check, X, Loader2 } from "lucide-react";
import { api } from "@/lib/client/api";
import { formatRelative } from "@/lib/utils";
import { LoomLogo } from "@/components/ui/LoomLogo";

interface Request {
  id: string;
  state: string;
  deviceName: string;
  platform: string;
  checkCode: string;
  requestIp: string | null;
  createdAt: string;
  expiresAt: string;
}

const CHECK_HINT: Record<string, string> = {
  windows: "Check that the Loom sign-in window on your PC shows the same code",
  android: "Check that the Loom app on your phone or tablet shows the same code",
};

const PLATFORM_LABEL: Record<string, string> = { windows: "Windows", macos: "macOS", linux: "Linux", android: "Android", ios: "iOS" };

export function PairApprove({ request, userName }: { request: Request | null; userName: string }) {
  const [state, setState] = useState(request?.state ?? "missing");
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState("");

  const decide = async (allow: boolean) => {
    if (!request) return;
    setBusy(allow ? "allow" : "deny");
    setError("");
    try {
      await api(`/api/devices/pair/${request.id}`, { method: "POST", json: { allow } });
      setState(allow ? "approved" : "denied");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const Icon = request?.platform === "android" || request?.platform === "ios" ? Smartphone : request?.platform === "macos" ? Laptop : Monitor;

  return (
    <div className="min-h-svh bg-[hsl(var(--background))] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <LoomLogo size={48} className="mb-4 drop-shadow-sm" />
          <h1 className="text-xl font-semibold text-center">
            {state === "pending" ? "Allow this app?" : state === "approved" ? "App connected" : state === "denied" ? "Request declined" : "Request not found"}
          </h1>
        </div>

        <div className="bg-[hsl(var(--card))] border rounded-2xl p-6 shadow-sm">
          {state === "pending" && request && (
            <div className="space-y-5">
              <div className="flex items-center gap-3">
                <span className="w-10 h-10 rounded-lg bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] flex items-center justify-center shrink-0">
                  <Icon size={20} />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{request.deviceName}</p>
                  <p className="text-xs text-[hsl(var(--muted-foreground))]">
                    Loom for {PLATFORM_LABEL[request.platform] ?? request.platform} · {formatRelative(request.createdAt)}
                    {request.requestIp && request.requestIp !== "unknown" && ` · ${request.requestIp}`}
                  </p>
                </div>
              </div>

              <div className="rounded-xl bg-[hsl(var(--muted))] px-4 py-3 text-center">
                <p className="text-xs text-[hsl(var(--muted-foreground))]">{CHECK_HINT[request.platform] ?? "Check that the Loom app shows the same code"}</p>
                <p className="text-2xl font-semibold tracking-[0.2em] tabular-nums mt-1">{request.checkCode}</p>
              </div>

              <p className="text-sm text-[hsl(var(--muted-foreground))]">
                The app will be able to see, upload, change and delete your files as{" "}
                <span className="text-[hsl(var(--foreground))]">{userName}</span>. You can remove it at any time in
                Devices.
              </p>

              {error && <p className="text-sm text-[hsl(var(--destructive))]">{error}</p>}

              <div className="flex gap-2">
                <button
                  onClick={() => decide(false)}
                  disabled={!!busy}
                  className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border text-sm font-medium hover:bg-[hsl(var(--accent))] disabled:opacity-60"
                >
                  {busy === "deny" && <Loader2 size={15} className="animate-spin" />}
                  Decline
                </button>
                <button
                  onClick={() => decide(true)}
                  disabled={!!busy}
                  autoFocus
                  className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] text-sm font-medium hover:opacity-90 disabled:opacity-60"
                >
                  {busy === "allow" && <Loader2 size={15} className="animate-spin" />}
                  Allow
                </button>
              </div>
            </div>
          )}

          {state === "approved" && (
            <div className="flex flex-col items-center text-center gap-3">
              <span className="w-10 h-10 rounded-full bg-emerald-500/15 text-emerald-600 flex items-center justify-center">
                <Check size={20} />
              </span>
              <p className="text-sm text-[hsl(var(--muted-foreground))]">
                {request?.deviceName ? <span className="text-[hsl(var(--foreground))]">{request.deviceName}</span> : "The app"} can
                now use Loom. Go back to the app; it continues on its own.
              </p>
            </div>
          )}

          {(state === "denied" || state === "expired" || state === "missing") && (
            <div className="flex flex-col items-center text-center gap-3">
              <span className="w-10 h-10 rounded-full bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] flex items-center justify-center">
                <X size={20} />
              </span>
              <p className="text-sm text-[hsl(var(--muted-foreground))]">
                {state === "denied"
                  ? "The app was not given access."
                  : state === "expired"
                    ? "This request expired. Start again in the app."
                    : "This link isn't valid. Start again in the app."}
              </p>
            </div>
          )}
        </div>

        <p className="text-center mt-4">
          <Link href="/devices" className="text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]">
            Manage devices
          </Link>
        </p>
      </div>
    </div>
  );
}
