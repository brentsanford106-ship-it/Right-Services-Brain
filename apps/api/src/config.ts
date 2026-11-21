import { z } from "zod";

const Bool = z.enum(["true", "false"]).transform((v) => v === "true");

const EnvSchema = z.object({
  APP_ENV: z.enum(["development", "test", "staging", "production"]),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1),
  CORS_ALLOWED_ORIGINS: z.string().default(""),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DEV_AUTH_ENABLED: Bool.default(false),
  OIDC_ISSUER: z.string().optional(),
  OIDC_AUDIENCE: z.string().optional(),
  OIDC_JWKS_URI: z.string().optional(),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),
});

export interface AppConfig {
  appEnv: "development" | "test" | "staging" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  corsOrigins: string[];
  logLevel: string;
  devAuthEnabled: boolean;
  oidc: { issuer: string; audience: string; jwksUri: string } | null;
  rateLimitPerMinute: number;
}

export class ConfigError extends Error {}

/**
 * Parses and validates configuration. Fails closed:
 *  - Development authentication can never be enabled in staging or production.
 *  - Staging/production require a real OIDC issuer over HTTPS and a TLS database connection.
 */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new ConfigError(`Invalid configuration: ${fields}`);
  }
  const e = parsed.data;
  const isDeployed = e.APP_ENV === "staging" || e.APP_ENV === "production";

  if (e.DEV_AUTH_ENABLED && isDeployed) {
    throw new ConfigError("DEV_AUTH_ENABLED must not be true in staging or production. Refusing to start.");
  }

  let oidc: AppConfig["oidc"] = null;
  if (e.OIDC_ISSUER || e.OIDC_AUDIENCE || e.OIDC_JWKS_URI) {
    if (!e.OIDC_ISSUER || !e.OIDC_AUDIENCE || !e.OIDC_JWKS_URI) {
      throw new ConfigError("OIDC_ISSUER, OIDC_AUDIENCE and OIDC_JWKS_URI must be set together");
    }
    if (!e.OIDC_ISSUER.startsWith("https://") || !e.OIDC_JWKS_URI.startsWith("https://")) {
      throw new ConfigError("OIDC issuer and JWKS URI must use https");
    }
    oidc = { issuer: e.OIDC_ISSUER, audience: e.OIDC_AUDIENCE, jwksUri: e.OIDC_JWKS_URI };
  }

  if (isDeployed) {
    if (!oidc) throw new ConfigError("A production identity provider (OIDC_*) is required in staging/production");
    if (!/sslmode=(require|verify-ca|verify-full)/.test(e.DATABASE_URL)) {
      throw new ConfigError("DATABASE_URL must require TLS (sslmode=verify-full recommended) in staging/production");
    }
  }

  return {
    appEnv: e.APP_ENV,
    host: e.API_HOST,
    port: e.API_PORT,
    databaseUrl: e.DATABASE_URL,
    corsOrigins: e.CORS_ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    logLevel: e.LOG_LEVEL,
    devAuthEnabled: e.DEV_AUTH_ENABLED,
    oidc,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
  };
}
