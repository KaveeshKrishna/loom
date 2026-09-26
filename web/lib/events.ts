/**
 * events.ts — live change notifications.
 *
 * Anything that changes the index (web API routes and the scanner alike)
 * publishes a small JSON payload on the Postgres channel `loom_events`. The
 * web process keeps ONE listening connection and fans events out to every
 * open browser tab through /api/events (Server-Sent Events). Browsers use it
 * to refresh just the folder that changed — e.g. a thumbnail appearing a few
 * seconds after an upload — instead of polling.
 *
 * Payload: { type: "changed", dirs: string[], nodeIds?: string[], reason?: string }
 * `dirs` are relative directory paths ("" = root) whose listing changed.
 */

import { Client } from "pg";
import { prisma } from "./prisma";

export interface LoomEvent {
  type: "changed" | "job";
  dirs?: string[];
  nodeIds?: string[];
  /** "processed" when the scanner finished generating thumbnails/previews */
  reason?: string;
  job?: {
    id: string;
    kind: string;
    status: string;
    progress?: number;
    userId?: string;
    bytesDone?: number;
    bytesTotal?: number;
    filesDone?: number;
    filesTotal?: number;
    summary?: { done: number; skipped: number; failed: number; errors: { path: string; error: string }[] };
    error?: string;
  };
}

type Listener = (ev: LoomEvent) => void;

/** Publish a change. Never throws — live updates are best-effort. */
export async function publishChange(dirs: string[], nodeIds?: string[]): Promise<void> {
  const payload: LoomEvent = { type: "changed", dirs: [...new Set(dirs)] };
  if (nodeIds?.length) payload.nodeIds = nodeIds.slice(0, 50);
  await publish(payload);
}

export async function publish(ev: LoomEvent): Promise<void> {
  let json = JSON.stringify(ev);
  // NOTIFY payloads must stay under 8000 bytes.
  if (json.length > 7500) json = JSON.stringify({ type: ev.type, dirs: ev.dirs?.slice(0, 20) });
  await prisma.$executeRaw`SELECT pg_notify('loom_events', ${json})`.catch(() => {});
}

// ─── Single shared LISTEN connection, fanned out in-process ────────────────

const g = globalThis as unknown as {
  __loomEventHub?: { listeners: Set<Listener>; client: Client | null; connecting: Promise<void> | null };
};
const hub = (g.__loomEventHub ??= { listeners: new Set(), client: null, connecting: null });

async function ensureListening(): Promise<void> {
  if (hub.client || hub.connecting) return hub.connecting ?? undefined;
  hub.connecting = (async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    client.on("notification", (msg) => {
      if (msg.channel !== "loom_events" || !msg.payload) return;
      let ev: LoomEvent;
      try {
        ev = JSON.parse(msg.payload);
      } catch {
        return;
      }
      for (const l of hub.listeners) {
        try {
          l(ev);
        } catch {
          /* a broken listener must not affect others */
        }
      }
    });
    const reset = () => {
      hub.client = null;
      client.removeAllListeners();
      client.end().catch(() => {});
      // Reconnect lazily if anyone is still listening.
      if (hub.listeners.size > 0) setTimeout(() => ensureListening().catch(() => {}), 2000);
    };
    client.on("error", reset);
    client.on("end", () => {
      if (hub.client === client) reset();
    });
    await client.connect();
    await client.query("LISTEN loom_events");
    hub.client = client;
  })().finally(() => {
    hub.connecting = null;
  });
  return hub.connecting;
}

export async function subscribe(listener: Listener): Promise<() => void> {
  hub.listeners.add(listener);
  await ensureListening().catch((err) => console.warn("[events] LISTEN failed:", err?.message));
  return () => {
    hub.listeners.delete(listener);
  };
}
