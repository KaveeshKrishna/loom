"use client";

/**
 * Devices: the Loom apps signed in to this account (lib/devices.ts).
 *  - download links for the apps
 *  - a one-time pairing code, shown as a QR code, for phones and tablets
 *  - the list of paired apps, with rename and remove (the Owner also sees
 *    and can remove everyone else's)
 */

import { useCallback, useEffect, useState } from "react";
import { Monitor, Smartphone, Laptop, MonitorSmartphone, Loader2, QrCode as QrIcon, Pencil, Trash2, ArrowUpRight, RefreshCw } from "lucide-react";
import { useNav } from "@/components/layout/TopBarContext";
import { api } from "@/lib/client/api";
import { toast } from "@/components/ui/Toaster";
import { dialogs } from "@/components/ui/Dialog";
import { formatDate, formatRelative, cn } from "@/lib/utils";
import { QrCode } from "./QrCode";

export const APP_DOWNLOADS = {
  windows: "https://github.com/KaveeshKrishna/loom/releases?q=desktop&expanded=true",
  android: "https://github.com/KaveeshKrishna/loom/releases?q=android&expanded=true",
};

export interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  appVersion: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  lastIp: string | null;
  current: boolean;
  mine: boolean;
  user: { id: string; name: string; email: string };
}

const PLATFORM_LABEL: Record<string, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  android: "Android",
  ios: "iOS",
};

function PlatformIcon({ platform, size = 18 }: { platform: string; size?: number }) {
  if (platform === "android" || platform === "ios") return <Smartphone size={size} />;
  if (platform === "macos") return <Laptop size={size} />;
  return <Monitor size={size} />;
}

