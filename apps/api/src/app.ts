import { randomUUID } from "node:crypto";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { AppConfig } from "./config.js";
import { assertRestrictedLogin, type Database } from "./lib/db.js";
import { HttpError } from "./lib/errors.js";
import type { TokenVerifier, VerifiedIdentity } from "./auth/types.js";
import { DevAuth } from "./auth/dev.js";
import { OidcVerifier } from "./auth/oidc.js";
import { registerRoutes } from "./routes/index.js";
import type { ObjectStorage } from "./storage/types.js";
import { LocalDiskStorage } from "./storage/localDisk.js";
import { azureBlobFromIdentity } from "./storage/azureBlob.js";
import { startPurgeSchedule } from "./lib/purge.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set only after a token is verified AND mapped to an active user. */
    principal: { userId: string } | null;
    /** The verified identity behind `principal` (used to accept new invites). */
    identity: VerifiedIdentity | null;
  }
}

export interface AppDeps {
  config: AppConfig;
  db: Database;
  /** Optional overrides (tests). */
  verifiers?: TokenVerifier[];
  devAuth?: DevAuth | null;
  logStream?: NodeJS.WritableStream;
  storage?: ObjectStorage;
}

/** Headers and fields that must never reach logs. */
export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
];

/**
 * The caller's address, for the rate limit. In Azure, App Service's front end adds the real address to the END of
 * X-Forwarded-For (as "address:port"); anything before it was typed by the caller and can't be trusted, so it is
 * ignored. Without this, someone could dodge the limit by sending a made-up X-Forwarded-For on every request.
 */
export function clientAddress(headers: Record<string, string | string[] | undefined>, socketAddress: string | undefined, behindProxy: boolean): string {
  const xff = headers["x-forwarded-for"];
  const raw = behindProxy ? (Array.isArray(xff) ? xff.join(",") : xff) : undefined;
  const last = raw?.split(",").map((s) => s.trim()).filter(Boolean).pop();
  if (!last) return socketAddress ?? "unknown";
  const bracketed = /^\[([0-9a-fA-F:.]+)\](?::\d+)?$/.exec(last); // [IPv6]:port
  if (bracketed) return bracketed[1]!;
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(last); // IPv4 or IPv4:port
  if (v4) return v4[1]!;
  return last;
}

