import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// ── Jackson Roofing client-facing dashboard data endpoint ────────────────────
// SECURITY: This route ONLY ever talks to Jackson Roofing's GHL sub-account.
//  - The Private Integration Token (PIT) is read server-side from ghl-cli/.env and
//    is NEVER included in the JSON response, so it can never reach the browser.
//  - The location id is hard-pinned to Jackson's sub-account. We never accept a
//    location id from the request, so no other client's data is reachable here.
//  - READ ONLY. This route only issues GET requests to GHL — it never writes,
//    sends, or triggers anything.

const JACKSON_LOCATION_ID = "T2HknbMbA9IJ3qFGLm1G";

// Resolve Jackson's PIT from the shared ghl-cli/.env WITHOUT hardcoding the token.
// Prefer a real environment variable if present; otherwise parse the .env file.
function getJacksonPit(): string | null {
  if (process.env.GHL_JACKSON_ROOFING_PIT) return process.env.GHL_JACKSON_ROOFING_PIT;
  const candidates = [
    "C:\\Users\\wjack\\ghl-cli\\.env",
    path.join(process.cwd(), "..", "ghl-cli", ".env"),
  ];
  for (const p of candidates) {
    try {
      const text = fs.readFileSync(p, "utf-8");
      const m = text.match(/^\s*GHL_JACKSON_ROOFING_PIT\s*=\s*(.+)\s*$/m);
      if (m) return m[1].trim();
    } catch {
      /* try next path */
    }
  }
  return null;
}

const BASE = "https://services.leadconnectorhq.com";