export function DevicesPage() {
  const { setBreadcrumbs } = useNav();
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  useEffect(() => setBreadcrumbs([{ label: "Devices", href: "/devices" }]), [setBreadcrumbs]);

  const load = useCallback(async () => {
    try {
      setDevices((await api<{ devices: DeviceRow[] }>("/api/devices")).devices);
    } catch (e) {
      toast.error((e as Error).message);
      setDevices([]);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const rename = async (d: DeviceRow) => {
    const name = await dialogs.prompt({ title: "Rename device", defaultValue: d.name, confirmLabel: "Rename" });
    if (!name || name === d.name) return;
    await api(`/api/devices/${d.id}`, { method: "PATCH", json: { name } }).catch((e) => toast.error((e as Error).message));
    load();
  };
  const remove = async (d: DeviceRow) => {
    const ok = await dialogs.confirm({
      title: `Remove “${d.name}”?`,
      message: "The app is signed out right away. Uploads it hasn't finished stop; you can pair it again at any time.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    await api(`/api/devices/${d.id}`, { method: "DELETE" }).catch((e) => toast.error((e as Error).message));
    load();
  };

  const mine = devices?.filter((d) => d.mine) ?? [];
  const others = devices?.filter((d) => !d.mine) ?? [];

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-8">
      <div>
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <MonitorSmartphone size={19} /> Devices
        </h1>
        <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">
          The Loom apps keep uploads and downloads going in the background, resume them after a restart, and
          upload straight over your home network.
        </p>
      </div>

      <section aria-labelledby="get-apps" className="grid gap-3 sm:grid-cols-2">
        <h2 id="get-apps" className="sr-only">Get the apps</h2>
        <AppCard
          icon={<Monitor size={20} />}
          title="Loom for Windows"
          detail="Windows 10 and 11 · Explorer “Upload to Loom”"
          href={APP_DOWNLOADS.windows}
        />
        <AppCard
          icon={<Smartphone size={20} />}
          title="Loom for Android"
          detail="Phones and tablets · Android 8 and later"
          href={APP_DOWNLOADS.android}
        />
      </section>

      <PairingCard />

      <section aria-labelledby="your-devices" className="space-y-2">
        <h2 id="your-devices" className="text-sm font-semibold">
          Your devices
        </h2>
        {!devices ? (
          <div className="flex justify-center py-12">
            <Loader2 className="animate-spin text-[hsl(var(--muted-foreground))]" />
          </div>
        ) : mine.length === 0 ? (
          <div className="border rounded-xl px-4 py-10 text-center">
            <p className="text-sm text-[hsl(var(--muted-foreground))]">No apps are signed in yet.</p>
          </div>
        ) : (
          <DeviceList devices={mine} onRename={rename} onRemove={remove} />
        )}
      </section>

      {others.length > 0 && (
        <section aria-labelledby="other-devices" className="space-y-2">
          <h2 id="other-devices" className="text-sm font-semibold">
            Other people&apos;s devices
          </h2>
          <DeviceList devices={others} onRemove={remove} showUser />
        </section>
      )}
    </div>
  );
}

function AppCard({ icon, title, detail, href }: { icon: React.ReactNode; title: string; detail: string; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group min-w-0 flex items-center gap-3 border rounded-xl px-4 py-3.5 hover:bg-[hsl(var(--accent))] transition-colors"
    >
      <span className="w-10 h-10 rounded-lg bg-[hsl(var(--primary)/0.1)] text-[hsl(var(--primary))] flex items-center justify-center shrink-0">
        {icon}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-[hsl(var(--muted-foreground))] truncate">{detail}</span>
      </span>
      <ArrowUpRight size={16} className="text-[hsl(var(--muted-foreground))] group-hover:text-[hsl(var(--foreground))] shrink-0" />
    </a>
  );
}

function PairingCard() {
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!code) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [code]);

  const create = async () => {
    setBusy(true);
    try {
      setCode(await api<{ code: string; expiresAt: string }>("/api/devices/codes", { method: "POST" }));
      setNow(Date.now());
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const left = code ? Math.max(0, Math.round((new Date(code.expiresAt).getTime() - now) / 1000)) : 0;
  const expired = !!code && left === 0;
  const server = typeof window !== "undefined" ? window.location.origin : "";
  const payload = code ? `loom://pair?server=${encodeURIComponent(server)}&code=${code.code}` : "";

  return (
    <section aria-labelledby="pair" className="border rounded-xl p-4 sm:p-5">
      <div className="flex flex-col sm:flex-row gap-5">
        <div className="flex-1 min-w-0 space-y-2">
          <h2 id="pair" className="text-sm font-semibold">
            Connect a phone or tablet
          </h2>
          <ol className="text-sm text-[hsl(var(--muted-foreground))] space-y-1 list-decimal pl-4">
            <li>Open the Loom app and choose <span className="text-[hsl(var(--foreground))]">Scan a code</span>.</li>
            <li>Point the camera at the code, or type it in.</li>
          </ol>
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            On Windows, choose <span className="text-[hsl(var(--foreground))]">Sign in</span> in the app instead: it
            opens Loom and asks you to allow it.
          </p>
          {!code && (
            <button
              onClick={create}
              disabled={busy}
              className="mt-2 inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] text-sm font-medium hover:opacity-90 disabled:opacity-60"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <QrIcon size={15} />}
              Show pairing code
            </button>
          )}
        </div>

        {code && (
          <div className="flex flex-col items-center gap-2 sm:w-56 shrink-0">
            <div className={cn("p-2 bg-white rounded-xl border", expired && "opacity-30")}>
              <QrCode value={payload} size={176} label="Pairing code for the Loom app" />
            </div>
            <p className="font-mono text-sm tracking-wider tabular-nums select-all">{code.code}</p>
            {expired ? (
              <button
                onClick={create}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-[hsl(var(--primary))] hover:underline"
              >
                <RefreshCw size={12} /> Expired, get a new code
              </button>
            ) : (
              <p className="text-xs text-[hsl(var(--muted-foreground))] tabular-nums">
                Works once · expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function DeviceList({
  devices,
  onRename,
  onRemove,
  showUser,
}: {
  devices: DeviceRow[];
  onRename?: (d: DeviceRow) => void;
  onRemove: (d: DeviceRow) => void;
  showUser?: boolean;
}) {
  return (
    <ul className="divide-y border rounded-xl overflow-hidden">
      {devices.map((d) => (
        <li key={d.id} className="flex items-center gap-3 px-4 py-3">
          <span className="w-9 h-9 rounded-lg bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] flex items-center justify-center shrink-0">
            <PlatformIcon platform={d.platform} />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">
              {d.name}
              {showUser && <span className="font-normal text-[hsl(var(--muted-foreground))]"> · {d.user.name}</span>}
            </p>
            <p className="text-xs text-[hsl(var(--muted-foreground))] truncate">
              {PLATFORM_LABEL[d.platform] ?? d.platform}
              {d.appVersion && ` ${d.appVersion}`} · active {formatRelative(d.lastSeenAt)}
              <span className="hidden sm:inline"> · added {formatDate(d.createdAt)}</span>
            </p>
          </div>
          {onRename && (
            <button
              onClick={() => onRename(d)}
              className="p-2 rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))]"
              aria-label={`Rename ${d.name}`}
              title="Rename"
            >
              <Pencil size={15} />
            </button>
          )}
          <button
            onClick={() => onRemove(d)}
            className="p-2 rounded-md text-red-500 hover:bg-red-500/10"
            aria-label={`Remove ${d.name}`}
            title="Remove"
          >
            <Trash2 size={15} />
          </button>
        </li>
      ))}
    </ul>
  );
}
