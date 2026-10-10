import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

/**
 * REAL-DATABASE test harness.
 *
 * Creates a throwaway database on the PostgreSQL server in TEST_DATABASE_URL, applies the
 * Supabase shim (database/tests/supabase-shim.sql) and migrations 0001..N in order, and drops
 * the database afterwards. Roles are switched with SET LOCAL ROLE and JWT claims are set the
 * way PostgREST does, so RLS, grants, constraints and triggers run for real.
 *
 * Refuses non-local servers unless TEST_DATABASE_ALLOW_REMOTE=1, so it cannot be pointed at a
 * real Supabase project by accident. This is plain PostgreSQL, NOT hosted Supabase.
 */

const ROOT = join(__dirname, "..", "..");
const MIGRATIONS = ["0001_profiles.sql", "0002_wallet_foundation.sql", "0003_new_user_trigger.sql", "0004_competitions.sql"];

export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is required for tests/db (a disposable local PostgreSQL server).");
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host) && process.env.TEST_DATABASE_ALLOW_REMOTE !== "1") {
    throw new Error(`Refusing to run database tests against non-local host ${host}.`);
  }
  return url;
}

export type Role = "anon" | "authenticated" | "service_role";

export type TestDb = {
  pool: pg.Pool;
  /** Runs as the migration owner (superuser here; `postgres` on Supabase). Test setup only. */
  admin: <R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]) => Promise<pg.QueryResult<R>>;
  /** Runs `fn` in ONE transaction as `role` (with JWT `sub` for authenticated) and COMMITS, so deferred triggers fire as that role. */
  as: <T>(role: Role, userId: string | null, fn: (q: Query) => Promise<T>) => Promise<T>;
  /** Shorthand: one statement as an authenticated user. */
  asUser: <R extends pg.QueryResultRow = pg.QueryResultRow>(userId: string, sql: string, params?: unknown[]) => Promise<pg.QueryResult<R>>;
  createUser: (displayName?: string) => Promise<string>;
  drop: () => Promise<void>;
};

export type Query = <R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]) => Promise<pg.QueryResult<R>>;

export async function createTestDb(): Promise<TestDb> {
  const baseUrl = requireTestDatabaseUrl();
  const name = `sabi_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

  const maint = new pg.Client({ connectionString: baseUrl });
  await maint.connect();
  await maint.query(`create database ${name}`);
  await maint.end();

  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 6 });

  const setup = await pool.connect();
  try {
    await setup.query(readFileSync(join(ROOT, "database/tests/supabase-shim.sql"), "utf8"));
    for (const file of MIGRATIONS) {
      await setup.query(readFileSync(join(ROOT, "database/migrations", file), "utf8"));
    }
  } finally {
    setup.release();
  }

  const as: TestDb["as"] = async (role, userId, fn) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`set local role ${role}`);
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify(userId ? { sub: userId, role } : { role }),
      ]);
      const result = await fn((sql, params) => client.query(sql, params));
      await client.query("commit");
      return result;
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  };

  return {
    pool,
    admin: (sql, params) => pool.query(sql, params),
    as,
    asUser: (userId, sql, params) => as("authenticated", userId, (q) => q(sql, params)),
    createUser: async (displayName = "Player") => {
      const id = randomUUID();
      await pool.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [
        id, `${id}@test.local`, JSON.stringify({ display_name: displayName }),
      ]);
      return id;
    },
    drop: async () => {
      await pool.end();
      const c = new pg.Client({ connectionString: baseUrl });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    },
  };
}

/** Resolves to the error message (Postgres raises our stable codes as messages). */
export async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected the operation to fail, but it succeeded");
}
