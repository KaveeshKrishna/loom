/**
 * web/lib/demo/mockServer.ts
 *
 * The demo's fake backend. Replaces `window.fetch`: every JSON `/api/*`
 * request is served from the localStorage-backed world in state.ts;
 * everything else (JS chunks, fonts, `/demo-assets/*`) falls through to the
 * real fetch. There is no network backend in the demo build.
 *
 * NOT handled here: `/api/cache/*` and `/api/files/serve*`. Those are
 * requested via native <img>/<video>/<a> resource loads (not `fetch()`),
 * which this monkeypatch can never see — they're served by the Service
 * Worker at web/public/demo-sw.js instead. See that file's header comment.
 */
import { getState, mutate, nextId } from "./state";
import { DemoFileNode, DemoAclRule, DemoUser, DemoAuditLog, DemoNotification, DEMO_OWNER_ID } from "./types";

const realFetch = typeof window !== "undefined" ? window.fetch.bind(window) : (undefined as unknown as typeof fetch);

export function installFetch(): void {
  window.fetch = demoFetch as typeof fetch;
}

async function demoFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init.method || (typeof input !== "string" && !(input instanceof URL) ? input.method : undefined) || "GET").toUpperCase();

  let parsed: URL;
  try {
    parsed = new URL(url, window.location.origin);
  } catch {
    return realFetch(input, init);
  }

  const path = parsed.pathname;
  if (!path.startsWith("/api/") || path.startsWith("/api/cache/") || path.startsWith("/api/files/serve")) {
    return realFetch(input, init);
  }

  let body: Record<string, unknown> = {};
  try {
    if (init.body) body = JSON.parse(init.body as string);
  } catch {
    /* not JSON — fine, most GET/DELETE calls have no body */
  }

  await tick();

  try {
    const result = route(method, path, { body, search: parsed.searchParams });
    if (result instanceof Response) return result;
    return json(result ?? { ok: true });
  } catch (err) {
    const status = (err as { __status?: number }).__status ?? 500;
    return json({ error: (err as Error).message || "Demo error" }, status);
  }
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
function fail(status: number, message: string): Error {
  const e = new Error(message) as Error & { __status: number };
  e.__status = status;
  return e;
}
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 80 + Math.random() * 140));
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function visible(nodes: DemoFileNode[]): DemoFileNode[] {
  return nodes.filter((n) => n.isVisible && !n.inTrash);
}

function findNode(relativePath: string): DemoFileNode | undefined {
  return getState().nodes.find((n) => n.relativePath === relativePath && !n.inTrash);
}

function childrenOneLevel(prefix: string): DemoFileNode[] {
  const p = prefix ? `${prefix}/` : "";
  return visible(getState().nodes).filter((n) => {
    if (!n.relativePath.startsWith(p)) return false;
    const rest = n.relativePath.slice(p.length);
    return rest.length > 0 && !rest.includes("/");
  });
}

function paginate<T extends { id: string }>(list: T[], limit: number, cursor: string | null) {
  let startIdx = 0;
  if (cursor) {
    const idx = list.findIndex((x) => x.id === cursor);
    startIdx = idx >= 0 ? idx + 1 : 0;
  }
  const page = list.slice(startIdx, startIdx + limit);
  const hasMore = startIdx + limit < list.length;
  return { page, nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null };
}

function auditWithUser(log: DemoAuditLog) {
  const user = getState().users.find((u) => u.id === log.userId);
  return { ...log, user: user ? { name: user.name, email: user.email } : null };
}

function renameDescendants(oldPrefix: string, newPrefix: string) {
  const s = getState();
  for (const n of s.nodes) {
    if (n.relativePath.startsWith(oldPrefix + "/")) {
      n.relativePath = newPrefix + n.relativePath.slice(oldPrefix.length);
    }
  }
}

