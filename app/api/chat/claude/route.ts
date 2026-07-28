import { NextRequest, NextResponse } from "next/server";
import { loadPermanentVaultContext } from "@/app/lib/vaultContext";
import { TOOL_DEFINITIONS } from "@/app/api/agents/tools/route";

const ANTHROPIC_TOOLS = TOOL_DEFINITIONS.map(t => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema,
}));

async function executeTool(tool: string, input: any): Promise<string> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"}/api/agents/tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, input }),
  });
  const data = await res.json();
  return JSON.stringify(data);
}

export async function POST(req: NextRequest) {
  const { messages, vaultContext } = await req.json();

  const permanent = await loadPermanentVaultContext();
  const contextParts = [
    permanent ? `### Permanent Context\n${permanent}` : "",
    vaultContext ? `### Attached Notes\n${vaultContext}` : "",
  ].filter(Boolean).join("\n\n---\n\n");

  const system = [
    "You are Claude, the AI assistant inside Jack's Wing Digital OS. Wing Digital is a DFW marketing automation agency for home service businesses. Jack is the owner.",
    "You have tools to interact with GHL CRM and the knowledge vault directly. Use them when Jack asks about contacts, pipeline, or wants you to take action.",
    "When using tools: be proactive — if Jack says 'add that lead' or 'move them to proposal', do it. Confirm what you did after.",
    "Keep responses concise. No em dashes.",
    contextParts ? `\n\nKNOWLEDGE BASE:\n${contextParts}` : "",
  ].join("\n");

  let currentMessages = [...messages];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const toolCallsMade: { tool: string; input: any; result: string }[] = [];
  const MAX_ROUNDS = 5;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system,
        tools: ANTHROPIC_TOOLS,
        messages: currentMessages,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: err }, { status: 500 });
    }

    const data = await res.json();
    totalInputTokens += data.usage?.input_tokens ?? 0;
    totalOutputTokens += data.usage?.output_tokens ?? 0;

    if (data.stop_reason === "refusal") {
      // Whole fallback chain declined — surface it instead of reading empty content
      const cost = (totalInputTokens * 3 + totalOutputTokens * 15) / 1_000_000;
      return NextResponse.json({
        reply: "Request was declined by safety filters. Try rephrasing.",
        cost, toolCalls: toolCallsMade,
      });
    }

    if (data.stop_reason === "end_turn") {
      const reply = data.content.find((b: any) => b.type === "text")?.text ?? "";
      const cost = (totalInputTokens * 3 + totalOutputTokens * 15) / 1_000_000;
      return NextResponse.json({ reply, cost, toolCalls: toolCallsMade });
    }

    if (data.stop_reason === "tool_use") {
      const toolUseBlocks = data.content.filter((b: any) => b.type === "tool_use");
      const toolResults: any[] = [];

      for (const block of toolUseBlocks) {
        const result = await executeTool(block.name, block.input);
        toolCallsMade.push({ tool: block.name, input: block.input, result });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
      }

      // Add assistant turn + tool results to message history
      currentMessages = [
        ...currentMessages,
        { role: "assistant", content: data.content },
        { role: "user", content: toolResults },
      ];
      continue;
    }

    // Unexpected stop reason — return whatever text we have
    const reply = data.content.find((b: any) => b.type === "text")?.text ?? "Done.";
    const cost = (totalInputTokens * 3 + totalOutputTokens * 15) / 1_000_000;
    return NextResponse.json({ reply, cost, toolCalls: toolCallsMade });
  }

  return NextResponse.json({ reply: "Reached tool call limit.", cost: 0, toolCalls: toolCallsMade });
}
