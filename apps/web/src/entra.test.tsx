import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { base64Url, challengeFor, completeSignIn, entraConfig } from "./lib/entra";

describe("real sign-in helpers", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("stays off unless all three settings are present and the authority is https", () => {
    expect(entraConfig({})).toBeNull();
    expect(entraConfig({ VITE_ENTRA_AUTHORITY: "http://x", VITE_ENTRA_CLIENT_ID: "c", VITE_ENTRA_API_SCOPE: "s" })).toBeNull();
    expect(entraConfig({ VITE_ENTRA_AUTHORITY: "https://t.ciamlogin.com/t/v2.0/", VITE_ENTRA_CLIENT_ID: "c", VITE_ENTRA_API_SCOPE: "s" })).toEqual({
      authority: "https://t.ciamlogin.com/t/v2.0",
      clientId: "c",
      apiScope: "s",
    });
  });

  it("makes the PKCE challenge as base64url(SHA-256(verifier)), matching an independent implementation", async () => {
    const verifier = "dBjftJeZ4CVP-mJ92K9oXlvbFahyuRDv0vWr-hy9mGg";
    expect(await challengeFor(verifier)).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(base64Url(new Uint8Array([251, 255]))).toBe("-_8");
  });

  it("does nothing on a normal page load", async () => {
    expect(await completeSignIn()).toBeNull();
  });
});
