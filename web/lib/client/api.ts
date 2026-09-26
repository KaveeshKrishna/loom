/** Small fetch helpers for the browser. */

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T = Record<string, unknown>>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  let body: Record<string, unknown> = {};
  try {
    body = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new ApiError(res.status, (body.error as string) || `Request failed (${res.status})`, body);
  return body as T;
}

/** Encode a relative path for use in /files/... URLs (each segment escaped). */
export function filesHref(relativePath: string): string {
  return relativePath ? "/files/" + relativePath.split("/").map(encodeURIComponent).join("/") : "/files";
}

export function parentOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
}
