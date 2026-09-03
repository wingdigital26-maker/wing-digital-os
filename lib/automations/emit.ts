// ───────────────────────────────────────────────────────────────────────────
// emitEvent: the one door through which the rest of the OS tells the
// automation layer that something happened.
//
// A route that notices a fact (form posted, call missed, deal moved) calls
// emitEvent(). That inserts one `events` row and then runs the engine on it
// INLINE, so on Vercel the same serverless request that noticed the fact also
// executes the workflows for it, instead of waiting for the next cron tick.
//
// SAFETY RULES
//   * The insert is the contract. If it fails the caller gets an honest error
//     string and nothing else happens.
//   * The engine call is wrapped: an engine failure NEVER breaks the emitting
//     route. The event row stays unprocessed and the cron catches it up.
//   * emitEventAsync is for callers that must answer fast (Twilio wants TwiML
//     within seconds). It awaits the insert, then races the engine against a
//     4 s timer. On timeout it records nothing: the cron will finish the job,
//     and the workflow_runs UNIQUE constraint keeps a half-finished inline run
//     from ever double-firing.
// ───────────────────────────────────────────────────────────────────────────
import { sbUrl, sbService } from "@/lib/osSupabase";
import { processEvents, type ProcessSummary } from "./engine";
import type { EmitInput, EventRow } from "./types";

export type EmitResult = { id: number | null; error: string | null; processed?: ProcessSummary };

async function insertEvent(input: EmitInput): Promise<{ id: number | null; error: string | null }> {
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) return { id: null, error: "OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY are not set." };
  if (!input?.type) return { id: null, error: "emitEvent: type is required." };
  const row: Record<string, unknown> = {
    type: input.type,
    client_slug: input.client_slug ?? null,
    contact_id: input.contact_id ?? null,
    payload: input.payload ?? {},
  };
  if (input.occurred_at) row.occurred_at = input.occurred_at;
  try {
    const r = await fetch(`${url}/rest/v1/events`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(row),
      cache: "no-store",
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { id: null, error: `events insert failed (HTTP ${r.status}): ${body.slice(0, 200)}` };
    }
    const rows = (await r.json()) as EventRow[];
    const id = rows?.[0]?.id ?? null;
    return id == null ? { id: null, error: "events insert returned no row." } : { id, error: null };
  } catch (e) {
    return { id: null, error: e instanceof Error ? e.message : String(e) };
  }
}

// Insert the event and process it before returning.
export async function emitEvent(input: EmitInput): Promise<EmitResult> {
  const ins = await insertEvent(input);
  if (ins.id == null) return { id: null, error: ins.error };
  try {
    const processed = await processEvents({ limit: 5, onlyEventId: ins.id });
    return { id: ins.id, error: null, processed };
  } catch (e) {
    // The event is stored; the cron will pick it up. Say so instead of
    // failing the route that emitted it.
    return {
      id: ins.id,
      error: `event #${ins.id} stored but inline processing failed (cron will retry): ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// Insert the event, give the engine up to 4 s, then return regardless.
export async function emitEventAsync(input: EmitInput, waitMs = 4000): Promise<EmitResult> {
  const ins = await insertEvent(input);
  if (ins.id == null) return { id: null, error: ins.error };
  const engine = processEvents({ limit: 5, onlyEventId: ins.id }).catch(() => undefined);
  const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), waitMs));
  const processed = await Promise.race([engine, timeout]);
  return { id: ins.id, error: null, processed: processed ?? undefined };
}
