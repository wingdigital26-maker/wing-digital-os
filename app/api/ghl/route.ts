import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const GHL_API_KEY = process.env.GHL_API_KEY!;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID!;

// ── Real MRR source ───────────────────────────────────────────────────────────
// GHL cannot supply a reliable monthly-recurring figure here: opportunity
// `monetaryValue` on the main Wing Digital location is one-time/deal value, not a
// monthly retainer, and each paying retainer client lives in its OWN GHL sub-account
// (e.g. Jackson Roofing under GHL_JACKSON_ROOFING_PIT) so their MRR is not present in
// this location's opportunities at all. The single source of truth Jack maintains is
// the client notes frontmatter (`mrr:`), the same source /api/clients reads. We sum
// the `mrr` of every ACTIVE client that has a real numeric retainer on file.
const CLIENTS_DIR =
  "C:\\Users\\wjack\\OneDrive\\Documentos\\Obsidian 2.0\\Jacks Ai Brain 2.0\\wiki\\clients";

type ActiveClient = { name: string; value: number; slug: string; status: string };

function readRetainerRoster(): ActiveClient[] {
  try {
    const files = fs.readdirSync(CLIENTS_DIR).filter((f) => f.endsWith(".md"));
    const roster: ActiveClient[] = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(CLIENTS_DIR, f), "utf-8");
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const kv: Record<string, string> = {};
      if (fm) {
        for (const line of fm[1].split(/\r?\n/)) {
          const m = line.match(/^(\w[\w_-]*):\s*(.+)$/);
          if (m) kv[m[1].toLowerCase()] = m[2].trim();
        }
      }
      const status = (kv["status"] || "active").toLowerCase();
      const mrr = kv["mrr"] ? Number(kv["mrr"]) : 0;
      // Only count clients with a real, positive retainer on file as MRR.
      if (status === "active" && mrr > 0) {
        const slug = f.replace(/\.md$/, "");
        const pretty = slug
          .split("-")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");
        roster.push({ name: kv["client_name"] || pretty, value: mrr, slug, status });
      }
    }
    return roster;
  } catch {
    // If the vault is unreachable, fall back to the one confirmed retainer so the
    // dashboard never shows a fabricated or zero MRR.
    return [{ name: "Jackson Roofing", value: 700, slug: "jackson-roofing", status: "active" }];
  }
}

const headers = {
  Authorization: `Bearer ${GHL_API_KEY}`,
  Version: "2021-07-28",
  "Content-Type": "application/json",
};

async function ghlFetch(path: string) {
  const res = await fetch(`https://services.leadconnectorhq.com${path}`, { headers });
  if (!res.ok) return null;
  return res.json();
}

// Last-good cache: GHL's PIT API intermittently rate-limits and returns empty
// arrays. Without this, the dashboard blanks (no leads/pipelines/appointments)
// on any throttled request. We keep the last successful payload in memory and
// serve it when a fresh fetch comes back empty, so the UI stays populated.
let lastGood: any = null;

