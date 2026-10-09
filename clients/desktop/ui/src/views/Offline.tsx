/** Shown in Loom's window when the server can't be reached. */

import { useState } from "react";
import { CloudOff, Loader2, ArrowUpDown, RotateCcw } from "lucide-react";
import { api } from "../lib/ipc";
import { Button } from "../components/ui";

export function Offline() {
  const [busy, setBusy] = useState(false);
  const server = new URLSearchParams(location.hash.split("?")[1] ?? "").get("server");
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 pb-10 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
        <CloudOff size={26} />
      </div>
      <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold">Can&apos;t reach Loom</h1>
      <p className="mt-2 max-w-sm text-sm text-[hsl(var(--muted-foreground))]">
        {server ? <span className="selectable">{server}</span> : "Your Loom"} isn&apos;t answering. Check that this PC is online. Transfers
        that are waiting continue by themselves when it&apos;s back.
      </p>
      <div className="mt-6 flex gap-2">
        <Button
          variant="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await api.openMain(null);
            setTimeout(() => setBusy(false), 4000);
          }}
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <RotateCcw size={15} />}
          Try again
        </Button>
        <Button onClick={() => api.openTransfers()}>
          <ArrowUpDown size={15} /> Transfers
        </Button>
      </div>
    </div>
  );
}
