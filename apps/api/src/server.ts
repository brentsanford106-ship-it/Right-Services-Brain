import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./lib/db.js";

const rootEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env");
if (existsSync(rootEnv) && process.env.APP_ENV !== "production" && process.env.APP_ENV !== "staging") {
  process.loadEnvFile(rootEnv);
}

const config = loadConfig(process.env);
const db = createDatabase(config.databaseUrl);
const app = await buildApp({ config, db });

if (config.devAuthEnabled) {
  app.log.warn("DEVELOPMENT AUTHENTICATION IS ENABLED. This build must never be deployed.");
}

const shutdown = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: config.host, port: config.port });