const PG_ERROR_MAP: Record<string, HttpError> = {
  "23505": new HttpError("conflict"),
  "23503": new HttpError("validation_failed", "A referenced record does not exist."),
  "23514": new HttpError("validation_failed", "A value is out of the allowed range."),
  "22P02": new HttpError("validation_failed"),
  "22001": new HttpError("validation_failed", "A value is too long."),
};

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db } = deps;
  // The company walls depend on the API's database login being the restricted one. Check before serving anything.
  await assertRestrictedLogin(db.pool);

  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: { paths: LOG_REDACT_PATHS, censor: "[REDACTED]" },
      serializers: {
        // Log method + path only. Query strings and bodies may contain personal data.
        req: (req: { method: string; url: string }) => ({ method: req.method, path: req.url.split("?")[0] }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      ...(deps.logStream ? { stream: deps.logStream } : {}),
    },
    genReqId: () => randomUUID(),
    requestIdHeader: false, // never trust a client-supplied request id
    bodyLimit: 64 * 1024, // JSON only; photo uploads have their own route and limit
    // Not trusted: X-Forwarded-For's first entries come from the caller. The rate limit reads the address itself (clientAddress).
    trustProxy: false,
  });
  const behindProxy = config.appEnv === "staging" || config.appEnv === "production";

  app.decorateRequest("principal", null);
  app.decorateRequest("identity", null);

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    hsts: config.appEnv === "production" || config.appEnv === "staging" ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: false,
    methods: ["GET", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["Authorization", "Content-Type"],
    maxAge: 600,
  });
  await app.register(rateLimit, {
    max: config.rateLimitPerMinute,
    timeWindow: "1 minute",
    keyGenerator: (req) => clientAddress(req.headers, req.socket.remoteAddress, behindProxy),
    errorResponseBuilder: (_req, ctx) => {
      const err = new HttpError("rate_limited");
      (err as unknown as { retryAfter: string }).retryAfter = ctx.after;
      return err;
    },
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
  });

  // ---------------------------------------------------------------- authentication
  const devAuth = deps.devAuth !== undefined ? deps.devAuth : config.devAuthEnabled ? await DevAuth.create() : null;
  if (devAuth && !config.devAuthEnabled) throw new Error("DevAuth supplied while dev auth is disabled");
  const verifiers: TokenVerifier[] = deps.verifiers ?? [
    ...(config.oidc ? [new OidcVerifier(config.oidc)] : []),
    ...(devAuth ? [devAuth] : []),
  ];

  app.addHook("onRequest", async (req) => {
    const header = req.headers.authorization;
    if (!header) return;
    const match = /^Bearer ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$/.exec(header);
    if (!match?.[1]) throw new HttpError("unauthenticated", "Invalid authorization header.");
    const token = match[1];
    for (const v of verifiers) {
      const identity = await v.verify(token);
      if (!identity) continue;
      const userId = await db.anonymous(async (tx) => {
        const { rows } = await tx.query<{ id: string | null }>("SELECT app.resolve_principal($1, $2) AS id", [
          identity.issuer,
          identity.subject,
        ]);
        if (rows[0]?.id) return rows[0].id;
        // First real sign-in: link the person to any open invite for their verified email.
        if (!identity.email) return null;
        const { rows: claimed } = await tx.query<{ id: string | null }>("SELECT app.claim_invites($1, $2, $3, $4) AS id", [
          identity.issuer,
          identity.subject,
          identity.email,
          identity.name ?? null,
        ]);
        return claimed[0]?.id ?? null;
      });
      if (!userId) {
        throw new HttpError(
          "unauthenticated",
          identity.email ? "You haven't been added to a company yet. Ask an owner to add your email address." : "Your account is not active.",
        );
      }
      req.principal = { userId };
      req.identity = identity;
      return;
    }
    throw new HttpError("unauthenticated", "Your session is invalid or has expired.");
  });

  // ---------------------------------------------------------------- errors
  app.setErrorHandler((err: FastifyError & { code?: string; retryAfter?: string }, req, reply) => {
    let httpErr: HttpError;
    if (err instanceof HttpError) {
      httpErr = err;
    } else if (typeof err.code === "string" && PG_ERROR_MAP[err.code]) {
      httpErr = PG_ERROR_MAP[err.code]!;
      // Postgres messages and details can echo submitted values; log the SQLSTATE only.
      req.log.warn({ sqlstate: err.code }, "database constraint rejected request");
    } else if (err.statusCode === 413 || err.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      httpErr = new HttpError("payload_too_large");
    } else if (err.statusCode === 415 || err.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      httpErr = new HttpError("validation_failed", "Content-Type must be application/json.");
    } else if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      httpErr = new HttpError("validation_failed");
    } else {
      // Unexpected: log enough to debug without logging data. pg errors carry SQLSTATE codes.
      req.log.error(
        { errName: err.name, sqlstate: typeof err.code === "string" && /^[0-9A-Z]{5}$/.test(err.code) ? err.code : undefined, stack: err.code && /^[0-9A-Z]{5}$/.test(err.code) ? undefined : err.stack },
        "unhandled error",
      );
      httpErr = new HttpError("internal_error");
    }
    if (httpErr.code === "rate_limited" && err.retryAfter) reply.header("retry-after", err.retryAfter);
    void reply.status(httpErr.status).send({
      error: {
        code: httpErr.code,
        message: httpErr.message,
        requestId: req.id,
        ...(httpErr.details ? { details: httpErr.details } : {}),
      },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({ error: { code: "not_found", message: "Not found.", requestId: req.id } });
  });

  let storage: ObjectStorage;
  if (deps.storage) storage = deps.storage;
  else if (config.storage.driver === "local") storage = new LocalDiskStorage(config.storage.dir);
  else storage = await azureBlobFromIdentity(config.storage.accountUrl, config.storage.container);

  await registerRoutes(app, { db, config, devAuth, storage });

  // Scheduled clean-up of Recently Deleted (not in tests, which call purgeExpiredPhotos directly).
  if (config.appEnv !== "test") {
    const stop = startPurgeSchedule(db, storage, app.log);
    app.addHook("onClose", async () => stop());
  }
  return app;
}