function makeFetcher(pit: string) {
  const headers = {
    Authorization: `Bearer ${pit}`,
    Version: "2021-07-28",
    "Content-Type": "application/json",
  };
  return async function ghlFetch(pathAndQuery: string): Promise<any | null> {
    try {
      const res = await fetch(`${BASE}${pathAndQuery}`, { headers, cache: "no-store" });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  };
}

export async function GET() {
  const pit = getJacksonPit();
  if (!pit) {
    return NextResponse.json(
      { error: "Jackson Roofing credentials unavailable on the server." },
      { status: 500 }
    );
  }

  const ghlFetch = makeFetcher(pit);
  const LOC = JACKSON_LOCATION_ID;

  const [contactsRes, pipelinesRes, oppsRes, conversationsRes, calendarsRes] =
    await Promise.all([
      ghlFetch(`/contacts/?locationId=${LOC}&limit=100`),
      ghlFetch(`/opportunities/pipelines?locationId=${LOC}`),
      ghlFetch(`/opportunities/search?location_id=${LOC}&limit=100`),
      ghlFetch(`/conversations/search?locationId=${LOC}&limit=50`),
      ghlFetch(`/calendars/?locationId=${LOC}`),
    ]);

  const allContacts: any[] = contactsRes?.contacts ?? [];
  const totalContacts: number = contactsRes?.meta?.total ?? allContacts.length;
  const allOpps: any[] = oppsRes?.opportunities ?? [];
  const pipelinesList: any[] = pipelinesRes?.pipelines ?? [];
  const calendars: any[] = calendarsRes?.calendars ?? [];

  // ── Appointments ───────────────────────────────────────────────────────────
  // KNOWN GHL QUIRK: /calendars/events with ISO-8601 startTime/endTime returns an
  // empty events array (the "date-filtered appointment 404/empty" issue). The
  // endpoint only returns data when startTime/endTime are EPOCH MILLISECONDS and a
  // calendarId is supplied. We fetch per-calendar with epoch-ms bounds and merge.
  const nowMs = Date.now();
  const startMs = nowMs - 86400000 * 7; // include the last week for context
  const endMs = nowMs + 86400000 * 60; // next 60 days of upcoming appointments

  let appointmentsAvailable = true;
  const eventBatches = await Promise.all(
    calendars.map((cal: any) =>
      ghlFetch(
        `/calendars/events?locationId=${LOC}&calendarId=${cal.id}&startTime=${startMs}&endTime=${endMs}`
      )
    )
  );
  if (calendars.length > 0 && eventBatches.every((b) => b === null)) {
    appointmentsAvailable = false;
  }
  const calendarNameById: Record<string, string> = {};
  calendars.forEach((c: any) => (calendarNameById[c.id] = c.name));

  // Contact name lookup for enriching appointments
  const contactMap: Record<string, string> = {};
  allContacts.forEach((c: any) => {
    contactMap[c.id] =
      c.contactName ||
      `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() ||
      c.email ||
      "Contact";
  });

  const allEvents = eventBatches.flatMap((b: any) => b?.events ?? []);
  const upcomingAppointments = allEvents
    .map((a: any) => ({
      id: a.id,
      title: a.title || "Appointment",
      contactName: a.contactId ? contactMap[a.contactId] ?? a.title ?? "Contact" : a.title ?? "Contact",
      calendarName: calendarNameById[a.calendarId] ?? "Calendar",
      startTime: a.startTime,
      endTime: a.endTime,
      status: a.appointmentStatus ?? a.appoinmentStatus ?? a.status ?? "",
    }))
    .filter((a: any) => a.startTime && new Date(a.startTime).getTime() >= nowMs - 3600000)
    .sort((a: any, b: any) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

  // ── Pipeline (Marketing Pipeline) ────────────────────────────────────────────
  const marketingPipeline =
    pipelinesList.find((p: any) => /marketing/i.test(p.name)) ?? pipelinesList[0];

  const orderedStages: { id: string; name: string; position: number }[] = (
    marketingPipeline?.stages ?? []
  )
    .slice()
    .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0))
    .map((s: any) => ({ id: s.id, name: s.name, position: s.position ?? 0 }));

  const pipelineOpps = allOpps.filter(
    (o: any) => !marketingPipeline || o.pipelineId === marketingPipeline.id
  );

  const stageSummary = orderedStages.map((stage) => {
    const inStage = pipelineOpps.filter(
      (o: any) => (o.pipelineStageId ?? o.pipelineStage?.id) === stage.id
    );
    return {
      id: stage.id,
      name: stage.name,
      count: inStage.length,
      value: inStage.reduce((sum: number, o: any) => sum + (o.monetaryValue ?? 0), 0),
    };
  });

  const wonOpps = allOpps.filter((o: any) => o.status === "won");
  const openOpps = allOpps.filter((o: any) => o.status === "open");
  const pipelineValue = openOpps.reduce(
    (sum: number, o: any) => sum + (o.monetaryValue ?? 0),
    0
  );
  const wonValue = wonOpps.reduce((sum: number, o: any) => sum + (o.monetaryValue ?? 0), 0);

  // ── New leads this month ─────────────────────────────────────────────────────
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const newLeadsThisMonth = allContacts.filter(
    (c: any) => c.dateAdded && new Date(c.dateAdded).getTime() >= monthStart
  ).length;

  // ── Recent leads ──────────────────────────────────────────────────────────────
  const recentLeads = allContacts
    .slice()
    .sort(
      (a: any, b: any) =>
        new Date(b.dateAdded ?? 0).getTime() - new Date(a.dateAdded ?? 0).getTime()
    )
    .slice(0, 10)
    .map((c: any) => ({
      id: c.id,
      name:
        c.contactName ||
        `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() ||
        c.email ||
        "New Contact",
      source: c.source || (c.tags && c.tags[0]) || "Direct",
      tags: c.tags ?? [],
      dateAdded: c.dateAdded,
    }));

  // ── Recent activity (conversations / outreach) ───────────────────────────────
  const conversations: any[] = conversationsRes?.conversations ?? [];
  const recentActivity = conversations
    .slice()
    .sort((a: any, b: any) => (b.lastMessageDate ?? 0) - (a.lastMessageDate ?? 0))
    .slice(0, 12)
    .map((c: any) => ({
      id: c.id,
      contactName: c.contactId ? contactMap[c.contactId] ?? c.fullName ?? "Contact" : c.fullName ?? "Contact",
      type: (c.lastMessageType ?? "").replace("TYPE_", ""),
      direction: c.lastMessageDirection ?? "outbound",
      body: c.lastMessageBody ?? "",
      date: c.lastMessageDate ?? c.dateUpdated ?? null,
    }));

  // messagesReceived: real inbound replies (last message came from the contact).
  const messagesReceived = conversations.filter(
    (c: any) => (c.lastMessageDirection ?? "") === "inbound"
  ).length;

  // ── Emails sent (HONEST count) ───────────────────────────────────────────────
  // We must NOT derive "emails sent" from conversations-with-outbound-last-message:
  // that fetch is capped at 50 conversations AND drops to ~0 as replies/newer
  // messages become the last message, so it structurally undercounts real sends.
  // The outreach workflow emails every contact carrying the 'jackson-commercial-cold'
  // tag, so the count of tagged contacts is the truthful floor of prospects emailed.
  const emailedContacts = allContacts.filter((c: any) =>
    (c.tags ?? []).includes("jackson-commercial-cold")
  ).length;
  // Outbound conversations still observed (cross-check / lower bound).
  const outboundConversations = conversations.filter(
    (c: any) => (c.lastMessageDirection ?? "outbound") === "outbound"
  ).length;
  const messagesSent = Math.max(emailedContacts, outboundConversations);

  return NextResponse.json({
    updatedAt: new Date().toISOString(),
    stats: {
      totalLeads: totalContacts,
      newLeadsThisMonth,
      upcomingAppointments: upcomingAppointments.length,
      openOpportunities: openOpps.length,
      pipelineValue,
      wonCount: wonOpps.length,
      wonValue,
    },
    pipeline: {
      name: marketingPipeline?.name ?? "Pipeline",
      stages: stageSummary,
    },
    appointments: upcomingAppointments.slice(0, 8),
    appointmentsAvailable,
    recentLeads,
    recentActivity,
    outreach: { messagesSent, messagesReceived, contactsInOutreach: emailedContacts },
    calendars: calendars.map((c: any) => ({ id: c.id, name: c.name })),
  });
}
