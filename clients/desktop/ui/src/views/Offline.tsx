/**
 * Shown in Loom's window when the server can't be reached (offline, or
 * restarting during an update). Checks every few seconds and brings Loom
 * back by itself, at the folder that was open.
 */

import { useEffect, useRef, useState } from "react";
import { CloudOff, Loader2, ArrowUpDown, RotateCcw } from "lucide-react";
import { api } from "../lib/ipc";
import { Button } from "../components/ui";

const EVERY = 3;

export function Offline() {
  const server = new URLSearchParams(location.hash.split("?")[1] ?? "").get("server");
  const [next, setNext] = useState(EVERY);
  const [checking, setChecking] = useState(false);
  const [back, setBack] = useState(false);
  const busy = useRef(false);

  const check = async () => {
    if (busy.current) return;
    busy.current = true;
    setChecking(true);
    try {
      if (await api.serverStatus()) {
        setBack(true);
        await api.reloadLoom();
      }
    } finally {
      busy.current = false;
      setChecking(false);
      setNext(EVERY);
    }
  };

  useEffect(() => {
    const t = setInterval(() => {
      setNext((n) => {
        if (n <= 1) {
          void check();
          return EVERY;
        }
        return n - 1;
      });
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full flex-col items-center justify-center px-8 pb-10 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
        {back ? <Loader2 size={26} className="animate-spin" /> : <CloudOff size={26} />}
      </div>
      <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold">{back ? "Loom is back" : "Can’t reach Loom"}</h1>
      <p className="mt-2 max-w-sm text-sm text-[hsl(var(--muted-foreground))]">
        {back ? (
          "Opening it again…"
        ) : (
          <>
            {server ? <span className="selectable">{server}</span> : "Your Loom"} isn’t answering. It may be restarting after an update, or this PC may
            be offline. Transfers that are waiting continue by themselves when it’s back.
          </>
        )}
      </p>
      {!back && (
        <p className="mt-4 text-xs text-[hsl(var(--muted-foreground))] tabular-nums" aria-live="polite">
          {checking ? "Checking…" : `Checking again in ${next} s`}
        </p>
      )}
      <div className="mt-6 flex gap-2">
        <Button
          variant="primary"
          disabled={checking || back}
          onClick={async () => {
            // Try right away, even if the last check failed.
            setChecking(true);
            await api.reloadLoom();
            setTimeout(() => setChecking(false), 8000);
          }}
        >
          {checking ? <Loader2 size={15} className="animate-spin" /> : <RotateCcw size={15} />}
          Reload now
        </Button>
        <Button onClick={() => api.openTransfers()}>
          <ArrowUpDown size={15} /> Transfers
        </Button>
      </div>
    </div>
  );
}
