/** Which files the in-browser editor may open and save. */
export const MAX_EDITABLE_BYTES = 5 * 1024 * 1024;

const TEXT_EXT = new Set([
  "txt", "md", "markdown", "mdx", "json", "jsonc", "yml", "yaml", "toml", "ini", "conf", "cfg", "env", "properties",
  "csv", "tsv", "log", "xml", "html", "htm", "css", "scss", "less", "js", "mjs", "cjs", "ts", "tsx", "jsx",
  "py", "sh", "bash", "zsh", "fish", "ps1", "bat", "go", "rs", "java", "kt", "kts", "swift", "c", "h", "cpp", "hpp",
  "cc", "cs", "rb", "php", "pl", "lua", "r", "sql", "vue", "svelte", "gradle", "dockerfile", "makefile", "cmake",
  "srt", "vtt", "ass", "tex", "bib", "rst", "org", "adoc", "gitignore", "gitattributes", "editorconfig", "nfo", "diff", "patch",
]);

const TEXT_NAMES = new Set(["dockerfile", "makefile", "readme", "license", "changelog", ".gitignore", ".env", ".editorconfig"]);

export function isEditableName(name: string, mimeType?: string | null): boolean {
  const lower = name.toLowerCase();
  if (TEXT_NAMES.has(lower)) return true;
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  if (TEXT_EXT.has(ext)) return true;
  return !!mimeType && (mimeType.startsWith("text/") || mimeType === "application/json" || mimeType === "application/xml");
}

/** Heuristic: text files don't contain NUL bytes in their first 8 KB. */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
