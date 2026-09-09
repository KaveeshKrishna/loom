/**
 * web/lib/demo/state.ts
 *
 * The demo's mutable world, persisted per-visitor in localStorage. Every
 * mock route handler in mockServer.ts reads/writes through here. Seeded
 * from buildFixtures() on first load and after "Reset demo". Nothing here
 * ever touches a real backend — the demo build has none.
 */
import { buildFixtures } from "./fixtures";
import { DemoWorld } from "./types";

const STATE_KEY = "loom-demo-state-v1";
const AUTH_KEY = "loom-demo-authed";
const NOTE_SEEN_KEY = "loom-demo-note-seen";

let state: DemoWorld | null = null;

function load(): DemoWorld {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) return JSON.parse(raw) as DemoWorld;
  } catch {
    /* private browsing mode, quota exceeded, or corrupt JSON — start fresh */
  }
  return buildFixtures();
}

export function initState(): DemoWorld {
  if (!state) {
    state = load();
    // Persist immediately, even for a freshly-generated world. load() only
    // returns buildFixtures() in memory on a brand-new visit — without this,
    // a page refresh before the visitor makes any actual edit (which is the
    // only other thing that calls save()) would find nothing in localStorage
    // and silently regenerate a whole new random world, making file sizes
    // and other randomized values shift on every reload.
    save();
  }
  return state;
}

export function getState(): DemoWorld {
  return state || initState();
}

export function save(): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    /* ignore quota / private mode */
  }
}

/** Mutate the world in place and persist in one call. */
export function mutate(fn: (s: DemoWorld) => void): DemoWorld {
  fn(getState());
  save();
  return getState();
}

export function resetDemo(): void {
  state = buildFixtures();
  save();
  try {
    localStorage.removeItem(NOTE_SEEN_KEY);
  } catch { /* ignore */ }
}

// ─── Demo "session" (replaces better-auth entirely) ─────────────────────────

export function isDemoAuthed(): boolean {
  try {
    return localStorage.getItem(AUTH_KEY) === "1";
  } catch {
    return false;
  }
}

export function setDemoAuthed(v: boolean): void {
  try {
    if (v) localStorage.setItem(AUTH_KEY, "1");
    else localStorage.removeItem(AUTH_KEY);
  } catch { /* ignore */ }
}

// ─── "Have we shown the demo notice this browser?" ──────────────────────────

export function hasSeenDemoNotice(): boolean {
  try {
    return localStorage.getItem(NOTE_SEEN_KEY) === "1";
  } catch {
    return true; // fail closed — don't nag if storage is broken
  }
}

export function markDemoNoticeSeen(): void {
  try {
    localStorage.setItem(NOTE_SEEN_KEY, "1");
  } catch { /* ignore */ }
}

let idSeq = 0;
export function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSeq}`;
}
