/** Settings: account, how transfers behave, downloads, Windows integration. */

import { useEffect, useState } from "react";
import { FolderOpen, LogOut, FileText, RefreshCw, Download, Loader2 } from "lucide-react";
import { api, listen, type AppSettings, type AppState, type Snapshot, type UpdateInfo, type UpdateMode, type UpdateStatus } from "../lib/ipc";
import { ago } from "../lib/format";
import { Button, Card, Field, Select, Switch } from "../components/ui";

const MB = 1024 * 1024;
const SPEEDS = [
  { value: 0, label: "No limit" },
  { value: 1 * MB, label: "1 MB/s" },
  { value: 2 * MB, label: "2 MB/s" },
  { value: 5 * MB, label: "5 MB/s" },
  { value: 10 * MB, label: "10 MB/s" },
  { value: 25 * MB, label: "25 MB/s" },
];

export function SettingsView() {
  const [s, setS] = useState<AppSettings | null>(null);
  const [app, setApp] = useState<AppState | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);

  useEffect(() => {
    api.settings().then(setS);
    api.appState().then(setApp);
    api.snapshot().then(setSnap);
  }, []);

  const update = (patch: Partial<AppSettings>) => {
    if (!s) return;
    const next = { ...s, ...patch };
    setS(next);
    api.setSettings(next);
  };

  if (!s || !app) return null;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-6 px-6 py-5">
        <h1 className="font-[family-name:var(--font-display)] text-xl font-semibold">Settings</h1>

        <Card title="Account">
          <Field label={app.user ? app.user.name : "Not signed in"} hint={app.user ? `${app.user.email} · ${app.serverUrl ?? ""}` : app.serverUrl ?? ""}>
            <Button size="sm" onClick={() => api.signOut()}>
              <LogOut size={14} /> Sign out
            </Button>
          </Field>
          <Field label="This PC" hint="Shown in Loom under Devices">
            <span className="selectable text-sm text-[hsl(var(--muted-foreground))]">{app.deviceName}</span>
          </Field>
        </Card>

        <Card title="Transfers">
          <Field label="Files at the same time" hint="More is faster for many small files">
            <Select label="Files at the same time" value={s.parallelFiles} onChange={(v) => update({ parallelFiles: v })} options={[1, 2, 3, 4, 6, 8].map((n) => ({ value: n, label: String(n) }))} />
          </Field>
          <Field label="Parts of a file at the same time" hint="More is faster for big files on fast connections">
            <Select label="Parts of a file at the same time" value={s.parallelChunks} onChange={(v) => update({ parallelChunks: v })} options={[1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))} />
          </Field>
          <Field label="Speed limit" hint="Leaves room for everything else on your connection">
            <Select label="Speed limit" value={s.speedLimit} onChange={(v) => update({ speedLimit: v })} options={SPEEDS} />
          </Field>
          <Field
            label="Go straight to the server at home"
            hint={
              snap?.via === "lan"
                ? "Connected directly over your home network"
                : "Uses your home network when the server offers it (much faster than over the internet)"
            }
          >
            <Switch label="Go straight to the server at home" checked={s.useLan} onChange={(v) => update({ useLan: v })} />
          </Field>
          <Field label="Keep the PC awake while transferring" hint="Windows won't go to sleep in the middle of an upload">
            <Switch label="Keep the PC awake while transferring" checked={s.keepAwake} onChange={(v) => update({ keepAwake: v })} />
          </Field>
        </Card>

        <Card title="Downloads">
          <Field label="Save downloads to" hint={<span className="selectable">{s.downloadDir}</span>}>
            <Button
              size="sm"
              onClick={async () => {
                const d = await api.chooseDownloadDir();
                if (d) update({ downloadDir: d });
              }}
            >
              <FolderOpen size={14} /> Change
            </Button>
          </Field>
          <Field label="Ask where to save each time">
            <Switch label="Ask where to save each time" checked={s.askDownloadDir} onChange={(v) => update({ askDownloadDir: v })} />
          </Field>
        </Card>

        <Card title="Windows">
          <Field label="Start Loom when I sign in to Windows" hint="Unfinished transfers continue in the background">
            <Switch label="Start Loom when I sign in to Windows" checked={s.startAtLogin} onChange={(v) => update({ startAtLogin: v })} />
          </Field>
          <Field label="“Upload to Loom” in File Explorer" hint="Right-click files or folders (under “Show more options” on Windows 11)">
            <Switch label="Upload to Loom in File Explorer" checked={s.explorerMenu} onChange={(v) => update({ explorerMenu: v })} />
          </Field>
          <Field label="Loom in “Send to”" hint="Right-click › Send to › Loom">
            <Switch label="Loom in Send to" checked={s.sendTo} onChange={(v) => update({ sendTo: v })} />
          </Field>
        </Card>

        <UpdatesCard mode={s.updateMode} onMode={(m) => update({ updateMode: m })} />

        <Card title="About">
          <Field label={app.serverVersion ? `Connected to Loom ${app.serverVersion}` : "Loom server"} hint={app.serverUrl ?? undefined}>
            <Button size="sm" variant="ghost" onClick={() => api.openLogs()}>
              <FileText size={14} /> Logs
            </Button>
          </Field>
        </Card>
      </div>
    </div>
  );
}