function uniqueName(dir: string, name: string): string {
  const existing = new Set(childrenOneLevel(dir).map((n) => n.name));
  if (!existing.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let i = 1;
  let candidate = `${base} (${i})${ext}`;
  while (existing.has(candidate)) {
    i += 1;
    candidate = `${base} (${i})${ext}`;
  }
  return candidate;
}

// ─── router ──────────────────────────────────────────────────────────────────

interface Ctx {
  body: Record<string, unknown>;
  search: URLSearchParams;
}

function route(method: string, path: string, ctx: Ctx): unknown {
  const p = path.replace(/^\/api/, "");
  const seg = p.split("/").filter(Boolean);
  const M = (m: string) => method === m;
  const s = getState();

  // ── files ──
  if (p === "/files" && M("GET")) {
    const pathParam = ctx.search.get("path") ?? "";
    return { path: pathParam, children: childrenOneLevel(pathParam) };
  }

  if (p === "/files/type" && M("GET")) {
    const type = ctx.search.get("type") ?? "";
    const limit = Math.min(parseInt(ctx.search.get("limit") ?? "100", 10), 500);
    const cursor = ctx.search.get("cursor");
    const prefix = type === "image" ? "image/" : type === "video" ? "video/" : type === "document" ? "application/" : null;
    if (!prefix) return { nodes: [], nextCursor: null };
    const list = visible(s.nodes)
      .filter((n) => n.type === "FILE" && n.mimeType?.startsWith(prefix))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    const { page, nextCursor } = paginate(list, limit, cursor);
    return { nodes: page, nextCursor };
  }

  if (p === "/files/recent" && M("GET")) {
    const list = visible(s.nodes)
      .filter((n) => n.type === "FILE")
      .sort((a, b) => (String(a.modifiedAt) < String(b.modifiedAt) ? 1 : -1))
      .slice(0, 100);
    return { nodes: list };
  }

  if (p === "/files/size" && M("GET")) {
    const pathParam = ctx.search.get("path") ?? "";
    const prefix = pathParam ? `${pathParam}/` : "";
    const total = visible(s.nodes)
      .filter((n) => n.type === "FILE" && (pathParam ? n.relativePath.startsWith(prefix) : true))
      .reduce((sum, n) => sum + Number(n.size ?? 0), 0);
    return { path: pathParam, size: String(total) };
  }

  if (p === "/files/properties" && M("GET")) {
    const pathParam = ctx.search.get("path");
    if (!pathParam) throw fail(400, "Path is required");
    const node = findNode(pathParam);
    if (!node) throw fail(404, "Not found");
    let childCount: number | undefined;
    let size = node.size ?? "0";
    if (node.type === "DIRECTORY") {
      const prefix = `${node.relativePath}/`;
      const descendants = visible(s.nodes).filter((n) => n.relativePath.startsWith(prefix));
      childCount = descendants.length;
      size = String(descendants.filter((n) => n.type === "FILE").reduce((sum, n) => sum + Number(n.size ?? 0), 0));
    }
    return {
      type: node.type,
      relativePath: node.relativePath,
      size,
      childCount,
      modifiedAt: node.modifiedAt,
      healthStatus: node.healthStatus,
      healthError: node.healthError,
      fastHash: node.contentIdentity?.fastHash,
      videoDetails: node.contentIdentity?.videoCaches?.[0]
        ? { duration: node.contentIdentity.videoCaches[0].durationSeconds ?? 0 }
        : null,
    };
  }

  if (p === "/files/health" && M("GET")) {
    const statusFilter = ctx.search.get("status");
    const all = s.nodes.filter((n) => !n.inTrash && (n.healthStatus === "CORRUPT" || n.healthStatus === "UNSUPPORTED"));
    const filtered = statusFilter ? all.filter((n) => n.healthStatus === statusFilter) : all;
    const corrupt = all.filter((n) => n.healthStatus === "CORRUPT").length;
    const unsupported = all.filter((n) => n.healthStatus === "UNSUPPORTED").length;
    return {
      nodes: filtered.map((n) => ({
        id: n.id, name: n.name, relativePath: n.relativePath, type: n.type, mimeType: n.mimeType,
        size: n.size, modifiedAt: n.modifiedAt, healthStatus: n.healthStatus, healthError: n.healthError,
        sourceVersion: n.sourceVersion,
      })),
      summary: { total: all.length, corrupt, unsupported },
    };
  }

  if (seg[0] === "files" && seg[1] === "hls" && seg.length === 3 && M("GET")) {
    // Probe — always report native-compatible so MediaViewer plays the
    // Service Worker-served bundled clip directly; real HLS is never
    // exercised in the demo (see web/public/demo-sw.js).
    const id = seg[2];
    const node = s.nodes.find((n) => n.id === id);
    const duration = node?.contentIdentity?.videoCaches?.[0]?.durationSeconds ?? 30;
    return { compatible: true, fileNodeId: id, sourceVersion: node?.sourceVersion ?? null, durationSeconds: duration, hlsReady: false };
  }

  // ── fs ──
  if ((p === "/fs/copy" || p === "/fs/move") && M("POST")) {
    const { sourcePaths, destDir, action = "skip" } = ctx.body as { sourcePaths: string[]; destDir: string; action?: string };
    if (!Array.isArray(sourcePaths) || sourcePaths.length === 0 || destDir == null) throw fail(400, "Invalid parameters");
    const isCopy = p === "/fs/copy";
    const results: unknown[] = [];
    mutate((st) => {
      for (const srcRel of sourcePaths) {
        const src = st.nodes.find((n) => n.relativePath === srcRel && !n.inTrash);
        if (!src) { results.push({ path: srcRel, error: "Source not found" }); continue; }
        const fileName = src.name;
        let targetName = fileName;
        const collision = childrenOneLevel(destDir).find((n) => n.name === fileName);
        if (collision) {
          if (action === "skip") { results.push({ path: srcRel, skipped: true }); continue; }
          if (action === "replace") st.nodes = st.nodes.filter((n) => n.id !== collision.id);
          if (action === "keep_both") targetName = uniqueName(destDir, fileName);
        }
        const targetRel = destDir ? `${destDir}/${targetName}` : targetName;
        if (isCopy) {
          const clone: DemoFileNode = { ...src, id: nextId("file"), relativePath: targetRel, name: targetName };
          st.nodes.push(clone);
        } else {
          src.relativePath = targetRel;
          src.name = targetName;
          renameDescendants(srcRel, targetRel);
        }
        results.push({ path: srcRel, success: true, targetRel });
      }
      st.auditLogs.unshift({ id: nextId("audit"), userId: DEMO_OWNER_ID, action: isCopy ? "COPY" : "MOVE", details: { count: sourcePaths.length }, timestamp: new Date().toISOString() });
    });
    return { results };
  }

  if (p === "/fs/rename" && M("POST")) {
    const { sourcePath, newName, action = "skip" } = ctx.body as { sourcePath: string; newName: string; action?: string };
    if (!sourcePath || !newName) throw fail(400, "Invalid parameters");
    const dir = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
    let targetName = newName;
    const collision = childrenOneLevel(dir).find((n) => n.name === newName && n.relativePath !== sourcePath);
    if (collision) {
      if (action === "skip") return { path: sourcePath, skipped: true };
      if (action === "keep_both") targetName = uniqueName(dir, newName);
      if (action === "replace") mutate((st) => { st.nodes = st.nodes.filter((n) => n.id !== collision.id); });
    }
    const targetRel = dir ? `${dir}/${targetName}` : targetName;
    mutate((st) => {
      const node = st.nodes.find((n) => n.relativePath === sourcePath && !n.inTrash);
      if (!node) throw fail(404, "Source not found");
      node.relativePath = targetRel;
      node.name = targetName;
      renameDescendants(sourcePath, targetRel);
      st.auditLogs.unshift({ id: nextId("audit"), userId: DEMO_OWNER_ID, action: "RENAME", details: { source: sourcePath, dest: targetRel }, timestamp: new Date().toISOString() });
    });
    return { path: sourcePath, success: true, targetRel };
  }

  if (p === "/fs/mkdir" && M("POST")) {
    const { parentPath, name } = ctx.body as { parentPath: string; name: string };
    if (!name || typeof parentPath !== "string") throw fail(400, "Invalid parameters");
    const finalName = uniqueName(parentPath, name);
    const targetRel = parentPath ? `${parentPath}/${finalName}` : finalName;
    mutate((st) => {
      st.nodes.push({
        id: nextId("dir"), relativePath: targetRel, name: finalName, type: "DIRECTORY",
        mimeType: null, size: null, modifiedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        indexedAt: new Date().toISOString(), isVisible: true, sourceVersion: null, browserCompatible: null,
        healthStatus: "HEALTHY", healthError: null, inTrash: false, contentIdentityId: null, contentIdentity: null,
      });
      st.auditLogs.unshift({ id: nextId("audit"), userId: DEMO_OWNER_ID, action: "MKDIR", details: { path: targetRel }, timestamp: new Date().toISOString() });
    });
    return { success: true, path: targetRel };
  }

  if (p === "/fs/trash" && M("GET")) {
    const items = s.trashItems.map((t) => {
      const fileNode = s.nodes.find((n) => n.id === t.fileNodeId);
      let size = fileNode?.size ?? "0";
      if (fileNode?.type === "DIRECTORY") {
        const prefix = `.LoomTrash/${t.trashPath}/`;
        size = String(s.nodes.filter((n) => n.relativePath.startsWith(prefix)).reduce((sum, n) => sum + Number(n.size ?? 0), 0));
      }
      return { ...t, fileNode: fileNode ? { ...fileNode, size } : null };
    });
    return { trashItems: items };
  }

  if (p === "/fs/trash" && M("POST")) {
    const { paths } = ctx.body as { paths: string[] };
    if (!Array.isArray(paths) || paths.length === 0) throw fail(400, "No paths provided");
    const results: unknown[] = [];
    mutate((st) => {
      for (const relativePath of paths) {
        const node = st.nodes.find((n) => n.relativePath === relativePath && !n.inTrash);
        if (!node) { results.push({ path: relativePath, error: "Not found" }); continue; }
        const trashFileName = `${nextId("t")}_${node.name}`;
        const newRootRel = `.LoomTrash/${trashFileName}`;
        renameDescendants(relativePath, newRootRel);
        for (const n of st.nodes) {
          if (n.relativePath.startsWith(newRootRel + "/") || n.id === node.id) n.inTrash = true;
        }
        node.relativePath = newRootRel;
        node.inTrash = true;
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 15);
        st.trashItems.push({
          id: nextId("trashitem"), fileNodeId: node.id, originalPath: relativePath,
          trashPath: trashFileName, deletedAt: new Date().toISOString(), expiresAt: expiresAt.toISOString(),
          deletedByUserId: DEMO_OWNER_ID,
        });
        st.auditLogs.unshift({ id: nextId("audit"), userId: DEMO_OWNER_ID, action: "TRASH", details: { path: relativePath }, timestamp: new Date().toISOString() });
        results.push({ path: relativePath, success: true });
      }
    });
    return { results };
  }

  if (p === "/fs/trash" && M("DELETE")) {
    let deletedCount = 0;
    mutate((st) => {
      deletedCount = st.trashItems.length;
      const trashPrefixes = st.trashItems.map((t) => `.LoomTrash/${t.trashPath}`);
      st.nodes = st.nodes.filter((n) => !trashPrefixes.some((pre) => n.relativePath === pre || n.relativePath.startsWith(pre + "/")));
      st.trashItems = [];
      st.auditLogs.unshift({ id: nextId("audit"), userId: DEMO_OWNER_ID, action: "EMPTY_TRASH", details: { count: deletedCount }, timestamp: new Date().toISOString() });
    });
    return { success: true, deletedCount };
  }

  if (seg[0] === "fs" && seg[1] === "trash" && seg[2] && M("DELETE")) {
    const id = seg[2];
    mutate((st) => {
      const item = st.trashItems.find((t) => t.id === id);
      if (!item) throw fail(404, "Trash item not found");
      const rootRel = `.LoomTrash/${item.trashPath}`;
      st.nodes = st.nodes.filter((n) => n.relativePath !== rootRel && !n.relativePath.startsWith(rootRel + "/"));
      st.trashItems = st.trashItems.filter((t) => t.id !== id);
      st.auditLogs.unshift({ id: nextId("audit"), userId: DEMO_OWNER_ID, action: "PERMANENT_DELETE", details: { originalPath: item.originalPath }, timestamp: new Date().toISOString() });
    });
    return { success: true };
  }

  if (p === "/fs/restore" && M("POST")) {
    const { fileNodeIds } = ctx.body as { fileNodeIds: string[] };
    if (!Array.isArray(fileNodeIds) || fileNodeIds.length === 0) throw fail(400, "No fileNodeIds provided");
    const results: unknown[] = [];
    mutate((st) => {
      for (const fileNodeId of fileNodeIds) {
        const item = st.trashItems.find((t) => t.fileNodeId === fileNodeId);
        if (!item) { results.push({ id: fileNodeId, error: "Trash item not found" }); continue; }
        const collision = st.nodes.find((n) => n.relativePath === item.originalPath && !n.inTrash);
        if (collision) { results.push({ id: fileNodeId, error: "Conflict: already exists at destination", code: 409 }); continue; }
        const rootRel = `.LoomTrash/${item.trashPath}`;
        const node = st.nodes.find((n) => n.id === fileNodeId)!;
        renameDescendants(rootRel, item.originalPath);
        for (const n of st.nodes) {
          if (n.relativePath === item.originalPath || n.relativePath.startsWith(item.originalPath + "/")) n.inTrash = false;
        }
        node.relativePath = item.originalPath;
        node.inTrash = false;
        st.trashItems = st.trashItems.filter((t) => t.id !== item.id);
        st.auditLogs.unshift({ id: nextId("audit"), userId: DEMO_OWNER_ID, action: "RESTORE", details: { path: item.originalPath }, timestamp: new Date().toISOString() });
        results.push({ id: fileNodeId, success: true });
      }
    });
    return { results };
  }

  // ── favorites ──
  if (p === "/favorites" && M("GET")) {
    const limit = Math.min(parseInt(ctx.search.get("limit") ?? "100", 10), 500);
    const cursor = ctx.search.get("cursor");
    const favList = s.favorites
      .map((f) => ({ id: f.fileNodeId, createdAt: f.createdAt, fileNode: s.nodes.find((n) => n.id === f.fileNodeId) }))
      .filter((f) => f.fileNode && !f.fileNode.inTrash)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const { page, nextCursor } = paginate(favList as unknown as { id: string }[], limit, cursor);
    return { favorites: page, nextCursor };
  }
  if (p === "/favorites" && M("POST")) {
    const { fileNodeId } = ctx.body as { fileNodeId: string };
    let favorited = false;
    mutate((st) => {
      const existing = st.favorites.find((f) => f.fileNodeId === fileNodeId);
      if (existing) {
        st.favorites = st.favorites.filter((f) => f.fileNodeId !== fileNodeId);
        favorited = false;
      } else {
        st.favorites.push({ userId: DEMO_OWNER_ID, fileNodeId, createdAt: new Date().toISOString() });
        favorited = true;
      }
    });
    return { favorited };
  }

  // ── search ──
  if (p === "/search" && M("GET")) {
    const q = (ctx.search.get("q") ?? "").trim().toLowerCase();
    if (!q) return { results: [] };
    const folder = ctx.search.get("folder")?.trim();
    const prefix = folder ? `${folder}/` : "";
    const results = visible(s.nodes)
      .filter((n) => n.name.toLowerCase().includes(q) && (!prefix || n.relativePath.startsWith(prefix)))
      .slice(0, 50);
    return { results };
  }

  // ── scan ──
  if (p === "/scan" && M("GET")) {
    return { jobs: s.scanJobs.slice(0, 10), scannerStatus: s.scannerStatus };
  }
  if (p === "/scan" && M("POST")) {
    const totalFiles = visible(s.nodes).filter((n) => n.type === "FILE").length;
    const job = { id: nextId("scan"), type: "FULL_RESCAN" as const, status: "RUNNING" as const, requestedAt: new Date().toISOString(), startedAt: new Date().toISOString(), completedAt: null, error: null, processedFiles: 0, totalFiles };
    mutate((st) => { st.scanJobs.unshift(job); st.scannerStatus = "scanning"; });
    // Fabricate a realistic-looking scan: ScanPanel polls every 3s while a
    // job is RUNNING and renders processedFiles/totalFiles as a progress
    // bar, so climb in irregular steps over ~3.5s rather than jumping
    // straight from 0 to done — then complete reporting "0 new files",
    // since this is a static fabricated library and nothing is ever
    // actually found.
    const ticks = 8 + Math.floor(Math.random() * 4);
    let tick = 0;
    const stepMs = 300 + Math.random() * 150;
    const step = () => {
      tick += 1;
      mutate((st) => {
        const j = st.scanJobs.find((x) => x.id === job.id);
        if (!j || j.status !== "RUNNING") return; // cancelled/deleted — stop advancing
        if (tick >= ticks) {
          j.status = "COMPLETED";
          j.completedAt = new Date().toISOString();
          j.processedFiles = totalFiles;
          st.scannerStatus = "idle";
        } else {
          j.processedFiles = Math.min(totalFiles, Math.round((totalFiles * tick) / ticks));
        }
      });
      if (tick < ticks) {
        const j = getState().scanJobs.find((x) => x.id === job.id);
        if (j && j.status === "RUNNING") setTimeout(step, stepMs);
      }
    };
    setTimeout(step, stepMs);
    return { job };
  }
  if (p === "/scan" && M("DELETE")) {
    const id = ctx.search.get("id");
    mutate((st) => {
      if (!id) { st.scanJobs = st.scanJobs.filter((j) => !["COMPLETED", "FAILED", "CANCELLED"].includes(j.status)); return; }
      const job = st.scanJobs.find((j) => j.id === id);
      if (!job) return;
      if (job.status === "RUNNING" || job.status === "PENDING") job.status = "CANCELLED";
      else st.scanJobs = st.scanJobs.filter((j) => j.id !== id);
    });
    return { success: true };
  }

  // ── audit ──
  if (p === "/audit" && M("GET")) {
    return { logs: s.auditLogs.slice(0, 20).map(auditWithUser) };
  }
  if (p === "/audit" && M("DELETE")) {
    const id = ctx.search.get("id");
    mutate((st) => { st.auditLogs = id ? st.auditLogs.filter((l) => l.id !== id) : []; });
    return { success: true };
  }

  // ── acl ──
  if (p === "/acl" && M("GET")) {
    const userId = ctx.search.get("userId");
    const rules = (userId ? s.aclRules.filter((r) => r.userId === userId) : s.aclRules).map((r) => ({
      ...r,
      user: s.users.find((u) => u.id === r.userId),
    }));
    return { rules };
  }
  if (p === "/acl" && M("POST")) {
    const { userId, path: aclPath, allow } = ctx.body as { userId: string; path: string; allow: boolean };
    if (!userId || !aclPath || typeof allow !== "boolean") throw fail(400, "userId, path, and allow are required");
    let rule: DemoAclRule;
    mutate((st) => {
      const existing = st.aclRules.find((r) => r.userId === userId && r.path === aclPath);
      if (existing) { existing.allow = allow; rule = existing; }
      else { rule = { id: nextId("acl"), userId, path: aclPath, allow }; st.aclRules.push(rule); }
    });
    return { rule: rule! };
  }
  if (p === "/acl" && M("DELETE")) {
    const { id } = ctx.body as { id: string };
    mutate((st) => { st.aclRules = st.aclRules.filter((r) => r.id !== id); });
    return { success: true };
  }

  // ── users ──
  if (p === "/users" && M("GET")) {
    return { users: s.users.map(({ id, name, email, role, createdAt }) => ({ id, name, email, role, createdAt })) };
  }
  if (p === "/users" && M("POST")) {
    const { name, email, role } = ctx.body as { name: string; email: string; password?: string; role?: string };
    if (!name || !email) throw fail(400, "name, email, and password are required");
    if (s.users.some((u) => u.email === email)) throw fail(409, "Email already in use");
    let user: DemoUser;
    mutate((st) => {
      user = { id: nextId("user"), name, email, role: role === "OWNER" ? "OWNER" : "FAMILY", createdAt: new Date().toISOString() };
      st.users.push(user);
      st.auditLogs.unshift({ id: nextId("audit"), userId: DEMO_OWNER_ID, action: "USER_CREATED", details: { targetEmail: email }, timestamp: new Date().toISOString() });
    });
    return { user: user! };
  }
  if (seg[0] === "users" && seg[1] && M("PATCH")) {
    const id = seg[1];
    const { name, role } = ctx.body as { name?: string; role?: string };
    let user: DemoUser | undefined;
    mutate((st) => {
      user = st.users.find((u) => u.id === id);
      if (!user) throw fail(404, "Not found");
      if (name) user.name = name;
      if (role) user.role = role === "OWNER" ? "OWNER" : "FAMILY";
      st.auditLogs.unshift({ id: nextId("audit"), userId: DEMO_OWNER_ID, action: "USER_UPDATED", details: { targetId: id }, timestamp: new Date().toISOString() });
    });
    return { user: user! };
  }
  if (seg[0] === "users" && seg[1] && M("DELETE")) {
    const id = seg[1];
    if (id === DEMO_OWNER_ID) throw fail(400, "Cannot delete your own account");
    mutate((st) => {
      st.users = st.users.filter((u) => u.id !== id);
      st.aclRules = st.aclRules.filter((r) => r.userId !== id);
      st.auditLogs.unshift({ id: nextId("audit"), userId: DEMO_OWNER_ID, action: "USER_DELETED", details: { targetId: id }, timestamp: new Date().toISOString() });
    });
    return { success: true };
  }

  // ── notifications ──
  if (p === "/notifications" && M("GET")) {
    const unreadOnly = ctx.search.get("unread") === "true";
    const list = s.notifications.filter((n) => !unreadOnly || !n.read).slice(0, 50);
    return list; // real route returns a bare array
  }
  if (p === "/notifications/dismiss" && M("POST")) {
    const { notificationId, dismissAll } = ctx.body as { notificationId?: string; dismissAll?: boolean };
    mutate((st) => {
      if (dismissAll) st.notifications.forEach((n) => { n.read = true; });
      else if (notificationId) {
        const n = st.notifications.find((x: DemoNotification) => x.id === notificationId);
        if (n) n.read = true;
      }
    });
    return { success: true };
  }

  // ── video-cache / thumbnail-cache ──
  if (p === "/video-cache" && M("GET")) return s.videoCacheStats;
  if (p === "/video-cache" && M("DELETE")) {
    mutate((st) => { st.videoCacheStats = { ...st.videoCacheStats, usedBytes: 0, cachedVideos: 0 }; });
    return { success: true };
  }
  if (p === "/thumbnail-cache" && M("GET")) return s.thumbCacheStats;
  if (p === "/thumbnail-cache" && M("DELETE")) {
    mutate((st) => { st.thumbCacheStats = { thumbCount: 0, previewCount: 0, physicalFiles: 0 }; });
    return { success: true };
  }

  throw fail(404, `Demo: no mock handler for ${method} ${path}`);
}
