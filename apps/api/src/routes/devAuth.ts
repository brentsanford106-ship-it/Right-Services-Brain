import type { FastifyInstance } from "fastify";
import { DEV_AUTH_ISSUER, DevLoginRequest } from "@rsb/contracts";
import type { DevAuth } from "../auth/dev.js";
import { DEV_LOGIN_USERS } from "../auth/devUsers.js";
import type { Database } from "../lib/db.js";
import { HttpError } from "../lib/errors.js";
import { parse } from "../lib/validate.js";

/**
 * DEVELOPMENT-ONLY sign-in. Registered only when dev auth is enabled, which
 * config.ts makes impossible in staging/production. NOT SECURE.
 */
export async function devAuthRoutes(app: FastifyInstance, devAuth: DevAuth, db: Database): Promise<void> {
  const strict = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

  app.get("/dev/auth/users", strict, async () => ({
    warning: "DEVELOPMENT LOGIN — synthetic users only. Not production authentication.",
    items: DEV_LOGIN_USERS,
  }));

  app.post("/dev/auth/token", strict, async (req) => {
    const { subject } = parse(DevLoginRequest, req.body);
    const userId = await db.anonymous(async (tx) => {
      const { rows } = await tx.query<{ id: string | null }>("SELECT app.resolve_principal($1, $2) AS id", [DEV_AUTH_ISSUER, subject]);
      return rows[0]?.id ?? null;
    });
    if (!userId) throw new HttpError("unauthenticated", "That account is not active.");
    req.log.warn({ devAuth: true }, "development token issued");
    return { accessToken: await devAuth.issue(subject), expiresIn: 900, tokenType: "Bearer" as const };
  });
}
