import { NextResponse } from "next/server";
import {
  getOsSession,
  hasLegacyAuth,
  sbSelect,
  sbInsert,
  sbUrl,
  sbService,
} from "@/lib/osSupabase";

export const runtime = "nodejs";

// The Wing Digital OS "brain": chat grounded in the Supabase vault_docs, with
// saved history in chat_sessions / chat_messages. Free model via Groq.
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const CONTEXT_CHAR_BUDGET = 8000;
const SYSTEM_PROMPT =
  "You are the Wing Digital OS brain. Answer using the provided vault context. " +
  "If the answer isn't in context, say so plainly. Be concise and practical. No em dashes.";

type VaultDoc = { title: string; content: string; folder?: string };
type ChatMessage = { role: string; content: string };

// Pull the ~6 most relevant vault_docs for the query. Tries Postgres full-text
// (websearch_to_tsquery) first, then falls back to a broad ilike OR scan.
async function retrieveContext(message: string): Promise<VaultDoc[]> {
  const terms = message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 8);

  // Full-text search on the `content` column (requires a tsvector-capable setup;
  // websearch works against a text column via to_tsvector at query time only if a
  // computed/index column exists, so we guard with a fallback).
  let docs = await sbSelect<VaultDoc>({
    table: "vault_docs",
    select: "title,content,folder",
    query: `content=wfts.${encodeURIComponent(message.slice(0, 200))}&limit=6`,
    service: true,
  });

  if (docs.length === 0 && terms.length) {
    const orExpr = terms
      .map((t) => `content.ilike.*${t}*,title.ilike.*${t}*`)
      .join(",");
    docs = await sbSelect<VaultDoc>({
      table: "vault_docs",
      select: "title,content,folder",
      query: `or=(${encodeURIComponent(orExpr)})&limit=6`,
      service: true,
    });
  }

  // Last resort: newest docs so the model has *something* grounded.
  if (docs.length === 0) {
    docs = await sbSelect<VaultDoc>({
      table: "vault_docs",
      select: "title,content,folder",
      query: "limit=6",
      service: true,
    });
  }
  return docs;
}

function buildContextBlock(docs: VaultDoc[]): string {
  const chunks: string[] = [];
  let used = 0;
  for (const d of docs) {
    const body = (d.content ?? "").trim();
    if (!body) continue;
    const remaining = CONTEXT_CHAR_BUDGET - used;
    if (remaining <= 200) break;
    const slice = body.slice(0, Math.min(remaining, 2000));
    const block = `### ${d.title ?? "Untitled"}\n${slice}`;
    chunks.push(block);
    used += block.length;
  }
  return chunks.join("\n\n");
}

export async function POST(req: Request) {
  const session = await getOsSession();
  const legacy = await hasLegacyAuth();
  if (!session && !legacy) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    return NextResponse.json(
      { error: "GROQ_API_KEY not configured" },
      { status: 503 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    message?: string;
    sessionId?: string;
  };
  const message = (body.message ?? "").trim();
  if (!message) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  // user_id: real session sub when available; legacy password access has none.
  const userId = session?.sub || null;

  // 1. Retrieve vault context.
  const docs = await retrieveContext(message);
  const contextBlock = buildContextBlock(docs);

  // 2. Load prior turns for this session (oldest -> newest).
  let priorTurns: ChatMessage[] = [];
  let sessionId = body.sessionId;
  if (sessionId) {
    priorTurns = await sbSelect<ChatMessage>({
      table: "chat_messages",
      select: "role,content,created_at",
      query: `session_id=eq.${sessionId}&order=created_at.asc&limit=40`,
      service: true,
    });
  }

  // 3. Build the Groq message array.
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "system",
      content: contextBlock
        ? `Vault context:\n\n${contextBlock}`
        : "Vault context: (no relevant vault pages found)",
    },
    ...priorTurns.map((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: message },
  ];

  // 4. Call Groq.
  let answer = "";
  try {
    const r = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        temperature: 0.4,
        max_tokens: 1200,
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return NextResponse.json(
        { error: "model call failed", detail: detail.slice(0, 300) },
        { status: 502 }
      );
    }
    const data = await r.json();
    answer = data.choices?.[0]?.message?.content?.trim() ?? "";
  } catch {
    return NextResponse.json({ error: "model call failed" }, { status: 502 });
  }
  if (!answer) answer = "I could not generate a response.";

  // 5. Persist session + messages (service key, stamped with the real user_id).
  // Only when Supabase is configured; if not, still return the answer.
  if (sbUrl() && sbService()) {
    if (!sessionId) {
      const title = message.split(/\s+/).slice(0, 6).join(" ").slice(0, 80);
      const created = await sbInsert<{ id: string }>("chat_sessions", {
        user_id: userId,
        title: title || "New chat",
      });
      sessionId = created?.id;
    }
    if (sessionId) {
      await sbInsert("chat_messages", {
        session_id: sessionId,
        user_id: userId,
        role: "user",
        content: message,
        model: GROQ_MODEL,
      });
      await sbInsert("chat_messages", {
        session_id: sessionId,
        user_id: userId,
        role: "assistant",
        content: answer,
        model: GROQ_MODEL,
      });
    }
  }

  return NextResponse.json({ answer, sessionId: sessionId ?? null });
}
