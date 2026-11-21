/** An identity proven by a verified token. Contains NO authorization data. */
export interface VerifiedIdentity {
  issuer: string;
  subject: string;
}

export interface TokenVerifier {
  /** Returns the identity, or null if the token is invalid for this verifier. Never throws for bad tokens. */
  verify(token: string): Promise<VerifiedIdentity | null>;
}
