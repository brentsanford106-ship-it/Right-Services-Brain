import pg from "pg";

// Return DATE columns as 'YYYY-MM-DD' strings instead of JS Dates (avoids timezone shifts).
pg.types.setTypeParser(1082, (v: string) => v);
// Return bigint (int8) as JS numbers. Safe: all bigint columns are bounded far below 2^53 by CHECK constraints.
pg.types.setTypeParser(20, (v: string) => Number(v));

export type Tx = pg.PoolClient;

/** asOrg was asked for a company the user is not an active member of (or the company or user is not active). */
export class NotAMemberError extends Error {
  constructor() {
    super("not an active member of this organization");
  }
}

export interface Database {
  pool: pg.Pool;
  /** Runs fn in a transaction with only the user context set (no organization). */
  asUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Runs fn in a transaction scoped to one organization. RLS restricts every query to that organization. */
  asOrg<T>(userId: string, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Runs fn scoped to one organization with NO user (background jobs such as the Recently Deleted clean-up).
   * RLS still restricts every query to that organization. Never use this for a request.
   */
  asSystemInOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Runs fn with no user or organization context (RLS returns nothing tenant-scoped). */
  anonymous<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createDatabase(connectionString: string): Database {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: "rsb-api",
  });

  async function run<T>(ctx: { userId?: string; orgId?: string }, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // is_local = true: settings vanish at COMMIT/ROLLBACK, so they can never leak to the next request on this pooled connection.
      // A user working in a company: first prove (with only the user set) that they are an active member, and only
      // then switch the connection to that company. So the database never works "as" a company the user isn't in.
      await client.query("SELECT set_config('app.current_user_id', $1, true), set_config('app.current_org_id', $2, true)", [
        ctx.userId ?? "",
        ctx.userId && ctx.orgId ? "" : (ctx.orgId ?? ""),
      ]);
      if (ctx.userId && ctx.orgId) {
        const { rowCount } = await client.query(
          `SELECT 1 FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id
            WHERE m.organization_id = $1 AND m.user_id = $2 AND m.status = 'active' AND o.status = 'active'`,
          [ctx.orgId, ctx.userId],
        );
        if (!rowCount) throw new NotAMemberError();
        await client.query("SELECT set_config('app.current_org_id', $1, true)", [ctx.orgId]);
      }
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    pool,
    asUser: (userId, fn) => run({ userId }, fn),
    asOrg: (userId, orgId, fn) => run({ userId, orgId }, fn),
    asSystemInOrg: (orgId, fn) => run({ orgId }, fn),
    anonymous: (fn) => run({}, fn),
    close: () => pool.end(),
  };
}

/**
 * Refuses to run the API on a database login that could see past the company walls.
 * Row-level security only protects data when the API's login is NOT a superuser, can NOT bypass row-level
 * security, does NOT own the tables, and works through the restricted `rsb_app` role. A wrong DATABASE_URL
 * (for example the admin one) would silently switch the walls off, so the server checks at start-up and stops.
 */
export async function assertRestrictedLogin(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ login: string; superuser: boolean; bypass: boolean; in_app: boolean; admin_tools: boolean; strong_roles: number; owned: number }>(
    `SELECT current_user AS login,
            r.rolsuper AS superuser,
            r.rolbypassrls AS bypass,
            pg_has_role(current_user, 'rsb_app', 'MEMBER') AS in_app,
            CASE WHEN EXISTS (SELECT 1 FROM pg_roles t WHERE t.rolname = 'rsb_admin_tools')
                 THEN pg_has_role(current_user, 'rsb_admin_tools', 'MEMBER') ELSE false END AS admin_tools,
            (SELECT count(*)::int FROM pg_roles x
              WHERE pg_has_role(current_user, x.oid, 'MEMBER') AND (x.rolsuper OR x.rolbypassrls OR x.rolcreaterole)) AS strong_roles,
            (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname IN ('public', 'app') AND pg_has_role(current_user, c.relowner, 'MEMBER')) AS owned
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const r = rows[0];
  const problems: string[] = [];
  if (!r) problems.push("its login could not be identified");
  else {
    if (r.superuser) problems.push("it is a superuser");
    if (r.bypass) problems.push("it can bypass row-level security");
    if (r.strong_roles > 0) problems.push("it belongs to a role that is a superuser, can bypass row-level security, or can create roles");
    if (r.owned > 0) problems.push("it owns database tables");
    if (r.admin_tools) problems.push("it holds rsb_admin_tools, which is for the admin tools only");
    if (!r.in_app) problems.push("it is not a member of the restricted rsb_app role");
  }
  if (problems.length) {
    throw new Error(
      `Refusing to start: DATABASE_URL must use the restricted app login (APP_DB_USER), not the admin login. The current login is unsafe because ${problems.join("; ")}.`,
    );
  }
}
