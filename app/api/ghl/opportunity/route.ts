import { NextRequest, NextResponse } from "next/server";

const GHL_API_KEY = process.env.GHL_API_KEY!;

const headers = {
  Authorization: `Bearer ${GHL_API_KEY}`,
  Version: "2021-07-28",
  "Content-Type": "application/json",
};

export async function PATCH(req: NextRequest) {
  const body = await req.json();
  const { opportunityId, status, pipelineStageId, name, monetaryValue } = body;

  if (!opportunityId) {
    return NextResponse.json({ error: "opportunityId required" }, { status: 400 });
  }

  const payload: Record<string, any> = {};
  if (status) payload.status = status;
  if (pipelineStageId) payload.pipelineStageId = pipelineStageId;
  if (name) payload.name = name;
  if (monetaryValue !== undefined) payload.monetaryValue = monetaryValue;

  const res = await fetch(`https://services.leadconnectorhq.com/opportunities/${opportunityId}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    return NextResponse.json({ error: err }, { status: res.status });
  }

  const data = await res.json();
  return NextResponse.json({ ok: true, opportunity: data.opportunity });
}

// POST — create a new opportunity
export async function POST(req: NextRequest) {
  const body = await req.json();
  const res = await fetch("https://services.leadconnectorhq.com/opportunities/", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) return NextResponse.json({ error: await res.text() }, { status: res.status });
  return NextResponse.json(await res.json());
}
