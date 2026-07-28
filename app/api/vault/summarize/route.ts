import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { VAULT_PATH as VAULT } from "@/lib/vaultSource";

export const runtime = "nodejs";

const HOT_FILE = path.join(VAULT, "wiki", "hot.md");

export async function POST(req: NextRequest) {
  const { messages, agent } = await req.json();
  if (!messages?.length) return NextResponse.json({ error: "No messages" }, { status: 400 });

  const transcript = messages
    .map((m: any) => `${m.role === "user" ? "Jack" : agent}: ${m.content}`)
    .join("\n");

  // Use Claude to summarize (always reliable, small prompt = cheap)
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      system: "You extract key information from AI chat sessions for a marketing agency owner's knowledge base. Be concise. Output only the summary, no preamble.",
      messages: [{
        role: "user",
        content: `Summarize this chat session. Extract: key decisions made, important information learned, action items, and anything worth remembering long-term. Format as brief bullet points under clear headings.\n\nChat:\n${transcript}`,
      }],
    }),
  });

  if (!res.ok) return NextResponse.json({ error: "Summary failed" }, { status: 500 });

  const data = await res.json();
  const summary = data.content[0].text;
  const date = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  // Read existing hot.md and prepend new summary
  let existing = "";
  try { existing = fs.readFileSync(HOT_FILE, "utf-8"); } catch { }

  const newContent = [
    `# Wing Digital — Hot Cache`,
    `> Last updated: ${new Date().toLocaleString()}`,
    "",
    `## ${agent} Session — ${date}`,
    summary,
    "",
    "---",
    "",
    existing.replace(/^# Wing Digital[\s\S]*?\n---\n\n/, "").trim(),
  ].join("\n");

  fs.mkdirSync(path.dirname(HOT_FILE), { recursive: true });
  fs.writeFileSync(HOT_FILE, newContent, "utf-8");

  // Calculate cost (tiny)
  const inputTokens = data.usage?.input_tokens ?? 0;
  const outputTokens = data.usage?.output_tokens ?? 0;
  const cost = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  return NextResponse.json({ ok: true, summary, cost });
}
