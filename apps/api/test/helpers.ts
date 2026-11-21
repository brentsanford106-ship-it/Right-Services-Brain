import { Writable } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalDiskStorage } from "../src/storage/localDisk.js";
import { inject } from "vitest";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDatabase, type Database } from "../src/lib/db.js";
import { DevAuth } from "../src/auth/dev.js";
import { fixtures } from "@rsb/db";

export const F = fixtures;
export const ORG_A = fixtures.ORG_A;
export const ORG_B = fixtures.ORG_B;

export interface TestApp {
  app: FastifyInstance;
  db: Database;
  devAuth: DevAuth;
  logs: string[];
  storage: LocalDiskStorage;
  token(subject: string, ttlSeconds?: number): Promise<string>;
  /** Authenticated request helper. */
  as(subject: string): {
    get(url: string): Promise<Res>;
    post(url: string, body?: unknown): Promise<Res>;
    patch(url: string, body: unknown): Promise<Res>;
    del(url: string): Promise<Res>;
    put(url: string, data: Buffer, contentType: string): Promise<Res>;
    raw(url: string): Promise<{ status: number; data: Buffer; headers: Record<string, unknown> }>;
  };
  close(): Promise<void>;
}

export interface Res {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Record<string, string | string[] | number | undefined>;
}

export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const config = loadConfig({
    APP_ENV: "test",
    DATABASE_URL: inject("appDbUrl"),
    DEV_AUTH_ENABLED: "true",
    LOG_LEVEL: "info",
    RATE_LIMIT_PER_MINUTE: "100000",
    CORS_ALLOWED_ORIGINS: "http://localhost:5173",
    // Existing Phase 2 schema/route tests keep running; a dedicated test checks the default is off.
    PHASE2_FEATURES: "true",
    ...overrides,
  });
  const db = createDatabase(config.databaseUrl);
  const devAuth = await DevAuth.create();
  const logs: string[] = [];
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logs.push(String(chunk));
      cb();
    },
  });
  const storage = new LocalDiskStorage(mkdtempSync(path.join(tmpdir(), "rsb-store-")));
  const app = await buildApp({ config, db, devAuth: config.devAuthEnabled ? devAuth : null, logStream, storage });
  await app.ready();

  const send = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, token: string | null, body?: unknown): Promise<Res> => {
    const res = await app.inject({
      method,
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
  };

  return {
    app,
    db,
    devAuth,
    logs,
    storage,
    token: (s, ttl) => devAuth.issue(s, ttl),
    as: (subject) => ({
      get: async (url) => send("GET", url, await devAuth.issue(subject)),
      post: async (url, body) => send("POST", url, await devAuth.issue(subject), body ?? {}),
      patch: async (url, body) => send("PATCH", url, await devAuth.issue(subject), body),
      del: async (url) => send("DELETE", url, await devAuth.issue(subject)),
      put: async (url, data, contentType) => {
        const res = await app.inject({ method: "PUT", url, headers: { authorization: `Bearer ${await devAuth.issue(subject)}`, "content-type": contentType }, payload: data });
        return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
      },
      raw: async (url) => {
        const res = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${await devAuth.issue(subject)}` } });
        return { status: res.statusCode, data: res.rawPayload, headers: res.headers };
      },
    }),
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

/** Direct connection as the restricted runtime role, for SQL-level RLS tests. */
export async function appRoleClient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: inject("appDbUrl") });
  await c.connect();
  return c;
}

export async function adminClient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: inject("adminDbUrl") });
  await c.connect();
  return c;
}

export const uuid = () => crypto.randomUUID();
