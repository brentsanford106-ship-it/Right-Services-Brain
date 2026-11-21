import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./lib/db.js";

const rootEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env");
const deployed = process.env.APP_ENV === "production" || process.env.APP_ENV === "staging";
// Settings already in the shell (e.g. $env:API_HOST in PowerShell, or Windows user variables) win over .env.
const notes: string[] = [];
if (existsSync(rootEnv) && !deployed) {
  const fromFile = parseEnv(readFileSync(rootEnv, "utf8"));
  for (const key of ["API_HOST", "API_PORT", "DATABASE_URL", "APP_ENV"]) {
    const shell = process.env[key];
    if (shell !== undefined && fromFile[key] !== undefined && shell !== fromFile[key]) {
      notes.push(`${key} is set outside .env (in this window or Windows settings), so .env's value is ignored for it.`);
    }
  }
  process.loadEnvFile(rootEnv);
}

// `--lan` (pnpm dev:api:phone): reachable from phones on the same Wi-Fi, without editing .env. Development only.
if (process.argv.includes("--lan")) {
  if (deployed) throw new Error("--lan is for development only.");
  process.env.API_HOST = "0.0.0.0";
}

const config = loadConfig(process.env);
const db = createDatabase(config.databaseUrl);
const app = await buildApp({ config, db });

if (config.devAuthEnabled) {
  app.log.warn("DEVELOPMENT AUTHENTICATION IS ENABLED. This build must never be deployed.");
}
for (const n of notes) app.log.warn(n);
if (!deployed && (config.host === "127.0.0.1" || config.host === "localhost")) {
  app.log.info("Only this computer can reach the server. To test on a phone, stop this and run: pnpm dev:api:phone");
}

const shutdown = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: config.host, port: config.port });
