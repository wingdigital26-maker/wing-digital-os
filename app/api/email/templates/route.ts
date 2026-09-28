import { NextResponse } from "next/server";
import { instantlyKey, fetchCampaign, fetchCampaigns, htmlToText } from "@/lib/instantly";

// ───────────────────────────────────────────────────────────────────────────
// GET /api/email/templates — the copy the composer can start from.
//
// There is no template table in this repo and inventing one would mean the
// composer offered copy nobody ever approved. So the templates are the REAL
// steps of the real campaigns: each variant of each step of each campaign the
// sender is running, subject and body, exactly as it goes out.
//
// If the sender is unreachable the route says so and returns no templates.
// An empty picker with a reason beats a picker full of invented copy.
//
// Read-only. Session-gated by middleware like every /api/* route.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Template = {
  id: string;
  /** "<campaign> — Step 2" */
  name: string;
  campaign: string;
  step: number;
  subject: string;
  body: string;
};

export async function GET() {
  const key = instantlyKey();
  if (!key) {
    return NextResponse.json({
      templates: [],
      available: false,
      reason: "INSTANTLY_API_KEY is not set on this deployment, so the campaign copy cannot be read.",
    });
  }

  // The campaign roster first, then each campaign's sequence.
  const list = await fetchCampaigns();
  if (!list.ok) {
    return NextResponse.json({
      templates: [], available: false,
      reason: `The campaign list could not be read (${list.reason}), so no saved copy is available to start from.`,
    });
  }
  const ids = list.data
    .filter((c) => Boolean(c.id))
    .map((c) => ({ id: c.id, name: c.name ?? c.id }));

  const templates: Template[] = [];
  const notes: string[] = [];
  for (const c of ids) {
    const res = await fetchCampaign(c.id);
    if (!res.ok) {
      notes.push(`Copy for "${c.name}" could not be read (${res.reason}).`);
      continue;
    }
    const steps = res.data.sequences?.[0]?.steps ?? [];
    steps.forEach((s, si) => {
      (s.variants ?? []).forEach((v, vi) => {
        const subject = (v.subject ?? "").trim();
        const body = htmlToText(v.body ?? "").trim();
        if (!subject && !body) return;
        templates.push({
          id: `${c.id}:${si}:${vi}`,
          name: `${c.name} — Step ${si + 1}${(s.variants?.length ?? 1) > 1 ? ` (variant ${vi + 1})` : ""}`,
          campaign: c.name,
          step: si + 1,
          subject,
          body,
        });
      });
    });
  }

  return NextResponse.json({
    templates,
    available: true,
    reason: null,
    note: notes.length ? notes.join(" ") : null,
    emptyNote: templates.length === 0
      ? "No campaign has any sequence copy saved yet, so there is nothing to start from. Write the email from scratch."
      : null,
  });
}
