import { generateKeyPair, jwtVerify, SignJWT, type CryptoKey } from "jose";
import { DEV_AUTH_AUDIENCE, DEV_AUTH_ISSUER } from "@rsb/contracts";
import type { TokenVerifier, VerifiedIdentity } from "./types.js";

/**
 * DEVELOPMENT-ONLY AUTHENTICATION. NOT SECURE FOR PRODUCTION.
 *
 * Anyone who can reach the dev login endpoint can sign in as any seeded
 * synthetic user. It exists so the apps can be exercised before the real
 * identity provider is connected. Safeguards:
 *  - Only constructed when config.devAuthEnabled (impossible in staging/production; see config.ts).
 *  - Uses a fresh in-memory ES256 key per process; tokens die with the process.
 *  - Uses its own issuer, which production users never have.
 *  - Tokens expire after 15 minutes.
 */
export class DevAuth implements TokenVerifier {
  static readonly TTL_SECONDS = 15 * 60;

  private constructor(
    private readonly privateKey: CryptoKey,
    private readonly publicKey: CryptoKey,
  ) {}

  static async create(): Promise<DevAuth> {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    return new DevAuth(privateKey, publicKey);
  }

  /** ttlSeconds is configurable only so tests can mint expired tokens. */
  async issue(subject: string, ttlSeconds: number = DevAuth.TTL_SECONDS): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "ES256", typ: "JWT" })
      .setIssuer(DEV_AUTH_ISSUER)
      .setAudience(DEV_AUTH_AUDIENCE)
      .setSubject(subject)
      .setIssuedAt(now)
      .setExpirationTime(now + ttlSeconds)
      .sign(this.privateKey);
  }

  async verify(token: string): Promise<VerifiedIdentity | null> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        issuer: DEV_AUTH_ISSUER,
        audience: DEV_AUTH_AUDIENCE,
        algorithms: ["ES256"],
        requiredClaims: ["sub", "exp"],
      });
      return typeof payload.sub === "string" ? { issuer: DEV_AUTH_ISSUER, subject: payload.sub } : null;
    } catch {
      return null;
    }
  }
}
