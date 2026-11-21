import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import * as SecureStore from "expo-secure-store";

/**
 * Real sign-in with Microsoft Entra External ID (OpenID Connect, authorization code + PKCE).
 *
 * - Microsoft's own sign-in page opens in the system browser sheet; the app never sees a password or code.
 * - The refresh token is kept in the iOS Keychain (this device only). Access tokens live in memory only.
 * - No secrets are in the app: it is a "public client"; PKCE protects the code exchange.
 *
 * Configured with three EXPO_PUBLIC_ values (not secret; they identify the app, like a username):
 *   EXPO_PUBLIC_ENTRA_AUTHORITY  e.g. https://<tenant-subdomain>.ciamlogin.com/<tenant-id>/v2.0
 *   EXPO_PUBLIC_ENTRA_CLIENT_ID  the phone app's "Application (client) ID"
 *   EXPO_PUBLIC_ENTRA_API_SCOPE  e.g. api://<server-app-client-id>/access_as_user
 * When they are missing, the app shows only the development sign-in.
 */
WebBrowser.maybeCompleteAuthSession();

const REFRESH_KEY = "rsb.entra.refresh.v1";
const OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export interface EntraConfig {
  authority: string;
  clientId: string;
  apiScope: string;
}

export function entraConfig(): EntraConfig | null {
  const authority = process.env.EXPO_PUBLIC_ENTRA_AUTHORITY?.replace(/\/+$/, "");
  const clientId = process.env.EXPO_PUBLIC_ENTRA_CLIENT_ID;
  const apiScope = process.env.EXPO_PUBLIC_ENTRA_API_SCOPE;
  if (!authority || !clientId || !apiScope || !authority.startsWith("https://")) return null;
  return { authority, clientId, apiScope };
}

/** The address Microsoft sends the person back to. In Expo Go it looks like exp://<pc-address>:8081/--/auth. */
export const redirectUri = () => AuthSession.makeRedirectUri({ path: "auth" });

const scopes = (c: EntraConfig) => ["openid", "profile", "offline_access", c.apiScope];

let discovery: AuthSession.DiscoveryDocument | null = null;
async function discover(c: EntraConfig) {
  discovery ??= await AuthSession.fetchDiscoveryAsync(c.authority);
  return discovery;
}

export interface EntraTokens {
  accessToken: string;
  expiresAt: number;
  /** Stable id of the person at Microsoft ("sub" claim). */
  subject: string;
  name: string | null;
}

function claims(jwt: string | undefined): Record<string, unknown> {
  if (!jwt) return {};
  try {
    const part = jwt.split(".")[1] ?? "";
    const json = decodeURIComponent(
      Array.from(globalThis.atob(part.replace(/-/g, "+").replace(/_/g, "/")), (ch) => "%" + ch.charCodeAt(0).toString(16).padStart(2, "0")).join(""),
    );
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toTokens(r: AuthSession.TokenResponse): EntraTokens {
  const id = claims(r.idToken);
  const access = claims(r.accessToken);
  const subject = String(access.sub ?? id.sub ?? "");
  if (!subject) throw new Error("Sign-in did not return who you are.");
  return {
    accessToken: r.accessToken,
    expiresAt: Date.now() + (r.expiresIn ?? 3600) * 1000,
    subject,
    name: typeof id.name === "string" ? id.name : null,
  };
}

/** Opens Microsoft's sign-in page. Returns null if the person cancelled. */
export async function signInInteractive(): Promise<EntraTokens | null> {
  const c = entraConfig();
  if (!c) throw new Error("Real sign-in isn't set up yet.");
  const disc = await discover(c);
  const request = new AuthSession.AuthRequest({
    clientId: c.clientId,
    scopes: scopes(c),
    redirectUri: redirectUri(),
    usePKCE: true,
    responseType: AuthSession.ResponseType.Code,
    prompt: AuthSession.Prompt.SelectAccount,
  });
  const result = await request.promptAsync(disc);
  if (result.type === "cancel" || result.type === "dismiss") return null;
  if (result.type !== "success") throw new Error(result.type === "error" ? (result.error?.message ?? "Sign-in failed.") : "Sign-in failed.");
  const tokens = await AuthSession.exchangeCodeAsync(
    { clientId: c.clientId, code: result.params.code!, redirectUri: redirectUri(), extraParams: { code_verifier: request.codeVerifier! } },
    disc,
  );
  if (tokens.refreshToken) await SecureStore.setItemAsync(REFRESH_KEY, tokens.refreshToken, OPTS);
  return toTokens(tokens);
}

export class SignInExpired extends Error {}

/** Gets a fresh access token silently using the saved refresh token. Throws SignInExpired if the person must sign in again. */
export async function refresh(): Promise<EntraTokens> {
  const c = entraConfig();
  const saved = await SecureStore.getItemAsync(REFRESH_KEY, OPTS);
  if (!c || !saved) throw new SignInExpired("Please sign in again.");
  const disc = await discover(c);
  let r: AuthSession.TokenResponse;
  try {
    r = await AuthSession.refreshAsync({ clientId: c.clientId, refreshToken: saved, scopes: scopes(c) }, disc);
  } catch (e) {
    // invalid_grant = revoked, expired or the account was removed at Microsoft.
    if (e instanceof AuthSession.TokenError || /invalid_grant/.test(String(e))) throw new SignInExpired("Please sign in again.");
    throw e; // network trouble: try again later
  }
  if (r.refreshToken) await SecureStore.setItemAsync(REFRESH_KEY, r.refreshToken, OPTS);
  return toTokens(r);
}

export async function forget(): Promise<void> {
  await SecureStore.deleteItemAsync(REFRESH_KEY, OPTS);
}
