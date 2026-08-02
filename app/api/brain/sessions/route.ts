import { NextResponse } from "next/server";
import { getOsSession, hasLegacyAuth, sbSelect } from "@/lib/osSupabase";

export const runtime = "nodejs";

// GET /api/brain/sessions            -> the caller's chat_sessions (newest first)
// GET /api/brain/sessions?id=<uuid>  -> the messages for one session (oldest first)
export async function GET(req: Request) {
  const session = await getOsSession();
  const legacy = await hasLegacyAuth();
  if (!session && !legacy) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (id) {
    const messages = await sbSelect({
      table: "chat_messages",
      select: "id,role,content,model,created_at",
      query: `session_id=eq.${id}&order=created_at.asc&limit=200`,
      service: true,
    });
    return NextResponse.json({ messages });
  }

  // List sessions. Scope to the caller's user_id when we have a real session;
  // legacy password access (no user id) sees the shared/staff sessions.
  const scope = session?.sub
    ? `user_id=eq.${session.sub}&`
    : "";
  const sessions = await sbSelect({
    table: "chat_sessions",
    select: "id,title,created_at",
    query: `${scope}order=created_at.desc&limit=100`,
    service: true,
  });
  return NextResponse.json({ sessions });
}
