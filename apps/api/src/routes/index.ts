import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/db.js";
import type { DevAuth } from "../auth/dev.js";
import type { ObjectStorage } from "../storage/types.js";
import { healthRoutes } from "./health.js";
import { meRoutes } from "./me.js";
import { jobRoutes } from "./jobs.js";
import { photoRoutes } from "./photos.js";
import { avatarRoutes } from "./avatars.js";
import { commentRoutes } from "./comments.js";
import { markupRoutes } from "./markups.js";
import { issueRoutes } from "./issues.js";
import { receiptRoutes } from "./receipts.js";
import { vehicleRoutes } from "./vehicles.js";
import { memberRoutes } from "./members.js";
import { teamRoutes } from "./team.js";
import { devAuthRoutes } from "./devAuth.js";

export interface RouteDeps {
  db: Database;
  config: AppConfig;
  devAuth: DevAuth | null;
  storage: ObjectStorage;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  await app.register(async (s) => healthRoutes(s, deps));
  await app.register(async (s) => meRoutes(s, deps));
  await app.register(async (s) => jobRoutes(s, deps));
  await app.register(async (s) => photoRoutes(s, deps));
  await app.register(async (s) => avatarRoutes(s, deps));
  await app.register(async (s) => commentRoutes(s, deps));
  await app.register(async (s) => markupRoutes(s, deps));
  await app.register(async (s) => issueRoutes(s, deps));
  await app.register(async (s) => teamRoutes(s, deps));
  // Phase 2 modules stay switched off in Phase 1 (they return 404) so nothing outside the photo scope is exposed.
  if (deps.config.phase2Features) {
    await app.register(async (s) => receiptRoutes(s, deps));
    await app.register(async (s) => vehicleRoutes(s, deps));
    await app.register(async (s) => memberRoutes(s, deps));
  }
  // Development-only login. Registered ONLY when dev auth is enabled (never in staging/production).
  if (deps.devAuth) await app.register(async (s) => devAuthRoutes(s, deps.devAuth!, deps.db));
}
