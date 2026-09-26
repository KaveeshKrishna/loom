"use client";

/**
 * Asks what to do when an item already exists at the destination, like the
 * Windows "Replace or Skip Files" dialog: Replace / Skip / Keep both, with
 * "Do this for the other N conflicts". Shows both files' size and date, and
 * says so when they look identical.
 *
 * Promise-based: `const choice = await askCollision({...})` (null = cancel).
 * <CollisionHost/> is mounted once in MainShell.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Copy, ArrowRight, SkipForward, Equal } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { formatBytes } from "@/lib/utils";

export type CollisionAction = "skip" | "replace" | "keep_both";

export interface ItemInfo {
  type: "FILE" | "DIRECTORY";
  size: number | null;
  modifiedAt: string | null;
}

interface Request {
  name: string;
  destLabel: string;
  remaining: number;
  isFolder: boolean;
  /** Optional details (from POST /api/fs/conflicts). */
  existing?: ItemInfo;
  incoming?: ItemInfo;
  /** A file and a folder share the name: Replace isn't offered. */
  mismatch?: boolean;
  /** Same size and date. */
  same?: boolean;
  /** Where the conflict is, relative to the destination (for nested files). */
  where?: string;
  resolve: (v: { action: CollisionAction; applyToAll: boolean } | null) => void;
}

let pending: Request | null = null;
const subs = new Set<(r: Request | null) => void>();

export function askCollision(opts: Omit<Request, "resolve">): Promise<{ action: CollisionAction; applyToAll: boolean } | null> {
  return new Promise((resolve) => {
    pending = { ...opts, resolve };
    subs.forEach((s) => s(pending));
  });
}

function describe(i?: ItemInfo) {
  if (!i) return null;
  const parts = [i.type === "DIRECTORY" ? "Folder" : i.size != null ? formatBytes(i.size) : null];
  if (i.modifiedAt) parts.push(new Date(i.modifiedAt).toLocaleString());
  return parts.filter(Boolean).join(" · ");
}

