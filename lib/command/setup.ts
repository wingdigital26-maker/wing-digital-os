// What is wired and what is not, for the Setup screen. Booleans and HTTP
// statuses only: no env value ever leaves the server.
import { calendarApiReady, calendarId } from "./calendar";
import { withStore, storeConfigured } from "./db";
import { codeFor } from "./auth";
import { notifyStatus } from "./notify";
import { USERS } from "./team";

/** A KEYED read against the OS Supabase project, reporting the real status
 *  (sbSelect would turn a 402 into an empty list). */
export async function osSupabaseProbe(): Promise<string> {
  const url = process.env.OS_SUPABASE_URL;
  const key = process.env.OS_SUPABASE_SERVICE_KEY;
  if (!url || !key) return "Not checked: OS_SUPABASE_URL or OS_SUPABASE_SERVICE_KEY is not set here.";
  try {
    const r = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/profiles?select=id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const body = (await r.text()).slice(0, 160);
    const ref = url.match(/https:\/\/([a-z0-9]+)\./)?.[1] ?? "unknown";
    if (r.ok) return `Project ${ref}: HTTP ${r.status}, healthy.`;
    return `Project ${ref}: HTTP ${r.status}${r.status === 402 ? " (restricted, storage quota)" : ""}. ${body}`;
  } catch (e) {
    return `Could not reach the OS Supabase project: ${e instanceof Error ? e.message : e}`;
  }
}

export async function setupStatus() {
  const store = storeConfigured()
    ? await withStore(async (sql) => (await sql<{ n: number }[]>`select count(*)::int as n from cc_problems`)[0].n)
    : null;
  return {
    store: !storeConfigured() ? "off" : store?.ok ? "ok" : `error: ${store && !store.ok ? store.reason : ""}`,
    sessionSecret: Boolean(process.env.AUTH_SESSION_SECRET),
    codes: Object.fromEntries(USERS.map((u) => [u, Boolean(codeFor(u))])),
    machineKey: Boolean(process.env.COMMAND_MACHINE_KEY && process.env.COMMAND_MACHINE_KEY.length >= 16),
    notify: notifyStatus(),
    calendar: { id: Boolean(calendarId()), api: calendarApiReady() },
    vault: process.env.VAULT_SOURCE === "github" ? Boolean(process.env.GH_VAULT_TOKEN) : Boolean(process.env.VAULT_PATH),
    roofCommand: Boolean(process.env.ROOF_SUPABASE_URL && process.env.ROOF_SUPABASE_SERVICE_KEY),
  };
}
