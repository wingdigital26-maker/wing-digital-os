// Cold-call prospects. The master list lives on Jack's laptop (prospects.db,
// never written to); this is the cloud copy Dylan dials from, plus outcomes.
import crypto from "node:crypto";
import type { Sql } from "./db";

export type ProspectIn = {
  id?: string;
  business?: string;
  contact?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  city?: string | null;
  niche?: string | null;
  hook?: string | null;
};

export const OUTCOMES = [
  { key: "no_answer", label: "No answer", days: 2 },
  { key: "voicemail", label: "Voicemail", days: 3 },
  { key: "call_back", label: "Call back", days: 1 },
  { key: "meeting", label: "Meeting booked", days: null },
  { key: "not_interested", label: "Not interested", days: null },
] as const;
export type OutcomeKey = (typeof OUTCOMES)[number]["key"];

const s = (v: unknown, max = 300) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export function normalizeProspect(p: ProspectIn, source: string): (ProspectIn & { id: string; business: string; source: string }) | null {
  const business = s(p.business, 200);
  const phone = s(p.phone, 40);
  if (!business || !(phone || s(p.email))) return null;
  const id =
    s(p.id, 120) ||
    `csv:${crypto.createHash("sha1").update(`${business.toLowerCase()}|${(phone || "").replace(/\D/g, "")}`).digest("hex").slice(0, 16)}`;
  return {
    id, business, source,
    contact: s(p.contact, 120), phone, email: s(p.email, 200), website: s(p.website, 300),
    city: s(p.city, 80), niche: s(p.niche, 80), hook: s(p.hook, 400),
  };
}

/** Upsert prospects. Never touches call state (outcomes, notes, next date). */
export async function upsertProspects(sql: Sql, rows: ProspectIn[], source: string) {
  let added = 0, updated = 0, skipped = 0;
  for (const raw of rows.slice(0, 5000)) {
    const p = normalizeProspect(raw, source);
    if (!p) { skipped++; continue; }
    const [r] = await sql<{ inserted: boolean }[]>`
      insert into cc_prospects (id, business, contact, phone, email, website, city, niche, source, hook)
      values (${p.id}, ${p.business}, ${p.contact ?? null}, ${p.phone ?? null}, ${p.email ?? null}, ${p.website ?? null},
              ${p.city ?? null}, ${p.niche ?? null}, ${source}, ${p.hook ?? null})
      on conflict (id) do update set
        business = excluded.business, contact = coalesce(excluded.contact, cc_prospects.contact),
        phone = coalesce(excluded.phone, cc_prospects.phone), email = coalesce(excluded.email, cc_prospects.email),
        website = coalesce(excluded.website, cc_prospects.website), city = coalesce(excluded.city, cc_prospects.city),
        niche = coalesce(excluded.niche, cc_prospects.niche), hook = coalesce(excluded.hook, cc_prospects.hook),
        updated_at = now()
      returning (xmax = 0) as inserted`;
    if (r.inserted) added++; else updated++;
  }
  return { added, updated, skipped };
}
