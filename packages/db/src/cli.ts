import pg from "pg";
import { loadLocalEnv, requireEnv } from "./env.js";
import { ensureAppLogin, migrate } from "./migrate.js";
import { seed } from "./seed.js";
import { parseOwners, setupCompany } from "./setup-company.js";

async function main(): Promise<void> {
  loadLocalEnv();
  const command = process.argv[2];
  const appEnv = process.env.APP_ENV ?? "development";
  const client = new pg.Client({ connectionString: requireEnv("DATABASE_ADMIN_URL") });
  await client.connect();
  try {
    if (command === "reset") {
      if (appEnv !== "development") throw new Error("db:reset is only allowed when APP_ENV=development");
      await client.query("DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
      console.log("dropped local schemas");
    }
    if (command === "migrate" || command === "reset") {
      const ran = await migrate(client, (m) => console.log(m));
      console.log(ran.length ? `${ran.length} migration(s) applied` : "database is up to date");
      await ensureAppLogin(client, requireEnv("APP_DB_USER"), requireEnv("APP_DB_PASSWORD"));
      console.log("runtime login ready");
    }
    if (command === "seed" || command === "reset") {
      await seed(client, appEnv);
      console.log("synthetic demo data loaded");
    }
    if (command === "setup-company") {
      const nameAt = process.argv.indexOf("--name");
      const name = nameAt > 0 ? (process.argv[nameAt + 1] ?? "") : "";
      const r = await setupCompany(client, name, parseOwners(process.argv), { addToExisting: process.argv.includes("--add-to-existing") });
      console.log(`${r.created ? "created" : "found"} company ${r.orgId}; owners added: ${r.invited.length ? r.invited.join(", ") : "none new"}`);
      console.log("Each owner gets in by signing in with Microsoft using that email address.");
    }
    if (!["migrate", "seed", "reset", "setup-company"].includes(command ?? "")) {
      throw new Error('usage: cli.ts migrate|seed|reset|setup-company --name "Company" --owner "email:Full Name" [--owner ...] [--add-to-existing]');
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
