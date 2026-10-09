/** "These names are already taken in Loom": decide per file, or for all. */

import { useEffect, useState } from "react";
import { FileText, Folder } from "lucide-react";
import { api, type Conflict, type OnConflict } from "../lib/ipc";
import { bytes, fileName } from "../lib/format";
import { Button, Dialog, cx } from "../components/ui";

const when = (ms: number | string | null) =>
  ms == null ? "" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));

export function ConflictDialog({ batchId, onClose }: { batchId: number; onClose: () => void }) {
  const [list, setList] = useState<Conflict[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.conflicts(batchId).then(setList);
  }, [batchId]);

  const decide = async (itemId: number | null, d: OnConflict) => {
    setBusy(true);
    try {
      await api.decide(batchId, itemId, d);
      const next = await api.conflicts(batchId);
      setList(next);
      if (next.length === 0) onClose();
    } finally {
      setBusy(false);
    }
  };

  const n = list?.length ?? 0;
  const anyFolder = list?.some((c) => c.existingIsFolder);
  return (
    <Dialog
      wide
      title={n === 1 ? "A file with this name is already in Loom" : `${n} files with these names are already in Loom`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Decide later</Button>
          <div className="flex-1" />
          <Button disabled={busy || !n} onClick={() => decide(null, "skip")}>
            Skip all
          </Button>
          <Button disabled={busy || !n} onClick={() => decide(null, "keep_both")}>
            Keep both for all
          </Button>
          <Button variant="primary" disabled={busy || !n || anyFolder} onClick={() => decide(null, "replace")} title={anyFolder ? "A folder can't be replaced by a file" : undefined}>
            Replace all
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-[hsl(var(--muted-foreground))]">
        Replace moves the existing file to Loom&apos;s Trash, where you can restore it for 15 days. Keep both adds a number to the new one&apos;s name.
      </p>
      <ul className="divide-y divide-[hsl(var(--border))] rounded-lg border border-[hsl(var(--border))]">
        {(list ?? []).map((c) => (
          <li key={c.itemId} className="flex items-center gap-3 px-3 py-2.5">
            <span className="text-[hsl(var(--muted-foreground))]">{c.existingIsFolder ? <Folder size={18} /> : <FileText size={18} />}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium" title={c.relativePath}>
                {fileName(c.relativePath)}
                {c.same && <span className="ml-2 rounded bg-[hsl(var(--muted))] px-1.5 py-0.5 text-[11px] font-normal text-[hsl(var(--muted-foreground))]">looks identical</span>}
              </p>
              <p className="tabular text-xs text-[hsl(var(--muted-foreground))]">
                {c.existingIsFolder ? "A folder with this name" : <>In Loom: {bytes(c.existingSize ?? 0)}, {when(c.existingModified)}</>}
                <span className="mx-1.5">·</span>
                New: {bytes(c.incomingSize)}, {when(c.incomingModifiedMs)}
              </p>
            </div>
            <div className="flex shrink-0 gap-1">
              <Choice disabled={busy || c.existingIsFolder} onClick={() => decide(c.itemId, "replace")}>Replace</Choice>
              <Choice disabled={busy} onClick={() => decide(c.itemId, "skip")}>Skip</Choice>
              <Choice disabled={busy} onClick={() => decide(c.itemId, "keep_both")}>Keep both</Choice>
            </div>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function Choice({ children, disabled, onClick }: { children: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={cx("h-7 rounded-md border border-[hsl(var(--border-strong))] px-2 text-xs hover:bg-[hsl(var(--accent))] disabled:opacity-40")}
    >
      {children}
    </button>
  );
}
