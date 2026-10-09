/**
 * First run: which Loom, then approve this PC in Loom (the app opens the
 * approval page in its Loom window; the user checks the code and allows it).
 */

import { useEffect, useState } from "react";
import { ArrowRight, Check, Loader2, ShieldCheck, X } from "lucide-react";
import { api, listen } from "../lib/ipc";
import { Button, LoomMark } from "../components/ui";

type Step = { kind: "server" } | { kind: "approve"; code: string } | { kind: "done" } | { kind: "stopped"; reason: "denied" | "expired" };

export function Onboarding() {
  const [step, setStep] = useState<Step>({ kind: "server" });
  const [url, setUrl] = useState("https://");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.appState().then((s) => {
      setName(s.deviceName);
      if (s.serverUrl) setUrl(s.serverUrl);
    });
    const off = listen<string>("pairing", (status) => {
      if (status === "approved") setStep({ kind: "done" });
      else if (status === "denied" || status === "expired") setStep({ kind: "stopped", reason: status });
    });
    return () => {
      off.then((f) => f());
    };
  }, []);

  const connect = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const check = await api.checkServer(url.trim());
      if (!check.ok) {
        setError(check.error ?? "That address doesn't answer like Loom.");
        return;
      }
      setUrl(check.url);
      const p = await api.startPairing(check.url, name.trim() || "Windows PC");
      setStep({ kind: "approve", code: p.checkCode });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center px-10 pb-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <LoomMark size={48} />
          <h1 className="mt-4 font-[family-name:var(--font-display)] text-2xl font-semibold">
            {step.kind === "done" ? "You're all set" : step.kind === "approve" ? "Allow this PC in Loom" : "Connect to your Loom"}
          </h1>
          {step.kind === "server" && (
            <p className="mt-1.5 text-sm text-[hsl(var(--muted-foreground))]">Uploads and downloads then keep going in the background, even after a restart.</p>
          )}
        </div>

        {step.kind === "server" && (
          <form onSubmit={connect} className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium">Loom address</span>
              <input
                autoFocus
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                spellCheck={false}
                placeholder="https://loom.example.com"
                className="selectable h-9 w-full rounded-md border border-[hsl(var(--border-strong))] bg-[hsl(var(--surface))] px-3 text-sm outline-none focus:border-[hsl(var(--primary))] focus:ring-2 focus:ring-[hsl(var(--primary)/0.25)]"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium">Name for this PC</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="selectable h-9 w-full rounded-md border border-[hsl(var(--border-strong))] bg-[hsl(var(--surface))] px-3 text-sm outline-none focus:border-[hsl(var(--primary))] focus:ring-2 focus:ring-[hsl(var(--primary)/0.25)]"
              />
              <span className="mt-1 block text-xs text-[hsl(var(--muted-foreground))]">Shown in Loom under Devices.</span>
            </label>
            {error && (
              <p role="alert" className="text-[13px] text-[hsl(var(--danger))]">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" className="h-9 w-full" disabled={busy || url.trim().length < 10}>
              {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
              Continue
            </Button>
          </form>
        )}

        {step.kind === "approve" && (
          <div className="space-y-5 text-center">
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              Loom opened in a window. Sign in if it asks, check that it shows this code, and choose <span className="font-medium text-[hsl(var(--foreground))]">Allow</span>.
            </p>
            <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface))] py-4">
              <p className="tabular font-[family-name:var(--font-display)] text-3xl font-semibold tracking-[0.18em]">{step.code}</p>
            </div>
            <p className="flex items-center justify-center gap-2 text-[13px] text-[hsl(var(--muted-foreground))]">
              <Loader2 size={14} className="animate-spin" /> Waiting for you to allow it…
            </p>
            <Button
              variant="ghost"
              onClick={async () => {
                await api.cancelPairing();
                setStep({ kind: "server" });
              }}
            >
              Cancel
            </Button>
          </div>
        )}

        {step.kind === "done" && (
          <div className="space-y-5 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[hsl(var(--success)/0.12)] text-[hsl(var(--success))]">
              <Check size={24} />
            </div>
            <ul className="space-y-2 text-left text-sm text-[hsl(var(--muted-foreground))]">
              <li className="flex gap-2">
                <ShieldCheck size={16} className="mt-0.5 shrink-0 text-[hsl(var(--primary))]" /> Right-click files in File Explorer and choose Upload to Loom.
              </li>
              <li className="flex gap-2">
                <ShieldCheck size={16} className="mt-0.5 shrink-0 text-[hsl(var(--primary))]" /> Loom keeps running in the notification area. Closing its window doesn&apos;t stop transfers.
              </li>
            </ul>
            <Button variant="primary" className="h-9 w-full" onClick={() => api.closeWindow()}>
              Open Loom
            </Button>
          </div>
        )}

        {step.kind === "stopped" && (
          <div className="space-y-5 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
              <X size={24} />
            </div>
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              {step.reason === "denied" ? "This PC wasn't allowed." : "The request expired before it was allowed."}
            </p>
            <Button variant="primary" className="h-9 w-full" onClick={() => connect()}>
              Try again
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
