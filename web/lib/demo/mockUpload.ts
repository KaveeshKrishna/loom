/**
 * web/lib/demo/mockUpload.ts
 *
 * UploadContext.tsx uses XMLHttpRequest (not fetch) for `/api/upload`, so it
 * can listen to `xhr.upload.onprogress` for a real progress bar. This
 * patches XMLHttpRequest to intercept just that one endpoint: it parses the
 * FormData synchronously (fine — File.size is available without reading
 * the file), simulates progress events over ~1-2 seconds proportional to
 * the fabricated file's size, then appends a new fabricated FileNode to
 * the demo world and resolves like a real 200 response.
 *
 * Everything else (there is nothing else UploadContext calls via XHR) would
 * fall through to the real XMLHttpRequest, unaltered.
 */
import { mutate, nextId } from "./state";
import { DEMO_OWNER_ID } from "./types";
import { pickPhotoAsset, pickVideoAsset } from "./assets";

const RealXHR = typeof window !== "undefined" ? window.XMLHttpRequest : undefined;

export function installUploadShim(): void {
  if (!RealXHR) return;

  class DemoXHR extends RealXHR {
    private _isUpload = false;
    private _method = "GET";
    private _url = "";

    open(method: string, url: string | URL, ...rest: unknown[]) {
      this._method = method.toUpperCase();
      this._url = typeof url === "string" ? url : url.toString();
      this._isUpload = this._method === "POST" && this._url.includes("/api/upload") && !this._url.includes("/api/upload/cleanup");
      if (!this._isUpload) {
        // @ts-expect-error - forwarding varargs to the native implementation
        return super.open(method, url, ...rest);
      }
      // Don't actually open a real connection for the fake upload.
    }

    send(body?: Document | XMLHttpRequestBodyInit | null) {
      if (!this._isUpload) return super.send(body);

      const formData = body as FormData;
      const file = formData.get("file") as File | null;
      const destDir = (formData.get("destDir") as string | null) ?? "";
      const relativePathField = formData.get("relativePath") as string | null;

      if (!file) {
        this._respondError(400, "Missing required fields: file, destDir");
        return;
      }

      const fileName = relativePathField ? relativePathField.split("/").pop()! : file.name;
      const steps = 12;
      let step = 0;
      const timer = setInterval(() => {
        step += 1;
        const loaded = Math.round((file.size * step) / steps);
        this._fireProgress(loaded, file.size);
        if (step >= steps) {
          clearInterval(timer);
          this._finish(file, fileName, destDir);
        }
      }, 90);
    }

    private _fireProgress(loaded: number, total: number) {
      const ev = new ProgressEvent("progress", { lengthComputable: true, loaded, total });
      this.upload?.dispatchEvent(ev);
      // @ts-expect-error - onprogress is assigned directly by callers, not always via addEventListener
      this.upload?.onprogress?.(ev);
    }

    private _finish(file: File, fileName: string, destDir: string) {
      const ext = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
      const isImage = ["jpg", "jpeg", "png", "gif", "webp"].includes(ext);
      const isVideo = ["mp4", "mov", "mkv", "webm", "avi"].includes(ext);
      const relativePath = destDir ? `${destDir}/${fileName}` : fileName;

      mutate((st) => {
        const id = nextId("file");
        const contentIdentity = isImage
          ? { id: nextId("ci"), size: String(file.size), fastHash: nextId("hash"), thumbnail: { id: nextId("thumb"), cachePath: pickPhotoAsset(relativePath), width: 320, height: 320 }, preview: { id: nextId("preview"), cachePath: pickPhotoAsset(relativePath), width: 1920, height: 1080 }, videoCaches: [] }
          : isVideo
            ? { id: nextId("ci"), size: String(file.size), fastHash: nextId("hash"), thumbnail: null, preview: { id: nextId("preview"), cachePath: pickVideoAsset(relativePath), width: 1280, height: 720 }, videoCaches: [{ id: nextId("vc"), durationSeconds: 20 }] }
            : null;

        st.nodes.push({
          id, relativePath, name: fileName, type: "FILE",
          mimeType: file.type || null, size: String(file.size),
          modifiedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), indexedAt: new Date().toISOString(),
          isVisible: true, sourceVersion: `${file.size}-${Date.now()}`, browserCompatible: isVideo ? true : null,
          healthStatus: "HEALTHY", healthError: null, inTrash: false,
          contentIdentityId: contentIdentity?.id ?? null, contentIdentity,
        });
        st.auditLogs.unshift({ id: nextId("audit"), userId: DEMO_OWNER_ID, action: "UPLOAD", details: { originalName: fileName, finalPath: relativePath, size: file.size, renamed: false }, timestamp: new Date().toISOString() });
      });

      this._respondJson(200, { success: true, path: relativePath, name: fileName, renamed: false });
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

    private _respondError(status: number, message: string) {
      this._respondJson(status, { error: message });
    }
  }

  window.XMLHttpRequest = DemoXHR as unknown as typeof XMLHttpRequest;
}
