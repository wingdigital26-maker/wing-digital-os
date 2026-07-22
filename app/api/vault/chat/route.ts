import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const VAULT = "C:\\Users\\wjack\\OneDrive\\Documentos\\Obsidian 2.0\\Jacks Ai Brain 2.0";
const ALLOWED = ["wiki/chat-claude.md", "wiki/chat-groq.md"];

function filePath(agent: string): string | null {
  const file = `wiki/chat-${agent}.md`;
  return ALLOWED.includes(file) ? path.join(VAULT, file) : null;
}

export async function GET(req: NextRequest) {
  const agent = req.nextUrl.searchParams.get("agent");
  const fp = agent ? filePath(agent) : null;
  if (!fp) return NextResponse.json({ messages: [] });

  try {
    const raw = fs.readFileSync(fp, "utf-8");
    const messages = JSON.parse(raw.match(/```json\n([\s\S]*?)\n```/)?.[1] ?? "[]");
    return NextResponse.json({ messages });
  } catch {
    return NextResponse.json({ messages: [] });
  }
}

export async function POST(req: NextRequest) {
  const { agent, messages } = await req.json();
  const fp = agent ? filePath(agent) : null;
  if (!fp || !Array.isArray(messages)) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const capped = messages.slice(-50);
  const agentLabel = agent === "claude" ? "Claude" : "Groq";
  const content = [
    `# ${agentLabel} Chat History`,
    `> Auto-saved by Wing Digital OS. Last updated: ${new Date().toLocaleString()}`,
    `> ${capped.length} messages stored (max 50).`,
    "",
    "```json",
    JSON.stringify(capped, null, 2),
    "```",
  ].join("\n");

  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content, "utf-8");
  return NextResponse.json({ ok: true, count: capped.length });
}
