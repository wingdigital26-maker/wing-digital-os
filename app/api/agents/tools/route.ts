import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { VAULT_PATH as VAULT, readVaultFile } from "@/lib/vaultSource";
import { getRevenueTruth } from "@/lib/revenue";

export const runtime = "nodejs";

// GHL retired 2026-08-22. The five CRM tools (search_contacts, get_pipeline,
// move_opportunity, add_contact, add_tag) that called
// services.leadconnectorhq.com were removed, not retargeted: no replacement
// CRM exists yet. When one does, the tools get rebuilt against it.

// Tool definitions — shared between Claude and Groq routes
export const TOOL_DEFINITIONS = [
  {
    name: "get_stats",
    description: "Get current Wing Digital OS stats: MRR, active clients, pipeline (from the local revenue source of truth). No CRM contact counts are available: GHL was retired 2026-08-22 and no replacement is connected.",
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
      case "get_stats": {
        // Revenue and the client count come from lib/revenue.ts, the single
        // source of truth. Contact/opportunity counts used to come from GHL;
        // GHL was retired 2026-08-22, so those figures no longer exist rather
        // than being reported as zero.
        const truth = await getRevenueTruth();
        return NextResponse.json({
          ok: true,
          activeClients: truth.activeClients,
          mrr: truth.mrr,
          mrrBasis: truth.mrrBasisLine,
          pipelineValue: truth.pipelineTotal,
          crm: "No CRM connected. GHL retired 2026-08-22, replacement pending.",
        });
      }

      case "read_vault_note": {
        if (String(input.path).includes("..")) return NextResponse.json({ ok: false, error: "Path not allowed" });
        const content = await readVaultFile(input.path);
        if (content === null) return NextResponse.json({ ok: false, error: "File not found: " + input.path });
        return NextResponse.json({ ok: true, content: content.slice(0, 3000) }); // cap at 3k chars
      }

      case "write_vault_note": {
        if (!input.path.startsWith("wiki/")) return NextResponse.json({ ok: false, error: "Can only write to wiki/ directory" });
        const filePath = path.join(VAULT, input.path.replace(/\//g, "\\"));
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, input.content, "utf-8");
        return NextResponse.json({ ok: true, result: `Written to ${input.path}` });
      }

      // Retired CRM tools: honest error instead of a dead GHL call.
      case "search_contacts":
      case "get_pipeline":
      case "move_opportunity":
      case "add_contact":
      case "add_tag":
        return NextResponse.json({
          ok: false,
          error: "CRM tools retired: GHL retired 2026-08-22, no replacement connected yet.",
        });

      default:
        return NextResponse.json({ ok: false, error: `Unknown tool: ${tool}` });
    }
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message });
  }
}
