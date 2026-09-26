"use client";

/**
 * Text / code / Markdown viewer and editor (loaded on demand).
 *
 *  - Syntax highlighting picked from the file name (CodeMirror language data).
 *  - Markdown files open rendered, with a Source/Preview toggle. Rendering
 *    is react-markdown without raw HTML, so a Markdown file can't inject
 *    scripts.
 *  - Edit → Save (Ctrl/Cmd+S). Saving sends the version the file had when
 *    opened; if it changed on disk meanwhile, you choose to reload or save a
 *    copy instead of overwriting. The previous version goes to Trash.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { Extension } from "@codemirror/state";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Loader2, Pencil, Save, Eye, Code2, AlertTriangle, X } from "lucide-react";
import { api, ApiError, parentOf } from "@/lib/client/api";
import { emitDirChange } from "@/lib/client/live";
import { toast } from "@/components/ui/Toaster";
import { dialogs } from "@/components/ui/Dialog";
import { cn } from "@/lib/utils";

interface Props {
  relativePath: string;
  name: string;
  startEditing?: boolean;
  /** Parent registers a guard so it can ask before closing with unsaved changes. */
  onDirtyChange?: (dirty: boolean) => void;
}

const isMarkdown = (name: string) => /\.(md|markdown|mdx)$/i.test(name);

function useIsDark() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const el = document.documentElement;
    const update = () => setDark(el.classList.contains("dark"));
    update();
    const mo = new MutationObserver(update);
    mo.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

export default function TextViewer({ relativePath, name, startEditing, onDirtyChange }: Props) {
  const [content, setContent] = useState<string>("");
  const [original, setOriginal] = useState<string>("");
  const [version, setVersion] = useState<string | null>(null);
  const [editable, setEditable] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [lang, setLang] = useState<Extension | null>(null);
  const [mode, setMode] = useState<"preview" | "source">(isMarkdown(name) ? "preview" : "source");
  const dark = useIsDark();
  const dirty = editing && content !== original;
  const saveRef = useRef<() => void>(() => {});

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api<{ content: string; version: string; editable: boolean }>(`/api/files/content?path=${encodeURIComponent(relativePath)}`);
      setContent(d.content);
      setOriginal(d.content);
      setVersion(d.version);
      setEditable(d.editable);
      if (startEditing && d.editable) {
        setEditing(true);
        setMode("source");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [relativePath, startEditing]);

  useEffect(() => {
    load();
  }, [load]);

  // Syntax highlighting, loaded lazily per language.
  useEffect(() => {
    let alive = true;
    const desc = LanguageDescription.matchFilename(languages, name);
    if (!desc) return setLang(null);
    desc.load().then((support) => alive && setLang(support)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [name]);

  const save = useCallback(
    async (force = false) => {
      if (saving) return;
      setSaving(true);
      try {
        const r = await api<{ version: string }>("/api/files/content", {
          method: "PUT",
          json: { path: relativePath, content, baseVersion: force ? undefined : version },
        });
        setVersion(r.version);
        setOriginal(content);
        emitDirChange([parentOf(relativePath)]);
        toast.success("Saved — the previous version is in Trash for 15 days");
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          const overwrite = await dialogs.confirm({
            title: "This file changed on disk",
            message:
              "Someone (or something) changed this file after you opened it.\n\nOverwrite it with your version? Their version will be kept in Trash, so nothing is lost. Choose Cancel to keep editing and copy your changes elsewhere first.",
            confirmLabel: "Overwrite",
            danger: true,
          });
          if (overwrite) {
            setSaving(false);
            return save(true);
          }
        } else {
          toast.error((e as Error).message);
        }
      } finally {
        setSaving(false);
      }
    },
    [saving, relativePath, content, version]
  );
  saveRef.current = () => save();

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editing]);

  const extensions = useMemo(() => [EditorView.lineWrapping, ...(lang ? [lang] : [])], [lang]);

  if (loading) {
    return (
      <div className="w-full h-full flex items-center justify-center text-white/60">
        <Loader2 className="animate-spin" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center text-white/70 gap-2 px-6 text-center">
        <AlertTriangle size={28} className="text-amber-400" />
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="w-full h-full flex flex-col bg-[hsl(var(--background))] text-[hsl(var(--foreground))] rounded-lg overflow-hidden" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2 px-3 h-11 border-b shrink-0 text-sm">
        {isMarkdown(name) && (
          <div className="flex rounded-md border overflow-hidden">
            <button onClick={() => setMode("preview")} className={cn("px-2.5 py-1 flex items-center gap-1", mode === "preview" && "bg-[hsl(var(--accent))] font-medium")}>
              <Eye size={14} /> Preview
            </button>
            <button onClick={() => setMode("source")} className={cn("px-2.5 py-1 flex items-center gap-1 border-l", mode === "source" && "bg-[hsl(var(--accent))] font-medium")}>
              <Code2 size={14} /> Source
            </button>
          </div>
        )}
        {dirty && <span className="text-xs text-amber-500">Unsaved changes</span>}
        <div className="ml-auto flex items-center gap-2">
          {editable && !editing && (
            <button
              onClick={() => {
                setEditing(true);
                setMode("source");
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border hover:bg-[hsl(var(--accent))]"
            >
              <Pencil size={14} /> Edit
            </button>
          )}
          {editing && (
            <>
              <button
                onClick={async () => {
                  if (dirty && !(await dialogs.confirm({ title: "Discard your changes?", confirmLabel: "Discard", danger: true }))) return;
                  setContent(original);
                  setEditing(false);
                  if (isMarkdown(name)) setMode("preview");
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md hover:bg-[hsl(var(--accent))]"
              >
                <X size={14} /> Done
              </button>
              <button
                onClick={() => save()}
                disabled={!dirty || saving}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[hsl(var(--primary))] text-white disabled:opacity-50"
                title="Save (Ctrl+S)"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
              </button>
            </>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {mode === "preview" && isMarkdown(name) && !editing ? (
          <article className="markdown-body max-w-3xl mx-auto px-6 py-6">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </article>
        ) : (
          <CodeMirror
            value={content}
            onChange={(v) => setContent(v)}
            editable={editing}
            readOnly={!editing}
            theme={dark ? "dark" : "light"}
            extensions={extensions}
            basicSetup={{ foldGutter: true, highlightActiveLine: editing, autocompletion: false }}
            height="100%"
            style={{ height: "100%", fontSize: 13 }}
          />
        )}
      </div>
    </div>
  );
}
