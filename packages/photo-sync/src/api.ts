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
}

export interface PhotoApi {
  createPhoto(orgId: string, jobId: string, body: CreatePhotoBody): Promise<ServerPhoto>;
  uploadContent(orgId: string, photoId: string, bytes: Uint8Array, contentType: string): Promise<{ uploadStatus: string; duplicate: boolean }>;
  updatePhoto(orgId: string, photoId: string, body: { flagged?: boolean; note?: string | null; stage?: Stage }): Promise<ServerPhoto>;
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
    const text = await res.text();
    const body = text ? (JSON.parse(text) as unknown) : null;
    if (res.ok) return body as T;
    const err = (body as { error?: { code?: string; message?: string; requestId?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? "error", err?.message ?? `Request failed (${res.status}).`, err?.requestId);
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

  createPhoto(orgId: string, jobId: string, body: CreatePhotoBody): Promise<ServerPhoto> {
    return this.post(`/v1/orgs/${orgId}/jobs/${jobId}/photos`, body);
  }

  updatePhoto(orgId: string, photoId: string, body: { flagged?: boolean; note?: string | null; stage?: Stage }): Promise<ServerPhoto> {
    return this.patch(`/v1/orgs/${orgId}/photos/${photoId}`, body);
  }

  async uploadContent(orgId: string, photoId: string, bytes: Uint8Array, contentType: string) {
    const url = `${this.o.baseUrl}/v1/orgs/${orgId}/photos/${photoId}/content`;
    const headers = { authorization: `Bearer ${await this.token()}`, "content-type": contentType };
    let res;
    try {
      res = this.o.putBytes
        ? await this.o.putBytes(url, headers, bytes)
        : await this.o.fetch(url, { method: "PUT", headers, body: bytes });
    } catch {
      throw new NetworkError();
    }
    return this.handle<{ uploadStatus: string; duplicate: boolean }>(res);
  }
}
