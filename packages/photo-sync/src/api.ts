import type { Stage } from "./queue";

/** The server answered with an error. */
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly requestId?: string) {
    super(message);
    this.name = "ApiError";
  }
}

/** The request never got an answer (no signal, airplane mode, server unreachable, timeout). */
export class NetworkError extends Error {
  constructor(message = "No connection to the server.") {
    super(message);
    this.name = "NetworkError";
  }
}

export interface ServerPhoto {
  id: string;
  jobId: string;
  jobNumber: string;
  stage: Stage | "issue" | "other";
  note: string | null;
  flagged: boolean;
  capturedAt: string;
  uploadStatus: "pending" | "stored" | "rejected";
}

export interface CreatePhotoBody {
  clientRef: string;
  stage: Stage;
  note?: string;
  flagged: boolean;
  capturedAt: string;
  contentType: "image/jpeg";
  latitude?: number;
  longitude?: number;
  locationAccuracyM?: number;
  /** Left out for photos from the app's camera. */
  captureSource?: "imported";
  capturedAtKnown?: boolean;
}

export interface PhotoApi {
  createPhoto(orgId: string, jobId: string, body: CreatePhotoBody): Promise<ServerPhoto>;
  uploadContent(orgId: string, photoId: string, bytes: Uint8Array, contentType: string): Promise<{ uploadStatus: string; duplicate: boolean }>;
  updatePhoto(orgId: string, photoId: string, body: { flagged?: boolean; note?: string | null; stage?: Stage }): Promise<ServerPhoto>;
  /** Sends one waiting comment (see CommentOutbox). Optional so older test doubles keep working. */
  createComment?(orgId: string, photoId: string, body: { clientRef: string; body: string; parentId?: string | null; mentionIds: string[]; markupId?: string | null }): Promise<{ id: string }>;
  /** Sends one waiting drawing or issue change (see ActionOutbox). Optional so older test doubles keep working. */
  post?<T>(path: string, body: unknown): Promise<T>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal }) => Promise<{
  status: number;
  ok: boolean;
  text(): Promise<string>;
}>;

export interface HttpClientOptions {
  baseUrl: string;
  /** Returns a current access token, or null if the person must sign in again. */
  getToken: () => Promise<string | null>;
  fetch: FetchLike;
  timeoutMs?: number;
  /** Time limit for sending one photo file (default 10 minutes). */
  uploadTimeoutMs?: number;
  /**
   * Optional platform override for sending image bytes (the phone streams from a file).
   * Must behave like `fetch` with a PUT and raw body.
   */
  putBytes?: (url: string, headers: Record<string, string>, bytes: Uint8Array) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;
}

/** Small JSON client for the Right Services API. Every request carries the access token; there are no shareable links. */
export class HttpClient implements PhotoApi {
  constructor(private readonly o: HttpClientOptions) {}

  private async token(): Promise<string> {
    const t = await this.o.getToken();
    if (!t) throw new ApiError(401, "unauthenticated", "Please sign in again.");
    return t;
  }

  private async handle<T>(res: { status: number; ok: boolean; text(): Promise<string> }): Promise<T> {
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new NetworkError("The connection dropped while the server was answering.");
    }
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        // Our server always answers in JSON. A web page instead means something in between answered: a Wi-Fi
        // sign-in page (hotel, job-site hotspot), or Azure's own error page while the server restarts. Treat it as
        // "no connection" so photos are retried later, never as a real refusal.
        throw new NetworkError(res.status >= 500 ? `The server is not available right now (${res.status}).` : "Got an unexpected answer. The Wi-Fi may need you to sign in.");
      }
    }
    if (res.ok) return body as T;
    const err = (body as { error?: { code?: string; message?: string; requestId?: string } } | null)?.error;
    // An error without our server's error shape (for example an empty 404 from a proxy) is not a real answer either.
    if (!err?.code || !err.requestId) {
      if (res.status === 401) throw new ApiError(401, "unauthenticated", "Please sign in again.");
      throw new NetworkError(`The server did not answer properly (${res.status}). Will retry.`);
    }
    throw new ApiError(res.status, err.code, err.message ?? `Request failed (${res.status}).`, err.requestId);
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${await this.token()}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 30_000);
    let res;
    try {
      res = await this.o.fetch(`${this.o.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new NetworkError(e instanceof Error && e.name === "AbortError" ? "The server took too long to answer." : undefined);
    } finally {
      clearTimeout(timer);
    }
    return this.handle<T>(res);
  }

  get<T>(path: string): Promise<T> {
    return this.send<T>("GET", path);
  }
  post<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>("POST", path, body);
  }
  patch<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>("PATCH", path, body);
  }
  delete<T = null>(path: string): Promise<T> {
    return this.send<T>("DELETE", path);
  }
  /** Base address of the server, for platform code that downloads files itself (e.g. to share a photo). */
  get baseUrl(): string {
    return this.o.baseUrl;
  }
  /** Current access token, for platform downloads that must carry it. */
  accessToken(): Promise<string> {
    return this.token();
  }

  createPhoto(orgId: string, jobId: string, body: CreatePhotoBody): Promise<ServerPhoto> {
    return this.post(`/v1/orgs/${orgId}/jobs/${jobId}/photos`, body);
  }

  updatePhoto(orgId: string, photoId: string, body: { flagged?: boolean; note?: string | null; stage?: Stage }): Promise<ServerPhoto> {
    return this.patch(`/v1/orgs/${orgId}/photos/${photoId}`, body);
  }

  createComment(orgId: string, photoId: string, body: { clientRef: string; body: string; parentId?: string | null; mentionIds: string[]; markupId?: string | null }): Promise<{ id: string }> {
    return this.post(`/v1/orgs/${orgId}/photos/${photoId}/comments`, body);
  }

  async uploadContent(orgId: string, photoId: string, bytes: Uint8Array, contentType: string) {
    return this.putRaw<{ uploadStatus: string; duplicate: boolean }>(`/v1/orgs/${orgId}/photos/${photoId}/content`, bytes, contentType);
  }

  /** Sends a file as the raw request body (photo files, profile pictures). */
  async putRaw<T>(path: string, bytes: Uint8Array, contentType: string): Promise<T> {
    const url = `${this.o.baseUrl}${path}`;
    const headers = { authorization: `Bearer ${await this.token()}`, "content-type": contentType };
    let res;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A very weak signal can leave an upload hanging for a long time, which would hold up every photo behind it.
    // After the time limit, give up on this try and retry later. Safe: sending the same file again is accepted.
    const limit = this.o.uploadTimeoutMs ?? 10 * 60_000;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new NetworkError("The upload took too long. Will retry.")), limit);
    });
    try {
      const send = this.o.putBytes
        ? this.o.putBytes(url, headers, bytes)
        : this.o.fetch(url, { method: "PUT", headers, body: bytes });
      send.catch(() => undefined); // if it fails after the time limit, nobody is waiting for it
      res = await Promise.race([send, timeout]);
    } catch (e) {
      throw e instanceof NetworkError ? e : new NetworkError();
    } finally {
      clearTimeout(timer);
    }
    return this.handle<T>(res);
  }
}
