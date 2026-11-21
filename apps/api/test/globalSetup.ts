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

  dbName = `rsb_test_${Date.now()}_${randomBytes(3).toString("hex")}`;
  const server = new pg.Client({ connectionString: adminUrl });
  await server.connect();
  await server.query(`CREATE DATABASE ${dbName}`); // name is generated above, not user input
  await server.end();

  const testAdminUrl = withDatabase(adminUrl, dbName);
  const appUser = "rsb_test_app_login";
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
  await server.end();
}

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
