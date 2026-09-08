import React from "react";
import { AlertTriangle, Copy, X, ArrowRight, FileQuestion } from "lucide-react";

export type CollisionAction = "skip" | "replace" | "keep_both";

interface CollisionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  fileName: string;
  destDir: string;
  onAction: (action: CollisionAction, applyToAll: boolean) => void;
  multipleCollisions?: boolean;
}

export function CollisionDialog({
  isOpen,
  onClose,
  fileName,
  destDir,
  onAction,
  multipleCollisions = false,
}: CollisionDialogProps) {
  const [applyToAll, setApplyToAll] = React.useState(false);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-[hsl(var(--background))] border border-[hsl(var(--border))] rounded-lg shadow-xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between px-4 py-3 border-b bg-[hsl(var(--muted))]">
          <div className="flex items-center gap-2 text-[hsl(var(--foreground))]">
            <AlertTriangle size={18} className="text-amber-500" />
            <h2 className="text-lg font-semibold">&quot;{fileName}&quot; already exists</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5">
          <p className="text-sm text-[hsl(var(--muted-foreground))] mb-4">
            A file named <span className="font-semibold text-[hsl(var(--foreground))]">&quot;{fileName}&quot;</span> already exists in <span className="font-semibold text-[hsl(var(--foreground))]">{destDir}</span>.
          </p>

          <div className="space-y-2">
            <button
              onClick={() => onAction("replace", applyToAll)}
              className="w-full flex items-center gap-3 p-3 rounded-md border hover:bg-[hsl(var(--accent))] transition-colors text-left"
            >
              <div className="p-2 bg-blue-500/10 text-blue-500 rounded-md">
                <ArrowRight size={18} />
              </div>
              <div>
                <div className="font-medium text-sm">Replace</div>
                <div className="text-xs text-[hsl(var(--muted-foreground))]">Overwrite the existing file with this one.</div>
              </div>
            </button>

            <button
              onClick={() => onAction("keep_both", applyToAll)}
              className="w-full flex items-center gap-3 p-3 rounded-md border hover:bg-[hsl(var(--accent))] transition-colors text-left"
            >
              <div className="p-2 bg-green-500/10 text-green-500 rounded-md">
                <Copy size={18} />
              </div>
              <div>
                <p className="text-sm font-medium">Keep both</p>
                <p className="text-xs text-[hsl(var(--muted-foreground))]">Adds a number to the copied file&apos;s name</p>
              </div>
            </button>

            <button
              onClick={() => onAction("skip", applyToAll)}
              className="w-full flex items-center gap-3 p-3 rounded-md border hover:bg-[hsl(var(--accent))] transition-colors text-left"
            >
              <div className="p-2 bg-gray-500/10 text-gray-500 rounded-md">
                <FileQuestion size={18} />
              </div>
              <div>
                <div className="font-medium text-sm">Skip</div>
                <div className="text-xs text-[hsl(var(--muted-foreground))]">Don&apos;t copy or move this file.</div>
              </div>
            </button>
          </div>

          {multipleCollisions && (
            <div className="mt-4 flex items-center gap-2">
              <input
                type="checkbox"
                id="applyToAll"
                checked={applyToAll}
                onChange={(e) => setApplyToAll(e.target.checked)}
                className="rounded border-[hsl(var(--border))] text-[hsl(var(--primary))] focus:ring-[hsl(var(--primary))]"
              />
              <label htmlFor="applyToAll" className="text-sm font-medium text-[hsl(var(--foreground))]">
                Do this for all remaining conflicts
              </label>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
