/** Typed HTTP errors, turned into JSON responses by route() in lib/http.ts. */

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: Record<string, unknown>
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const forbidden = (msg = "Access denied") => new HttpError(403, msg);
export const notFound = (msg = "Not found") => new HttpError(404, msg);
export const conflict = (msg: string, extra?: Record<string, unknown>) =>
  new HttpError(409, msg, extra);
