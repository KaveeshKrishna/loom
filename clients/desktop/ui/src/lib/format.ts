/** Numbers for people: sizes, speeds, time left. */

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function bytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${UNITS[i]}`;
}

export function speed(bps: number): string {
  return bps > 0 ? `${bytes(bps)}/s` : "";
}

export function timeLeft(remaining: number, bps: number): string {
  if (bps <= 0 || remaining <= 0) return "";
  const s = remaining / bps;
  if (s < 60) return `${Math.max(1, Math.round(s))} s left`;
  if (s < 3600) return `${Math.round(s / 60)} min left`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h} h ${m} min left` : `${h} h left`;
}

export function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function ago(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(ms));
}

export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function folderLabel(path: string): string {
  return path ? path.split("/").join(" › ") : "Home";
}
