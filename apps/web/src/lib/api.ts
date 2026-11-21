import { ApiError } from "@rsb/contracts";

export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:4000";

/**
 * The access token is kept in memory only (never localStorage), so it is not
 * readable by other tabs or persisted on shared computers. Reloading the page
 * signs the user out. Production sign-in (Entra External ID) will manage tokens
 * with its own secure cache.
 */
let accessToken: string | null = null;
/** DEVELOPMENT ONLY: which test person is signed in, so an expired 15-minute token can be renewed. */
let devSubject: string | null = null;
const listeners = new Set<() => void>();
export const session = {
  get token() {
    return accessToken;
  },
  set(token: string | null, subject: string | null = null) {
    accessToken = token;
    devSubject = token ? subject : null;
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

async function renewDevToken(): Promise<boolean> {
  if (!devSubject) return false;
  const res = await fetch(`${API_BASE}/dev/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject: devSubject }),
    credentials: "omit",
  }).catch(() => null);
  if (!res?.ok) return false;
  accessToken = ((await res.json()) as { accessToken: string }).accessToken;
  return true;
}

async function send(path: string, init: { method?: string; body?: unknown }, retried = false): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : null,
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (res.status === 401 && !retried && (await renewDevToken())) return send(path, init, true);
  return res;
}

export async function api<T>(path: string, init: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown } = {}): Promise<T> {
  const res = await send(path, init);
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = ApiError.safeParse(data);
    if (res.status === 401) session.set(null);
    if (parsed.success) throw new ApiRequestError(res.status, parsed.data.error.code, parsed.data.error.message, parsed.data.error.requestId);
    throw new ApiRequestError(res.status, "internal_error", "Unexpected response from server.");
  }
  return data as T;
}

/**
 * Downloads an image with the access token and returns a temporary in-page URL for it.
 * Photo links are never shareable: every download needs the signed-in person's token.
 */
export async function fetchImage(path: string): Promise<string> {
  const res = await send(path, {});
  if (!res.ok) throw new ApiRequestError(res.status, "image_error", "Image could not be loaded.");
  return URL.createObjectURL(await res.blob());
}
