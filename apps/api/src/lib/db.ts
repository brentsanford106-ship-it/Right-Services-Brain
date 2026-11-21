import pg from "pg";

// Return DATE columns as 'YYYY-MM-DD' strings instead of JS Dates (avoids timezone shifts).
pg.types.setTypeParser(1082, (v: string) => v);
// Return bigint (int8) as JS numbers. Safe: all bigint columns are bounded far below 2^53 by CHECK constraints.
pg.types.setTypeParser(20, (v: string) => Number(v));

export type Tx = pg.PoolClient;

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
      await client.query("SELECT set_config('app.current_user_id', $1, true), set_config('app.current_org_id', $2, true)", [
        ctx.userId ?? "",
        ctx.orgId ?? "",
      ]);
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
