import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const GHL_KEY = process.env.GHL_API_KEY!;
const GHL_LOC = process.env.GHL_LOCATION_ID!;
const VAULT = "C:\\Users\\wjack\\OneDrive\\Documentos\\Obsidian 2.0\\Jacks Ai Brain 2.0";

const GHL_HEADERS = {
  Authorization: `Bearer ${GHL_KEY}`,
  Version: "2021-07-28",
  "Content-Type": "application/json",
};

async function ghl(path: string, opts?: RequestInit) {
  const res = await fetch(`https://services.leadconnectorhq.com${path}`, { headers: GHL_HEADERS, ...opts });
  if (!res.ok) return { error: await res.text() };
  return res.json();
}

// Tool definitions — shared between Claude and Groq routes
export const TOOL_DEFINITIONS = [
  {
    name: "search_contacts",
    description: "Search GHL CRM contacts by name, email, or phone. Use this to look up any prospect or client.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name, email, or phone number to search for" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_pipeline",
    description: "Get all open opportunities in the GHL sales pipeline with their current stages and values. Use this to check where prospects are.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "move_opportunity",
    description: "Move a GHL opportunity to a different pipeline stage. You must know the opportunity ID and stage ID — get them from get_pipeline first.",
    input_schema: {
      type: "object",
      properties: {
        opportunity_id: { type: "string", description: "The GHL opportunity ID" },
        pipeline_stage_id: { type: "string", description: "The target pipeline stage ID" },
        stage_name: { type: "string", description: "Human-readable stage name for confirmation" },
      },
      required: ["opportunity_id", "pipeline_stage_id"],
    },
  },
  {
    name: "add_contact",
    description: "Add a new contact to GHL CRM. Use this when Jack wants to add a lead or prospect.",
    input_schema: {
      type: "object",
      properties: {
        first_name: { type: "string" },
        last_name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        tags: { type: "array", items: { type: "string" }, description: "e.g. ['roofing', 'hot-lead']" },
      },
      required: ["first_name"],
    },
  },
  {
    name: "add_tag",
    description: "Add a tag to an existing GHL contact by their contact ID.",
    input_schema: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["contact_id", "tags"],
    },
  },
  {
    name: "get_stats",
    description: "Get current Wing Digital OS stats: total contacts, MRR, open pipeline count, active clients.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "read_vault_note",
    description: "Read a note from the Wing Digital knowledge vault. Use relative paths like wiki/clients/charles-palma.md or wiki/index.md.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the vault file, e.g. wiki/clients/charles-palma.md" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_vault_note",
    description: "Write or update a note in the Wing Digital knowledge vault. Only write to wiki/ — never raw/.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path, must start with wiki/" },
        content: { type: "string", description: "Full markdown content to write" },
      },
      required: ["path", "content"],
    },
  },
];

export async function POST(req: NextRequest) {
  const { tool, input } = await req.json();

  try {
    switch (tool) {
      case "search_contacts": {
        const data = await ghl(`/contacts/search?locationId=${GHL_LOC}&query=${encodeURIComponent(input.query)}&limit=5`);
        const contacts = (data.contacts ?? []).map((c: any) => ({
          id: c.id,
          name: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim(),
          email: c.email,
          phone: c.phone,
          tags: c.tags ?? [],
          dateAdded: c.dateAdded,
        }));
        return NextResponse.json({ ok: true, contacts, count: contacts.length });
      }

      case "get_pipeline": {
        const [opps, pipelines] = await Promise.all([
          ghl(`/opportunities/search?location_id=${GHL_LOC}&limit=50&status=open`),
          ghl(`/opportunities/pipelines?locationId=${GHL_LOC}`),
        ]);
        const stageMap: Record<string, string> = {};
        for (const p of pipelines?.pipelines ?? []) {
          for (const s of p.stages ?? []) stageMap[s.id] = s.name;
        }
        const opportunities = (opps?.opportunities ?? []).map((o: any) => ({
          id: o.id,
          name: o.name,
          contactName: o.contact?.name ?? o.name,
          stage: o.pipelineStage?.name ?? "Unknown",
          stageId: o.pipelineStage?.id,
          value: o.monetaryValue ?? 0,
          pipelineId: o.pipelineId,
          status: o.status,
        }));
        const piplineStages = (pipelines?.pipelines?.[0]?.stages ?? [])
          .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0))
          .map((s: any) => ({ id: s.id, name: s.name }));
        return NextResponse.json({ ok: true, opportunities, stages: piplineStages });
      }

      case "move_opportunity": {
        const res = await ghl(`/opportunities/${input.opportunity_id}`, {
          method: "PUT",
          body: JSON.stringify({ pipelineStageId: input.pipeline_stage_id }),
        });
        return NextResponse.json({ ok: !res.error, result: res.error ?? `Moved to "${input.stage_name}"` });
      }

      case "add_contact": {
        const body: any = {
          locationId: GHL_LOC,
          firstName: input.first_name,
          lastName: input.last_name ?? "",
          email: input.email ?? "",
          phone: input.phone ?? "",
          tags: input.tags ?? [],
        };
        const res = await ghl("/contacts/", { method: "POST", body: JSON.stringify(body) });
        return NextResponse.json({ ok: !res.error, contactId: res.contact?.id, result: res.error ?? "Contact added to GHL" });
      }

      case "add_tag": {
        const res = await ghl(`/contacts/${input.contact_id}/tags`, {
          method: "POST",
          body: JSON.stringify({ tags: input.tags }),
        });
        return NextResponse.json({ ok: !res.error, result: res.error ?? `Tags added: ${input.tags.join(", ")}` });
      }

      case "get_stats": {
        const [contacts, opps] = await Promise.all([
          ghl(`/contacts/?locationId=${GHL_LOC}&limit=1`),
          ghl(`/opportunities/search?location_id=${GHL_LOC}&limit=100`),
        ]);
        const allOpps = opps?.opportunities ?? [];
        const won = allOpps.filter((o: any) => o.status === "won");
        const open = allOpps.filter((o: any) => o.status === "open");
        const mrr = won.reduce((s: number, o: any) => s + (o.monetaryValue ?? 0), 0);
        return NextResponse.json({
          ok: true,
          totalContacts: contacts?.total ?? 0,
          activeClients: won.length,
          openOpportunities: open.length,
          mrr,
          pipelineValue: open.reduce((s: number, o: any) => s + (o.monetaryValue ?? 0), 0),
        });
      }

      case "read_vault_note": {
        const filePath = path.join(VAULT, input.path.replace(/\//g, "\\"));
        if (!filePath.startsWith(VAULT)) return NextResponse.json({ ok: false, error: "Path not allowed" });
        if (!fs.existsSync(filePath)) return NextResponse.json({ ok: false, error: "File not found: " + input.path });
        const content = fs.readFileSync(filePath, "utf-8");
        return NextResponse.json({ ok: true, content: content.slice(0, 3000) }); // cap at 3k chars
      }

      case "write_vault_note": {
        if (!input.path.startsWith("wiki/")) return NextResponse.json({ ok: false, error: "Can only write to wiki/ directory" });
        const filePath = path.join(VAULT, input.path.replace(/\//g, "\\"));
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, input.content, "utf-8");
        return NextResponse.json({ ok: true, result: `Written to ${input.path}` });
      }

      default:
        return NextResponse.json({ ok: false, error: `Unknown tool: ${tool}` });
    }
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message });
  }
}
