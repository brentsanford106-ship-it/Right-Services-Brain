import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import type { Database } from "../lib/db.js";
import type { DevAuth } from "../auth/dev.js";
import type { ObjectStorage } from "../storage/types.js";
import { healthRoutes } from "./health.js";
import { meRoutes } from "./me.js";
import { jobRoutes } from "./jobs.js";
import { photoRoutes } from "./photos.js";
import { receiptRoutes } from "./receipts.js";
import { vehicleRoutes } from "./vehicles.js";
import { memberRoutes } from "./members.js";
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
  await app.register(async (s) => receiptRoutes(s, deps));
  await app.register(async (s) => vehicleRoutes(s, deps));
  await app.register(async (s) => memberRoutes(s, deps));
  // Development-only login. Registered ONLY when dev auth is enabled (never in staging/production).
  if (deps.devAuth) await app.register(async (s) => devAuthRoutes(s, deps.devAuth!, deps.db));
}
