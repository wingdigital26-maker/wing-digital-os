// Where Instantly webhook events land.
//
// ISOLATED ON PURPOSE: this is the only file that knows how webhook events are
// stored. A sibling branch is moving OS data access onto one direct-Postgres
// module (lib/db.ts); when that lands, repoint pg() below at it and nothing
// else changes.
//
// Two layers:
//   1. An in-process ring (last 200 events). Always on. On Vercel this lives
//      as long as the warm instance does, so it is a fast path, not a record.
//   2. Postgres over OS_DB_URL (the Supabase pooler that still works through
//      the 2026-09-21 REST 402). Best effort: if OS_DB_URL is unset or the
//      write fails, the event still sits in the ring AND the reply is still in
//      Instantly, where the polling path reads it within seconds. Nothing is
//      lost by this layer being down; it only makes webhook replies visible to
//      every server instance at once.
//
// Table (created on first use, idempotent):
//   instantly_webhook_events(id bigserial, received_at timestamptz,
//     event_type text, lead_email text, campaign_id text, payload jsonb)
import postgres from "postgres";

export type InstantlyWebhookEvent = {
  receivedAt: string;
  eventType: string;
  leadEmail: string | null;
  campaignId: string | null;
  payload: Record<string, unknown>;
};

const RING_MAX = 200;
const ring: InstantlyWebhookEvent[] = [];

type Sql = ReturnType<typeof postgres>;
let sql: Sql | null = null;
let tableReady: Promise<boolean> | null = null;

// The pooler has stalled for minutes at a time (2026-09-24 test hit a 2 min
// statement timeout once). A webhook must answer Instantly fast and a page must
// not wait on a sick database, so every call here is capped.
const DB_CAP_MS = 4_000;
function capped<T>(p: Promise<T>, ms = DB_CAP_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("instantly events db timed out")), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// After a failure, leave the database alone for a minute so every page load
// does not wait out the cap on a sick pooler.
let downUntil = 0;
function markDown() { downUntil = Date.now() + 60_000; }

function pg(): Sql | null {
  const url = process.env.OS_DB_URL;
  if (!url || Date.now() < downUntil) return null;
  if (!sql) sql = postgres(url, { prepare: false, max: 2, idle_timeout: 20, connect_timeout: 5 });
  return sql;
}

async function ensureTable(db: Sql): Promise<boolean> {
  if (!tableReady) {
    tableReady = db`
      create table if not exists instantly_webhook_events (
        id bigserial primary key,
        received_at timestamptz not null default now(),
        event_type text not null,
        lead_email text,
        campaign_id text,
        payload jsonb not null
      )`
      .then(() => db`create index if not exists instantly_webhook_events_recent on instantly_webhook_events (event_type, received_at desc)`)
      .then(() => true)
      .catch(() => {
        tableReady = null; // try again next time
        return false;
      });
  }
  return tableReady;
}

export async function recordInstantlyEvent(ev: InstantlyWebhookEvent): Promise<{ persisted: boolean }> {
  ring.unshift(ev);
  if (ring.length > RING_MAX) ring.length = RING_MAX;
  const db = pg();
  if (!db) return { persisted: false };
  try {
    await capped((async () => {
      if (!(await ensureTable(db))) throw new Error("no table");
      await db`
      insert into instantly_webhook_events (received_at, event_type, lead_email, campaign_id, payload)
      values (${ev.receivedAt}, ${ev.eventType}, ${ev.leadEmail}, ${ev.campaignId}, ${db.json(ev.payload as postgres.JSONValue)})`;
    })());
    return { persisted: true };
  } catch {
    markDown();
    return { persisted: false };
  }
}

/** Recent events of the given types, newest first, ring + Postgres merged. */
export async function recentInstantlyEvents(types: string[], sinceMs = 14 * 24 * 3600 * 1000): Promise<InstantlyWebhookEvent[]> {
  const cutoff = Date.now() - sinceMs;
  const fromRing = ring.filter((e) => types.includes(e.eventType) && Date.parse(e.receivedAt) >= cutoff);
  const db = pg();
  if (!db) return fromRing;
  try {
    // One cap for the whole read: a page waits at most 2.5s on this layer.
    const rows = await capped((async () => {
      if (!(await ensureTable(db))) throw new Error("no table");
      return db<{ received_at: Date; event_type: string; lead_email: string | null; campaign_id: string | null; payload: Record<string, unknown> }[]>`
      select received_at, event_type, lead_email, campaign_id, payload
      from instantly_webhook_events
      where event_type = any(${types}) and received_at >= ${new Date(cutoff).toISOString()}
      order by received_at desc
      limit 200`;
    })(), 2_500);
    const seen = new Set(fromRing.map((e) => `${e.eventType}|${e.leadEmail}|${e.receivedAt}`));
    const merged = [...fromRing];
    for (const r of rows) {
      const ev: InstantlyWebhookEvent = {
        receivedAt: new Date(r.received_at).toISOString(),
        eventType: r.event_type,
        leadEmail: r.lead_email,
        campaignId: r.campaign_id,
        payload: r.payload,
      };
      const k = `${ev.eventType}|${ev.leadEmail}|${ev.receivedAt}`;
      if (!seen.has(k)) { seen.add(k); merged.push(ev); }
    }
    return merged.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
  } catch {
    markDown();
    return fromRing;
  }
}

/** When the last webhook of any kind arrived on this instance (null = never). */
export function lastInstantlyWebhookAt(): string | null {
  return ring[0]?.receivedAt ?? null;
}
