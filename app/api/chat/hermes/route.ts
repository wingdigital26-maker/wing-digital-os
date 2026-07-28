import { NextRequest, NextResponse } from "next/server";
import { loadPermanentVaultContext } from "@/app/lib/vaultContext";
import { TOOL_DEFINITIONS } from "@/app/api/agents/tools/route";

// Convert to OpenAI function calling format for Groq
const GROQ_TOOLS = TOOL_DEFINITIONS.map(t => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  },
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

  const systemContent = [
    "You are Groq, the fast AI inside Jack's Wing Digital OS, powered by Llama 3.3 70B. Wing Digital is a DFW marketing automation agency for home service businesses. Jack is the owner.",
    "You have tools to interact with GHL CRM and the knowledge vault. Use them when Jack wants to look up contacts, check the pipeline, add leads, or take action. IMPORTANT: Only call one tool at a time. Always use valid JSON arguments.",
    "Be fast and direct. Confirm actions after doing them. No em dashes.",
    contextParts ? `\n\nKNOWLEDGE BASE:\n${contextParts}` : "",
  ].join("\n");

  let currentMessages = [
    { role: "system", content: systemContent },
    ...messages,
  ];

  const toolCallsMade: { tool: string; input: any; result: string }[] = [];
  const MAX_ROUNDS = 5;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY!}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: currentMessages,
        tools: GROQ_TOOLS,
        tool_choice: "auto",
        max_tokens: 1024,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      let errJson: any = {};
      try { errJson = JSON.parse(errText); } catch {}
      // Groq tool_use_failed: model generated malformed function call — retry without tools
      if (errJson?.error?.code === "tool_use_failed") {
        const fallback = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY!}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: currentMessages, max_tokens: 1024 }),
        });
        const fb = await fallback.json();
        const reply = fb.choices?.[0]?.message?.content ?? "Done.";
        return NextResponse.json({ reply, cost: 0, toolCalls: toolCallsMade });
      }
      return NextResponse.json({ error: errText }, { status: 500 });
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    const message = choice?.message;

    if (choice?.finish_reason === "tool_calls" && message?.tool_calls?.length) {
      const assistantMessage = { role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls };
      const toolResultMessages: any[] = [];

      for (const toolCall of message.tool_calls) {
        const toolName = toolCall.function.name;
        const toolInput = JSON.parse(toolCall.function.arguments ?? "{}");
        const result = await executeTool(toolName, toolInput);
        toolCallsMade.push({ tool: toolName, input: toolInput, result });
        toolResultMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }

      currentMessages = [...currentMessages, assistantMessage, ...toolResultMessages];
      continue;
    }

    // Final response
    const reply = message?.content ?? "Done.";
    return NextResponse.json({ reply, cost: 0, toolCalls: toolCallsMade });
  }

  return NextResponse.json({ reply: "Reached tool call limit.", cost: 0, toolCalls: toolCallsMade });
}