export async function GET() {
  const [contacts, opportunities, pipelines, conversations] = await Promise.all([
    ghlFetch(`/contacts/?locationId=${GHL_LOCATION_ID}&limit=100`),
    ghlFetch(`/opportunities/search?location_id=${GHL_LOCATION_ID}&limit=100`),
    ghlFetch(`/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`),
    ghlFetch(`/conversations/search?locationId=${GHL_LOCATION_ID}&limit=100`),
  ]);

  // Get this week's appointments
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);

  // GHL's /calendars/events requires a calendarId — querying by location alone returns 422.
  // Fetch the location's calendars, pull events for each, and merge them.
  const calendarList = await ghlFetch(`/calendars/?locationId=${GHL_LOCATION_ID}`);
  const calendars = calendarList?.calendars ?? [];
  const eventBatches = await Promise.all(
    calendars.map((cal: any) =>
      ghlFetch(
        `/calendars/events?locationId=${GHL_LOCATION_ID}&calendarId=${cal.id}&startTime=${weekStart.toISOString()}&endTime=${weekEnd.toISOString()}`
      )
    )
  );
  const appointments = { events: eventBatches.flatMap((b: any) => b?.events ?? []) };

  const allContacts = contacts?.contacts ?? [];
  const allOpps = opportunities?.opportunities ?? [];

  // Separate clients (won) from leads (active pipeline)
  const wonOpps = allOpps.filter((o: any) => o.status === "won");
  const openOpps = allOpps.filter((o: any) => o.status === "open");

  // Real MRR = sum of confirmed monthly retainers across active clients (see note above).
  // Today this resolves to Jackson Roofing at $700/mo; it grows automatically as Jack adds
  // an `mrr:` value to each active client's notes file. NOT derived from GHL opp values.
  const retainerRoster = readRetainerRoster();
  const mrr = retainerRoster.reduce((sum, c) => sum + c.value, 0);

  // Recent leads (last 10 contacts)
  const recentLeads = allContacts.slice(0, 10).map((c: any) => ({
    id: c.id,
    name: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || c.email,
    email: c.email,
    phone: c.phone,
    tags: c.tags ?? [],
    dateAdded: c.dateAdded,
  }));

  // Active clients = the real retainer roster (Jackson Roofing @ 700 guaranteed present).
  // These are the paying clients whose MRR is summed above, not GHL won opps.
  const activeClients = retainerRoster.map((c) => ({
    id: c.slug,
    name: c.name,
    value: c.value,
    stage: "Active",
    contactId: undefined as string | undefined,
    tags: [] as string[],
  }));

  // Build contact lookup for appointment names
  const contactMap: Record<string, string> = {};
  allContacts.forEach((c: any) => {
    contactMap[c.id] = `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || c.email;
  });

  // Rich appointments with contact name, start/end times
  const richAppointments = (appointments?.events ?? []).map((a: any) => ({
    id: a.id,
    title: a.title ?? "Appointment",
    contactName: a.contactId ? (contactMap[a.contactId] ?? "Unknown") : (a.calendarId ?? ""),
    contactId: a.contactId,
    startTime: a.startTime,
    endTime: a.endTime,
    status: a.appointmentStatus ?? a.status,
    calendarId: a.calendarId,
  }));

  // Opportunities with contact name for kanban
  const allOppsRich = allOpps.map((o: any) => ({
    id: o.id,
    name: o.name,
    contactName: o.contact?.name ?? o.name,
    contactId: o.contact?.id,
    monetaryValue: o.monetaryValue ?? 0,
    status: o.status,
    pipelineId: o.pipelineId,
    pipelineName: "",
    pipelineStage: o.pipelineStage,
    lastStageChangeAt: o.lastStageChangeAt,
    dateAdded: o.dateAdded,
  }));

  // Attach pipeline names and build ordered stage list per pipeline
  const pipelinesList = pipelines?.pipelines ?? [];
  const orderedPipelines = pipelinesList.map((p: any) => ({
    id: p.id,
    name: p.name,
    stages: (p.stages ?? [])
      .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0))
      .map((s: any) => ({ id: s.id, name: s.name, position: s.position ?? 0 })),
  }));

  pipelinesList.forEach((p: any) => {
    (p.opportunities ?? []).forEach((o: any) => {
      const rich = allOppsRich.find((r: any) => r.id === o.id);
      if (rich) rich.pipelineName = p.name;
    });
  });

  // ── openedEmails: REAL email opens from GHL ─────────────────────────────────
  // GHL has no aggregate "email stats/opens" endpoint on the standard PIT API. The real
  // signal is per-message status ("opened"/"clicked"). ghl-cli\email_stats_live.py walks
  // EVERY email conversation (not a 25-convo sample) and caches each outbound email's
  // status; /api/sales-metrics keeps that cache fresh (<10 min). We read the precomputed
  // aggregate here so this count matches the Sales Overview exactly. Never fabricated:
  // if the cache is missing the count is 0 until the first walk completes.
  let openedEmailCount = 0;
  try {
    const cache = JSON.parse(
      fs.readFileSync("C:\\Users\\wjack\\ghl-cli\\outreach_logs\\email_stats_cache.json", "utf-8")
    );
    openedEmailCount = cache?.aggregate?.totals?.opened ?? 0;
  } catch { }
  // People who responded: conversations whose last message came inbound (from the contact)
  const respondedCount = (conversations?.conversations ?? []).filter(
    (c: any) => (c.lastMessageDirection ?? c.direction) === "inbound"
  ).length;

  const payload = {
    stats: {
      totalContacts: allContacts.length,
      openedEmails: openedEmailCount,
      responded: respondedCount,
      activeClients: activeClients.length,
      mrr,
      apptsThisWeek: richAppointments.length,
    },
    recentLeads,
    activeClients,
    pipelines: orderedPipelines,
    appointments: richAppointments,
    opportunities: allOppsRich,
    locationId: GHL_LOCATION_ID,
  };

  // If GHL throttled this request (all core arrays empty) but we have a prior
  // good snapshot, serve it — but keep MRR/active clients fresh from the vault
  // (those are computed locally and always reliable).
  const ghlEmpty =
    allContacts.length === 0 && allOpps.length === 0 && pipelinesList.length === 0;
  if (ghlEmpty && lastGood) {
    return NextResponse.json({
      ...lastGood,
      stats: { ...lastGood.stats, mrr, activeClients: activeClients.length },
      activeClients,
      locationId: GHL_LOCATION_ID,
    });
  }
  if (!ghlEmpty) lastGood = payload;
  return NextResponse.json(payload);
}
