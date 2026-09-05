// ───────────────────────────────────────────────────────────────────────────
// Per-client dashboard keys — shared by the public dashboard route (which
// verifies a key) and the staff keys admin route (which mints/lists/revokes).
//
// The gate FAILS CLOSED: verifyClientKey returns false for a missing key, a
// wrong key, an inactive key, or any database/config failure. A route that
// trusts this helper never leaks a client's data on an error path.
//
// Keys are opaque, URL-safe, and crypto-random — never derived from the slug.
// ───────────────────────────────────────────────────────────────────────────
import { randomUUID } from "crypto";
import { sbSelect, sbUrl, sbService } from "@/lib/osSupabase";

export type DashboardKeyRow = {
  id: number;
  client_slug: string;
  key: string;
  label: string | null;
  active: boolean;
  created_at: string;
  last_used_at: string | null;
};

// Two stripped UUIDs -> 64 URL-safe hex chars. Opaque and unguessable, with no
// relationship to the client slug.
export function mintClientKey(): string {
  return (randomUUID() + randomUUID()).replace(/-/g, "");
}

// Best-effort last_used_at touch. Never awaited by the gate and never allowed
// to throw — a dead write here must not block or fail a valid read.
function touchLastUsed(id: number): void {
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) return;
  void fetch(`${url}/rest/v1/client_dashboard_keys?id=eq.${id}`, {
    method: "PATCH",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ last_used_at: new Date().toISOString() }),
    cache: "no-store",
  }).catch(() => {});
}

// True only when an active key row matches BOTH the slug and the key exactly.
// Reads with the service key because the table has no anon read policy.
export async function verifyClientKey(
  slug: string,
  key: string | null | undefined
): Promise<boolean> {
  if (!slug || !key || typeof key !== "string") return false;
  const rows = await sbSelect<DashboardKeyRow>({
    table: "client_dashboard_keys",
    select: "id",
    query:
      `client_slug=eq.${encodeURIComponent(slug)}` +
      `&key=eq.${encodeURIComponent(key)}` +
      `&active=eq.true&limit=1`,
    service: true,
  });
  if (!rows.length) return false;
  touchLastUsed(rows[0].id); // fire and forget
  return true;
}
