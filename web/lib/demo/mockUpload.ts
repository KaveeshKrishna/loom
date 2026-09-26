/**
 * web/lib/demo/mockUpload.ts
 *
 * The real uploader (components/layout/UploadContext.tsx) creates an upload
 * session with fetch (handled by mockServer.ts) and then PUTs the bytes in
 * chunks with XMLHttpRequest so it can show byte-level progress. This
 * patches XMLHttpRequest for just those chunk PUTs: it simulates progress
 * proportional to the chunk size and, on the final chunk, appends a
 * fabricated FileNode to the demo world and answers like the real server.
 *
 * Every other XHR falls through to the real XMLHttpRequest unaltered.
 */
import { getState, mutate, nextId } from "./state";
import { DEMO_OWNER_ID } from "./types";
import { pickPhotoAsset, pickVideoAsset } from "./assets";

export interface DemoUploadSession {
  id: string;
  destDir: string;
  relativePath: string;
  size: number;
  received: number;
  mimeType: string;
}

/** One chunk per file in the demo — there's no real network to spare. */
export const DEMO_CHUNK_SIZE = 64 * 1024 * 1024 * 1024;
export const demoUploadSessions = new Map<string, DemoUploadSession>();

const RealXHR = typeof window !== "undefined" ? window.XMLHttpRequest : undefined;

export function installUploadShim(): void {
  if (!RealXHR) return;

  class DemoXHR extends RealXHR {
    private _isUpload = false;
    private _url = "";

    open(method: string, url: string | URL, ...rest: unknown[]) {
      this._url = typeof url === "string" ? url : url.toString();
      this._isUpload = method.toUpperCase() === "PUT" && this._url.includes("/api/upload/sessions/");
      if (!this._isUpload) {
        // @ts-expect-error - forwarding varargs to the native implementation
        return super.open(method, url, ...rest);
      }
    }

    setRequestHeader(name: string, value: string) {
      if (!this._isUpload) super.setRequestHeader(name, value);
    }

    send(body?: Document | XMLHttpRequestBodyInit | null) {
      if (!this._isUpload) return super.send(body);
      const u = new URL(this._url, window.location.origin);
      const id = u.pathname.split("/").pop()!;
      const session = demoUploadSessions.get(id);
      if (!session) return this._respondJson(404, { error: "Upload not found or expired" });
      const bytes = body instanceof ArrayBuffer ? body.byteLength : body instanceof Blob ? body.size : 0;
      const steps = 12;
      let step = 0;
      const timer = setInterval(() => {
        step += 1;
        const loaded = Math.round((bytes * step) / steps);
        const ev = new ProgressEvent("progress", { lengthComputable: true, loaded, total: bytes });
        this.upload?.dispatchEvent(ev);
        // @ts-expect-error - onprogress may be assigned directly
        this.upload?.onprogress?.(ev);
        if (step >= steps) {
          clearInterval(timer);
          session.received += bytes;
          if (u.searchParams.get("final") === "1" && session.received >= session.size) {
            demoUploadSessions.delete(id);
            this._respondJson(200, this._finish(session, u.searchParams.get("conflict") === "replace" ? "replace" : "keep_both"));
          } else {
            this._respondJson(200, { received: session.received });
          }
        }
      }, 90);
    }

    private _finish(session: DemoUploadSession, conflict: "replace" | "keep_both") {
      const wanted = session.relativePath.split("/").pop()!;
      const subDir = session.relativePath.split("/").slice(0, -1).join("/");
      const dir = [session.destDir, subDir].filter(Boolean).join("/");
      const at = (name: string) => (dir ? `${dir}/${name}` : name);
      const taken = (name: string) => getState().nodes.some((n) => !n.inTrash && n.relativePath === at(name));
      let fileName = wanted;
      let replaced = false;
      if (taken(wanted)) {
        if (conflict === "replace") {
          mutate((st) => {
            st.nodes = st.nodes.filter((n) => n.inTrash || n.relativePath !== at(wanted));
          });
          replaced = true;
        } else {
          const dot = wanted.lastIndexOf(".");
          const base = dot > 0 ? wanted.slice(0, dot) : wanted;
          const ext = dot > 0 ? wanted.slice(dot) : "";
          for (let n = 1; taken(fileName); n++) fileName = `${base} (${n})${ext}`;
        }
      }
      const relativePath = at(fileName);
      const ext = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
      const isImage = ["jpg", "jpeg", "png", "gif", "webp"].includes(ext);
      const isVideo = ["mp4", "mov", "mkv", "webm", "avi"].includes(ext);
      const id = nextId("file");

      mutate((st) => {
        const contentIdentity = isImage
          ? { id: nextId("ci"), size: String(session.size), fastHash: nextId("hash"), thumbnail: { id: nextId("thumb"), cachePath: pickPhotoAsset(relativePath), width: 320, height: 320 }, preview: { id: nextId("preview"), cachePath: pickPhotoAsset(relativePath), width: 1920, height: 1080 }, videoCaches: [] }
          : isVideo
            ? { id: nextId("ci"), size: String(session.size), fastHash: nextId("hash"), thumbnail: null, preview: { id: nextId("preview"), cachePath: pickVideoAsset(relativePath), width: 1280, height: 720 }, videoCaches: [{ id: nextId("vc"), durationSeconds: 20 }] }
            : null;
        st.nodes.push({
          id, relativePath, name: fileName, type: "FILE",
          mimeType: session.mimeType || null, size: String(session.size),
          modifiedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), indexedAt: new Date().toISOString(),
          isVisible: true, sourceVersion: `${session.size}-${Date.now()}`, browserCompatible: isVideo ? true : null,
          healthStatus: "HEALTHY", healthError: null, inTrash: false,
          contentIdentityId: contentIdentity?.id ?? null, contentIdentity,
        });
        st.auditLogs.unshift({ id: nextId("audit"), userId: DEMO_OWNER_ID, action: "UPLOAD", details: { originalName: fileName, finalPath: relativePath, size: session.size, renamed: false }, timestamp: new Date().toISOString() });
      });
      return { success: true, path: relativePath, name: fileName, renamed: fileName !== wanted, replaced, nodeId: id, processing: false };
    }

    private _respondJson(status: number, data: unknown) {
      const text = JSON.stringify(data);
      Object.defineProperty(this, "readyState", { value: 4, configurable: true });
      Object.defineProperty(this, "status", { value: status, configurable: true });
      Object.defineProperty(this, "responseText", { value: text, configurable: true });
      Object.defineProperty(this, "response", { value: text, configurable: true });
      this.dispatchEvent(new Event("readystatechange"));
      this.dispatchEvent(new Event("load"));
      this.dispatchEvent(new Event("loadend"));
    }
  }

  window.XMLHttpRequest = DemoXHR as unknown as typeof XMLHttpRequest;
}
