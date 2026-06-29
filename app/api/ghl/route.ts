import { NextResponse } from "next/server";

const GHL_API_KEY = process.env.GHL_API_KEY!;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID!;

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

export async function GET() {
  const [contacts, opportunities, pipelines] = await Promise.all([
    ghlFetch(`/contacts/?locationId=${GHL_LOCATION_ID}&limit=100`),
    ghlFetch(`/opportunities/search?location_id=${GHL_LOCATION_ID}&limit=100`),
    ghlFetch(`/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`),
  ]);

  // Get this week's appointments
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);

  const appointments = await ghlFetch(
    `/calendars/events?locationId=${GHL_LOCATION_ID}&startTime=${weekStart.toISOString()}&endTime=${weekEnd.toISOString()}`
  );

  const allContacts = contacts?.contacts ?? [];
  const allOpps = opportunities?.opportunities ?? [];

  // Separate clients (won) from leads (active pipeline)
  const wonOpps = allOpps.filter((o: any) => o.status === "won");
  const openOpps = allOpps.filter((o: any) => o.status === "open");

  // MRR from won opportunities (using monetary value field)
  const mrr = wonOpps.reduce((sum: number, o: any) => sum + (o.monetaryValue ?? 0), 0);

  // Recent leads (last 10 contacts)
  const recentLeads = allContacts.slice(0, 10).map((c: any) => ({
    id: c.id,
    name: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || c.email,
    email: c.email,
    phone: c.phone,
    tags: c.tags ?? [],
    dateAdded: c.dateAdded,
  }));

  // Active clients from won opps
  const activeClients = wonOpps.slice(0, 10).map((o: any) => ({
    id: o.id,
    name: o.name,
    value: o.monetaryValue ?? 0,
    stage: o.pipelineStage?.name ?? "Active",
  }));

  return NextResponse.json({
    stats: {
      totalContacts: allContacts.length,
      openLeads: openOpps.length,
      activeClients: wonOpps.length,
      mrr,
      apptsThisWeek: appointments?.events?.length ?? 0,
    },
    recentLeads,
    activeClients,
    pipelines: pipelines?.pipelines ?? [],
  });
}
