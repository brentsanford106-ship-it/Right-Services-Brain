import { createRemoteJWKSet, jwtVerify } from "jose";
import type { TokenVerifier, VerifiedIdentity } from "./types.js";

/**
 * Verifies access tokens issued by the production identity provider
 * (Microsoft Entra External ID). Checks signature (via the provider's JWKS),
 * issuer, audience, expiry and not-before, with a small clock tolerance.
 * Only asymmetric algorithms are accepted.
 *
 * STATUS: implemented but not yet exercised against a real Entra tenant (Phase 2).
 */
export class OidcVerifier implements TokenVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly opts: { issuer: string; audience: string; jwksUri: string }) {
    this.jwks = createRemoteJWKSet(new URL(opts.jwksUri), { cooldownDuration: 30_000, timeoutDuration: 5_000 });
  }

  async verify(token: string): Promise<VerifiedIdentity | null> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.opts.issuer,
        audience: this.opts.audience,
        algorithms: ["RS256", "PS256", "ES256"],
        clockTolerance: 60,
        requiredClaims: ["sub", "exp", "iat"],
      });
      if (typeof payload.sub !== "string" || !payload.iss) return null;
      return { issuer: payload.iss, subject: payload.sub };
    } catch {
      return null;
    }
  }
}
