import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import { HttpError } from "../lib/errors.js";
import type { TokenVerifier, VerifiedIdentity } from "./types.js";

/**
 * Verifies access tokens issued by the production identity provider
 * (Microsoft Entra External ID). Checks signature (via the provider's JWKS),
 * issuer, audience, expiry and not-before, with a small clock tolerance.
 * Only asymmetric algorithms are accepted.
 *
 * If Microsoft's key list can't be fetched (network trouble), the request fails with a temporary
 * server error, NOT "signed out": the phone must never treat a hiccup as "your access was removed".
 *
 * STATUS: tested against a local stand-in provider (test/oidc-verifier.test.ts); not yet against a real Entra tenant.
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
      const email = typeof payload.email === "string" ? payload.email.trim() : undefined;
      const name = typeof payload.name === "string" ? payload.name : undefined;
      return { issuer: payload.iss, subject: payload.sub, ...(email ? { email } : {}), ...(name ? { name } : {}) };
    } catch (e) {
      if (e instanceof errors.JWKSTimeout || !(e instanceof errors.JOSEError)) {
        throw new HttpError("internal_error", "Sign-in service is unreachable. Please try again shortly.");
      }
      return null;
    }
  }
}
