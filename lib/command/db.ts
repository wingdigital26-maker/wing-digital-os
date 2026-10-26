// ── Command Center storage adapter ──────────────────────────────────────────
// Every Command Center write and read goes through here, so swapping where the
// data lives is a one-file change.
//
// WHY NOT the OS Supabase REST API: the OS project (ikgnhieorzjaxtjoneye) has
// answered every REST call with HTTP 402 since 2026-09-21, and sbSelect() turns
// that into an empty list, which would make a team dashboard look calm while it
// silently drops writes. So this store talks plain Postgres over ONE connection
// string, which works with any of:
//   - a new free Supabase project (use its "Transaction pooler" URI, port 6543)
//   - Vercel Postgres / Neon (the POSTGRES_URL it creates)
//   - the OS project's own pooler, once its restriction is lifted
//
// Env:
//   COMMAND_DB_URL   postgres://... (required; unset = the store is OFF and
//                    every screen says so instead of pretending to be empty)
//   COMMAND_DB_SSL   "off" to disable TLS (local testing only)
//
// FAILS CLOSED: no URL, or an unreachable database, returns { ok:false, reason }
// that the UI shows in plain words. Nothing here ever returns fake rows.
import postgres from "postgres";
import { COMMAND_SCHEMA_SQL } from "./schema";

export type Sql = ReturnType<typeof postgres>;

declare global {
  var __ccSql: Sql | undefined;
  var __ccSchemaReady: Promise<void> | undefined;
}

export const STORE_NOT_CONFIGURED =
  "Storage is not set up yet. Jack needs to add COMMAND_DB_URL (a Postgres connection string) " +
  "to this deployment. Until then nothing can be saved here.";

export function storeConfigured(): boolean {
  return Boolean(process.env.COMMAND_DB_URL);
}

function client(): Sql {
  if (!globalThis.__ccSql) {
    const url = process.env.COMMAND_DB_URL as string;
    const local = /@(localhost|127\.0\.0\.1)|host=\/|%2Ftmp/.test(url);
    globalThis.__ccSql = postgres(url, {
      // Transaction poolers (Supabase 6543, Neon pgbouncer) reject prepared statements.
      prepare: false,
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
      ssl: process.env.COMMAND_DB_SSL === "off" || local ? false : "require",
      onnotice: () => {},
    });
  }
  return globalThis.__ccSql;
}

async function ensureSchema(sql: Sql): Promise<void> {
  if (!globalThis.__ccSchemaReady) {
    globalThis.__ccSchemaReady = sql.unsafe(COMMAND_SCHEMA_SQL).then(
      () => undefined,
      (e) => {
        globalThis.__ccSchemaReady = undefined; // retry on the next request
        throw e;
      }
    );
  }
  return globalThis.__ccSchemaReady;
}

export type StoreResult<T> = { ok: true; data: T } | { ok: false; reason: string };

/** Run work against the store. Never throws: failures come back as a reason. */
export async function withStore<T>(work: (sql: Sql) => Promise<T>): Promise<StoreResult<T>> {
  if (!storeConfigured()) return { ok: false, reason: STORE_NOT_CONFIGURED };
  try {
    const sql = client();
    await ensureSchema(sql);
    return { ok: true, data: await work(sql) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `The database refused the request: ${msg.slice(0, 200)}` };
  }
}

/** Unwrap a store result for server components: data, or a fallback plus the reason. */
export function orEmpty<T>(r: StoreResult<T>, empty: T): { data: T; error: string | null } {
  return r.ok ? { data: r.data, error: null } : { data: empty, error: r.reason };
}
