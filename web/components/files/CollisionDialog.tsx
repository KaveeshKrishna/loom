"use client";

/**
 * Asks what to do when an item already exists at the destination.
 * Promise-based: `const choice = await askCollision({...})`.
 * <CollisionHost/> is mounted once in MainShell.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Copy, ArrowRight, SkipForward } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";

export type CollisionAction = "skip" | "replace" | "keep_both";

interface Request {
  name: string;
  destLabel: string;
  remaining: number;
  isFolder: boolean;
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
  const Option = ({ icon, title, desc, onClick, tone }: { icon: React.ReactNode; title: string; desc: string; onClick: () => void; tone: string }) => (
    <button onClick={onClick} className="w-full flex items-center gap-3 p-3 rounded-lg border hover:bg-[hsl(var(--accent))] transition-colors text-left">
      <div className={`p-2 rounded-md ${tone}`}>{icon}</div>
      <div>
        <div className="font-medium text-sm">{title}</div>
        <div className="text-xs text-[hsl(var(--muted-foreground))]">{desc}</div>
      </div>
    </button>
  );
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
      <p className="text-sm text-[hsl(var(--muted-foreground))] mb-4">
        {req.isFolder ? "A folder" : "An item"} named <span className="font-semibold text-[hsl(var(--foreground))]">{req.name}</span> is already in{" "}
        <span className="font-semibold text-[hsl(var(--foreground))]">{req.destLabel}</span>.
      </p>
      <div className="space-y-2">
        <Option
          icon={<Copy size={17} />}
          tone="bg-green-500/10 text-green-600"
          title="Keep both"
          desc="Adds a number to the new item's name."
          onClick={() => done({ action: "keep_both", applyToAll })}
        />
        <Option
          icon={<ArrowRight size={17} />}
          tone="bg-blue-500/10 text-blue-500"
          title="Replace"
          desc="The existing item is moved to Trash (you can restore it for 15 days)."
          onClick={() => done({ action: "replace", applyToAll })}
        />
        <Option
          icon={<SkipForward size={17} />}
          tone="bg-gray-500/10 text-gray-500"
          title="Skip"
          desc="Leave this one where it is."
          onClick={() => done({ action: "skip", applyToAll })}
        />
      </div>
      {req.remaining > 0 && (
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={applyToAll} onChange={(e) => setApplyToAll(e.target.checked)} />
          Do this for the other {req.remaining} conflict{req.remaining === 1 ? "" : "s"}
        </label>
      )}
    </Dialog>
  );
}
