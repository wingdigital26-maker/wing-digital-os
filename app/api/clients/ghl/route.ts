import { NextResponse } from "next/server";
import fs from "fs";

// Per-client GHL snapshot. Reads the client's Private Integration Token from the
// ghl-cli .env (the single source of truth for secrets) by slug, so no per-client
// tokens need to be copied into the OS. The token never leaves the server.
const GHL_ENV = "C:\\Users\\wjack\\ghl-cli\\.env";

function pitForSlug(slug: string): string | null {
  // jackson-roofing -> GHL_JACKSON_ROOFING_PIT
  const varName = "GHL_" + slug.toUpperCase().replace(/-/g, "_") + "_PIT";
  // Prefer a real environment variable (works on Vercel / any cloud host);
  // fall back to the local ghl-cli/.env file when running on Jack's laptop.
  if (process.env[varName]) return String(process.env[varName]).trim().replace(/^["']|["']$/g, "");
  try {
    const env = fs.readFileSync(GHL_ENV, "utf-8");
    const m = env.match(new RegExp("^" + varName + "=(.+)$", "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
  } catch {
    return null;
  }
}

async function ghl(base: string, pit: string, path: string) {
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { Authorization: `Bearer ${pit}`, Version: "2021-07-28" },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("slug") ?? "";
  const loc = searchParams.get("loc") ?? "";
  if (!slug || !loc) return NextResponse.json({ available: false });

  const pit = pitForSlug(slug);
  if (!pit) return NextResponse.json({ available: false });

  const base = "https://services.leadconnectorhq.com";
  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 864e5);

  const [contacts, opps, convos, calList] = await Promise.all([
    ghl(base, pit, `/contacts/?locationId=${loc}&limit=1`),
    ghl(base, pit, `/opportunities/search?location_id=${loc}&limit=100`),
    ghl(base, pit, `/conversations/search?locationId=${loc}&limit=1`),
    ghl(base, pit, `/calendars/?locationId=${loc}`),
  ]);

  // Events require a calendarId (location-only returns 422); pull per calendar and merge.
  const calendars = calList?.calendars ?? [];
  const apptBatches = await Promise.all(
    calendars.map((cal: any) =>
      ghl(base, pit, `/calendars/events?locationId=${loc}&calendarId=${cal.id}&startTime=${now.toISOString()}&endTime=${in30.toISOString()}`)
    )
  );
  const upcomingAppts = apptBatches.reduce((n: number, b: any) => n + (b?.events?.length ?? 0), 0);

  const oppList = opps?.opportunities ?? [];
  const openDeals = oppList.filter((o: any) => o.status === "open").length;

  return NextResponse.json({
    available: true,
    contacts: contacts?.meta?.total ?? 0,
    openDeals,
    pipelineValue: oppList.reduce((s: number, o: any) => s + (o.monetaryValue || 0), 0),
    conversations: convos?.total ?? convos?.conversations?.length ?? 0,
    upcomingAppts,
  });
}
