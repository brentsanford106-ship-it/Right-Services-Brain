/** An identity proven by a verified token. Contains NO authorization data. */
export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  /**
   * Email address vouched for by the identity provider. Set ONLY by the production OIDC verifier, and only
   * used to match invites (see app.claim_invites). The Entra tenant allows email-verified local accounts only.
   */
  email?: string;
  /** Display name from the identity provider, if any. */
  name?: string;
}

export interface TokenVerifier {
  /** Returns the identity, or null if the token is invalid for this verifier. Never throws for bad tokens. */
  verify(token: string): Promise<VerifiedIdentity | null>;
}
