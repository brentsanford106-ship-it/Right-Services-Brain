import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const files: MigrationFile[] = [];
  const seen = new Set<string>();
  for (const name of entries) {
    const match = FILE_PATTERN.exec(name);
    if (!match?.[1]) throw new Error(`Migration file name does not match NNNN_name.sql: ${name}`);
    if (seen.has(match[1])) throw new Error(`Duplicate migration version ${match[1]}`);
    seen.add(match[1]);
    const sql = await readFile(path.join(dir, name), "utf8");
    files.push({ version: match[1], name, sql, checksum: createHash("sha256").update(sql).digest("hex") });
  }
  return files;
}

/**
 * Applies pending migrations in order, each in its own transaction.
 * Refuses to run if an already-applied migration file has been edited
 * (checksum mismatch): applied migrations are immutable; add a new one instead.
 */
export async function migrate(client: pg.ClientBase, log: (msg: string) => void = () => {}): Promise<string[]> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      name       text NOT NULL,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  // Serialise concurrent migrators.
  await client.query("SELECT pg_advisory_lock(727274001)");
  try {
    const applied = new Map<string, string>();
    const { rows } = await client.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations",
    );
    for (const r of rows) applied.set(r.version, r.checksum);

    const files = await loadMigrations();
    const ran: string[] = [];
    for (const file of files) {
      const existing = applied.get(file.version);
      if (existing !== undefined) {
        if (existing !== file.checksum) {
          throw new Error(`Migration ${file.name} was modified after being applied. Create a new migration instead.`);
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(file.sql);
        await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [
          file.version,
          file.name,
          file.checksum,
        ]);
        await client.query("COMMIT");
        log(`applied ${file.name}`);
        ran.push(file.name);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    return ran;
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274001)");
  }
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Creates or updates the restricted login used by the API.
 * The login inherits only `rsb_app` and is explicitly not a superuser and
 * cannot bypass row-level security.
 */
export async function ensureAppLogin(client: pg.ClientBase, user: string, password: string): Promise<void> {
  if (!IDENT.test(user)) throw new Error("APP_DB_USER must be a simple lowercase identifier");
  if (password.length < 16) throw new Error("APP_DB_PASSWORD must be at least 16 characters");
  const { rows } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [user]);
  // Role names cannot be bound as parameters; the identifier is validated above
  // and the password is escaped as a literal by the server-side format().
  // ALTER leaves out NOSUPERUSER/NOBYPASSRLS: a non-superuser admin (Azure) may not even mention those attributes,
  // so re-running migrations on every deploy failed with "permission denied to alter role". They are checked instead.
  const sql = rows.length === 0
    ? "format('CREATE ROLE %I WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', $1::text, $2::text)"
    : "format('ALTER ROLE %I WITH LOGIN INHERIT NOCREATEDB NOCREATEROLE PASSWORD %L', $1::text, $2::text)";
  const { rows: stmt } = await client.query<{ sql: string }>(`SELECT ${sql} AS sql`, [user, password]);
  await client.query(stmt[0]!.sql);
  const { rows: attrs } = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1",
    [user],
  );
  if (attrs[0]?.rolsuper || attrs[0]?.rolbypassrls) {
    throw new Error(`The app login ${user} is a superuser or can bypass row-level security. Remove that before continuing.`);
  }
  const { rows: grant } = await client.query<{ sql: string }>("SELECT format('GRANT rsb_app TO %I', $1::text) AS sql", [user]);
  await client.query(grant[0]!.sql);
}