export function CollisionHost() {
  const [req, setReq] = useState<Request | null>(null);
  const [applyToAll, setApplyToAll] = useState(false);
  useEffect(() => {
    subs.add(setReq);
    return () => {
      subs.delete(setReq);
    };
  }, []);
  if (!req) return null;
  const done = (v: { action: CollisionAction; applyToAll: boolean } | null) => {
    pending = null;
    setReq(null);
    setApplyToAll(false);
    req.resolve(v);
  };
  const Option = ({ icon, title, desc, onClick, tone, disabled }: { icon: React.ReactNode; title: string; desc: string; onClick: () => void; tone: string; disabled?: boolean }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center gap-3 p-3 rounded-lg border hover:bg-[hsl(var(--accent))] transition-colors text-left disabled:opacity-40 disabled:pointer-events-none"
    >
      <div className={`p-2 rounded-md ${tone}`}>{icon}</div>
      <div>
        <div className="font-medium text-sm">{title}</div>
        <div className="text-xs text-[hsl(var(--muted-foreground))]">{desc}</div>
      </div>
    </button>
  );
  const existing = describe(req.existing);
  const incoming = describe(req.incoming);
  return (
    <Dialog
      open
      onClose={() => done(null)}
      title={
        <span className="flex items-center gap-2">
          <AlertTriangle size={17} className="text-amber-500 shrink-0" />
          <span className="truncate">&ldquo;{req.name}&rdquo; already exists</span>
        </span>
      }
    >
      <p className="text-sm text-[hsl(var(--muted-foreground))] mb-3">
        {req.mismatch ? "An item" : req.isFolder ? "A folder" : "A file"} named <span className="font-semibold text-[hsl(var(--foreground))]">{req.name}</span> is already in{" "}
        <span className="font-semibold text-[hsl(var(--foreground))] break-all">{req.where || req.destLabel}</span>.
      </p>
      {(existing || incoming) && (
        <div className="mb-4 rounded-lg border text-xs divide-y">
          {existing && (
            <div className="flex justify-between gap-3 px-3 py-2">
              <span className="text-[hsl(var(--muted-foreground))]">Already there</span>
              <span className="text-right">{existing}</span>
            </div>
          )}
          {incoming && (
            <div className="flex justify-between gap-3 px-3 py-2">
              <span className="text-[hsl(var(--muted-foreground))]">New</span>
              <span className="text-right">{incoming}</span>
            </div>
          )}
          {req.same && (
            <div className="flex items-center gap-1.5 px-3 py-2 text-emerald-600 dark:text-emerald-400">
              <Equal size={13} /> Same size and date, so probably the same file
            </div>
          )}
        </div>
      )}
      <div className="space-y-2">
        <Option
          icon={<ArrowRight size={17} />}
          tone="bg-blue-500/10 text-blue-500"
          title="Replace"
          desc={req.mismatch ? "Not possible: one is a file and the other a folder." : "The existing one goes to Trash (you can restore it for 15 days)."}
          disabled={req.mismatch}
          onClick={() => done({ action: "replace", applyToAll })}
        />
        <Option
          icon={<SkipForward size={17} />}
          tone="bg-gray-500/10 text-gray-500"
          title="Skip"
          desc="Leave the existing one as it is."
          onClick={() => done({ action: "skip", applyToAll })}
        />
        <Option
          icon={<Copy size={17} />}
          tone="bg-green-500/10 text-green-600"
          title="Keep both"
          desc="The new one gets a number added to its name, e.g. photo (1).jpg."
          onClick={() => done({ action: "keep_both", applyToAll })}
        />
      </div>
      {req.remaining > 0 && (
        <label className="mt-4 flex items-center gap-2 text-sm cursor-pointer select-none">
          <input type="checkbox" checked={applyToAll} onChange={(e) => setApplyToAll(e.target.checked)} />
          Do this for the other {req.remaining} conflict{req.remaining === 1 ? "" : "s"}
        </label>
      )}
      <div className="mt-4 flex justify-end">
        <button onClick={() => done(null)} className="text-sm px-3 py-1.5 rounded-md hover:bg-[hsl(var(--accent))]">
          Cancel
        </button>
      </div>
    </Dialog>
  );
}

// ─── resolving a batch ───────────────────────────────────────────────────────

export interface ConflictInfo {
  key: string;
  name: string;
  existing: ItemInfo;
  incoming: ItemInfo;
  kind: "file" | "mismatch";
  same: boolean;
}

export interface Resolution {
  decisions: Record<string, CollisionAction>;
  /** The "do this for all" choice (also used for conflicts that appear later), else skip. */
  defaultAction: CollisionAction;
}

/**
 * Ask about each conflict in turn. Ticking "Do this for the other N" answers
 * the rest. Returns null if the user cancelled (nothing should happen then).
 */
export async function resolveConflicts(conflicts: ConflictInfo[], destLabel: string): Promise<Resolution | null> {
  const decisions: Record<string, CollisionAction> = {};
  for (let i = 0; i < conflicts.length; i++) {
    const c = conflicts[i];
    const parent = c.key.includes("/") ? c.key.slice(0, c.key.lastIndexOf("/")) : "";
    const choice = await askCollision({
      name: c.name,
      destLabel,
      where: parent ? `${destLabel}/${parent}` : destLabel,
      remaining: conflicts.length - i - 1,
      isFolder: c.existing.type === "DIRECTORY",
      existing: c.existing,
      incoming: c.incoming,
      mismatch: c.kind === "mismatch",
      same: c.same,
    });
    if (!choice) return null;
    decisions[c.key] = choice.action;
    if (choice.applyToAll) {
      for (const rest of conflicts.slice(i + 1)) decisions[rest.key] = choice.action;
      return { decisions, defaultAction: choice.action };
    }
  }
  return { decisions, defaultAction: "skip" };
}