const UPDATE_MODES: { value: UpdateMode; label: string }[] = [
  { value: "ask", label: "Download, then ask me" },
  { value: "auto", label: "Install when idle" },
  { value: "notify", label: "Only tell me" },
];

function statusText(st: UpdateStatus): string {
  switch (st.state) {
    case "checking":
      return "Checking for updates…";
    case "upToDate":
      return `Up to date · checked ${ago(st.checkedAt * 1000)}`;
    case "available":
      return `Loom ${st.version} is available`;
    case "downloading":
      return `Downloading Loom ${st.version}… ${st.percent}%`;
    case "ready":
      return `Loom ${st.version} is ready to install`;
    case "installing":
      return `Installing Loom ${st.version}… Loom restarts by itself`;
    case "failed":
      return st.error;
    default:
      return "Updates come from Loom's releases on GitHub";
  }
}

/** Updates: the version, what's happening, and how updates are installed. */
function UpdatesCard({ mode, onMode }: { mode: UpdateMode; onMode: (m: UpdateMode) => void }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    api.updateInfo().then(setInfo);
    const off = listen<UpdateStatus>("update-status", (status) => setInfo((i) => (i ? { ...i, status } : i)));
    return () => void off.then((f) => f());
  }, []);
  if (!info) return null;
  const st = info.status;
  const busy = st.state === "checking" || st.state === "downloading" || st.state === "installing";
  const notes = (st.state === "ready" || st.state === "available") && st.notes ? st.notes : null;
  return (
    <Card title="Updates">
      <Field label={`Loom for Windows ${info.current}`} hint={<span className={st.state === "failed" ? "text-[hsl(var(--danger))]" : undefined}>{statusText(st)}</span>}>
        {st.state === "ready" || st.state === "available" ? (
          <Button size="sm" variant="primary" onClick={() => api.installUpdate()}>
            <Download size={14} /> {st.state === "ready" ? "Install now" : "Download and install"}
          </Button>
        ) : (
          <Button size="sm" disabled={busy} onClick={async () => setInfo(await api.checkUpdates())}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Check now
          </Button>
        )}
      </Field>
      {notes && (
        <div className="px-4 py-3">
          <div className="text-xs font-medium text-[hsl(var(--muted-foreground))]">What’s new</div>
          <p className="selectable mt-1 whitespace-pre-line text-sm">{notes}</p>
        </div>
      )}
      <Field
        label="When an update is available"
        hint={
          mode === "auto"
            ? "Installs while nothing is transferring; Loom restarts and transfers continue"
            : mode === "notify"
              ? "You choose when to download and install"
              : "Downloads in the background; you choose when to install"
        }
      >
        <Select label="When an update is available" value={mode} onChange={onMode} options={UPDATE_MODES} />
      </Field>
    </Card>
  );
}
