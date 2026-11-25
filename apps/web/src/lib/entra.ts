/**
 * Real sign-in for the website with Microsoft Entra External ID (OpenID Connect, authorization code + PKCE).
 *
 * - The browser goes to Microsoft's sign-in page and comes back to /auth with a one-time code.
 * - The code is swapped for tokens using a secret made fresh for this sign-in (PKCE), so a stolen code is useless.
 * - Tokens are kept in memory only, never in localStorage. Reloading the page means signing in again,
 *   which is usually one click because Microsoft remembers the person in that browser.
 * - Only the one-time PKCE secret and a random "state" value sit in sessionStorage, for the few seconds
 *   between leaving for Microsoft and coming back. They are deleted on return.
 *
 * Configured by VITE_ENTRA_AUTHORITY, VITE_ENTRA_CLIENT_ID and VITE_ENTRA_API_SCOPE (not secret).
 */
export interface EntraConfig {
  authority: string;
  clientId: string;
  apiScope: string;
}

export function entraConfig(env: Record<string, unknown> = import.meta.env): EntraConfig | null {
  const authority = typeof env.VITE_ENTRA_AUTHORITY === "string" ? env.VITE_ENTRA_AUTHORITY.replace(/\/+$/, "") : "";
  const clientId = typeof env.VITE_ENTRA_CLIENT_ID === "string" ? env.VITE_ENTRA_CLIENT_ID : "";
  const apiScope = typeof env.VITE_ENTRA_API_SCOPE === "string" ? env.VITE_ENTRA_API_SCOPE : "";
  if (!authority.startsWith("https://") || !clientId || !apiScope) return null;
  return { authority, clientId, apiScope };
}

const PENDING_KEY = "rsb.entra.pending";
const redirectUri = () => `${window.location.origin}/auth`;
const scope = (c: EntraConfig) => ["openid", "profile", "offline_access", c.apiScope].join(" ");

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
}
let discovery: Discovery | null = null;
async function discover(c: EntraConfig): Promise<Discovery> {
  if (discovery) return discovery;
  const res = await fetch(`${c.authority}/.well-known/openid-configuration`, { credentials: "omit" });
  if (!res.ok) throw new Error("Couldn't reach Microsoft sign-in.");
  const d = (await res.json()) as Discovery;
  if (!d.authorization_endpoint?.startsWith("https://") || !d.token_endpoint?.startsWith("https://")) throw new Error("Microsoft sign-in is misconfigured.");
  discovery = d;
  return d;
}

export function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const random = (n = 32) => base64Url(crypto.getRandomValues(new Uint8Array(n)));
export async function challengeFor(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** Leaves the site for Microsoft's sign-in page. */
export async function startSignIn(): Promise<void> {
  const c = entraConfig();
  if (!c) throw new Error("Real sign-in isn't set up yet.");
  const d = await discover(c);
  const verifier = random(48);
  const state = random();
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ verifier, state }));
  const q = new URLSearchParams({
    client_id: c.clientId,
    response_type: "code",
    redirect_uri: redirectUri(),
    scope: scope(c),
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  window.location.assign(`${d.authorization_endpoint}?${q.toString()}`);
}

export interface EntraTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

async function tokenRequest(c: EntraConfig, body: Record<string, string>): Promise<EntraTokens> {
  const d = await discover(c);
  const res = await fetch(d.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, scope: scope(c), ...body }).toString(),
    credentials: "omit",
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !data.access_token) throw new Error(data.error === "invalid_grant" ? "Please sign in again." : "Sign-in failed.");
  return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
}

/**
 * Finishes sign-in when Microsoft sends the browser back to /auth. Returns null when this page load is
 * not a sign-in return. Always removes the code from the address bar.
 */
export async function completeSignIn(): Promise<EntraTokens | null> {
  const c = entraConfig();
  if (!c || window.location.pathname !== "/auth") return null;
  const params = new URLSearchParams(window.location.search);
  const raw = sessionStorage.getItem(PENDING_KEY);
  sessionStorage.removeItem(PENDING_KEY);
  window.history.replaceState(null, "", "/");
  if (params.get("error")) {
    if (params.get("error") === "access_denied") return null; // the person cancelled
    throw new Error("Microsoft sign-in didn't finish. Please try again.");
  }
  const code = params.get("code");
  const pending = raw ? (JSON.parse(raw) as { verifier: string; state: string }) : null;
  if (!code || !pending || params.get("state") !== pending.state) throw new Error("That sign-in link isn't valid any more. Please sign in again.");
  return tokenRequest(c, { grant_type: "authorization_code", code, redirect_uri: redirectUri(), code_verifier: pending.verifier });
}

export async function refreshTokens(refreshToken: string): Promise<EntraTokens> {
  const c = entraConfig();
  if (!c) throw new Error("Real sign-in isn't set up yet.");
  return tokenRequest(c, { grant_type: "refresh_token", refresh_token: refreshToken });
}
