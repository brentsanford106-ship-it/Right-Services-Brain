import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const base = { DATABASE_URL: "postgres://u:p@localhost/db" };
const oidc = {
  OIDC_ISSUER: "https://example.ciamlogin.com/tenant/v2.0",
  OIDC_AUDIENCE: "api://rsb",
  OIDC_JWKS_URI: "https://example.ciamlogin.com/tenant/discovery/v2.0/keys",
};

describe("configuration safety", () => {
  it.each(["staging", "production"])("refuses to start with dev auth enabled in %s", (env) => {
    expect(() =>
      loadConfig({ ...base, ...oidc, DATABASE_URL: "postgres://u:p@h/db?sslmode=verify-full", APP_ENV: env, DEV_AUTH_ENABLED: "true" }),
    ).toThrow(ConfigError);
  });

  it("requires a real identity provider in production", () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: "postgres://u:p@h/db?sslmode=verify-full", APP_ENV: "production" })).toThrow(/identity provider/);
  });

  it("requires TLS to the database in production", () => {
    expect(() => loadConfig({ ...base, ...oidc, APP_ENV: "production" })).toThrow(/TLS/);
  });

  it("requires https for the identity provider", () => {
    expect(() => loadConfig({ ...base, APP_ENV: "development", OIDC_ISSUER: "http://x", OIDC_AUDIENCE: "a", OIDC_JWKS_URI: "http://x/keys" })).toThrow(/https/);
  });

  it("accepts a valid production configuration with dev auth off", () => {
    const c = loadConfig({ ...base, ...oidc, DATABASE_URL: "postgres://u:p@h/db?sslmode=verify-full", APP_ENV: "production" });
    expect(c.devAuthEnabled).toBe(false);
  });

  it("dev auth defaults to off", () => {
    expect(loadConfig({ ...base, APP_ENV: "development" }).devAuthEnabled).toBe(false);
  });

  it("does not echo configuration values in errors", () => {
    try {
      loadConfig({ APP_ENV: "nonsense", DATABASE_URL: "postgres://secret-user:secret-pass@h/db" });
    } catch (e) {
      expect(String(e)).not.toContain("secret");
    }
  });
});
