import { randomBytes } from "node:crypto";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { ensureAppLogin, migrate, seed } from "@rsb/db";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Creates a brand-new database for this test run, applies every migration
 * from scratch, creates a restricted runtime login, and loads the synthetic
 * seed. Requires TEST_DATABASE_ADMIN_URL (or DATABASE_ADMIN_URL) pointing at a
 * local PostgreSQL server with permission to create databases.
 */
let adminUrl = "";
let dbName = "";
let appUser = "";

declare module "vitest" {
  export interface ProvidedContext {
    adminDbUrl: string;
    appDbUrl: string;
  }
}

export async function setup(project: TestProject): Promise<void> {
  const rootEnv = path.resolve(import.meta.dirname, "../../../.env");
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? process.env.DATABASE_ADMIN_URL ?? "";
  if (!adminUrl) throw new Error("Set TEST_DATABASE_ADMIN_URL (or DATABASE_ADMIN_URL) to a local PostgreSQL admin connection");

  const runId = `${Date.now()}_${randomBytes(3).toString("hex")}`;
  dbName = `rsb_test_${runId}`;
  // Logins are server-wide in PostgreSQL, so each run gets its own; parallel runs can't reset each other's password.
  appUser = `rsb_test_login_${runId}`;
  const server = new pg.Client({ connectionString: adminUrl });
  await server.connect();
  await server.query(`CREATE DATABASE ${dbName}`); // name is generated above, not user input
  await server.end();

  const testAdminUrl = withDatabase(adminUrl, dbName);
  const appPassword = randomBytes(24).toString("hex");
  const admin = new pg.Client({ connectionString: testAdminUrl });
  await admin.connect();
  await migrate(admin);
  await ensureAppLogin(admin, appUser, appPassword);
  await seed(admin, "test");
  await admin.end();

  const appUrl = new URL(testAdminUrl);
  appUrl.username = appUser;
  appUrl.password = appPassword;
  project.provide("adminDbUrl", testAdminUrl);
  project.provide("appDbUrl", appUrl.toString());
}

export async function teardown(): Promise<void> {
  if (!dbName || process.env.KEEP_TEST_DB === "true") return;
  const server = new pg.Client({ connectionString: adminUrl });
  await server.connect();
  await server.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  if (appUser) await server.query(`DROP ROLE IF EXISTS ${appUser}`); // generated above, not user input
  await server.end();
}

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
