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
  STORAGE_DRIVER: z.enum(["local", "azure_blob"]).default("local"),
  LOCAL_STORAGE_DIR: z.string().default(".data/object-store"),
  /** e.g. https://<account>.blob.core.windows.net (azure_blob only). No key: the server uses its managed identity. */
  AZURE_STORAGE_ACCOUNT_URL: z.string().optional(),
  AZURE_STORAGE_CONTAINER: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/).default("photos"),
  /** Receipts, vehicles, mileage and member admin are Phase 2. Off unless explicitly enabled. */
  PHASE2_FEATURES: Bool.default(false),
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
  storage: { driver: "local"; dir: string } | { driver: "azure_blob"; accountUrl: string; container: string };
  phase2Features: boolean;
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

  if (e.STORAGE_DRIVER === "azure_blob" && !/^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net\/?$/.test(e.AZURE_STORAGE_ACCOUNT_URL ?? "")) {
    throw new ConfigError("AZURE_STORAGE_ACCOUNT_URL must look like https://<account>.blob.core.windows.net");
  }

  if (isDeployed) {
    if (!oidc) throw new ConfigError("A production identity provider (OIDC_*) is required in staging/production");
    if (e.STORAGE_DRIVER === "local") {
      throw new ConfigError("Local disk storage is for development only; staging/production must use azure_blob");
    }
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
    storage:
      e.STORAGE_DRIVER === "local"
        ? { driver: "local", dir: e.LOCAL_STORAGE_DIR }
        : { driver: "azure_blob", accountUrl: e.AZURE_STORAGE_ACCOUNT_URL!.replace(/\/$/, ""), container: e.AZURE_STORAGE_CONTAINER },
    phase2Features: e.PHASE2_FEATURES,
  };
}
