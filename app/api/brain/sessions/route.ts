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

  // Scope every read to the caller's user_id when we have a real per-user
  // session; legacy password access (no user id) sees the shared/staff rows.
  // Reads run under the service key (RLS bypassed), so this WHERE clause is the
  // only thing standing between one user and another user's brain chats. Without
  // it, any signed-in user could read another user's messages by passing their
  // session id (?id=<uuid>) -- the flagged IDOR.
  const scope = session?.sub
    ? `user_id=eq.${session.sub}&`
    : "";

  if (id) {
    const messages = await sbSelect({
      table: "chat_messages",
      select: "id,role,content,model,created_at",
      query: `${scope}session_id=eq.${id}&order=created_at.asc&limit=200`,
      service: true,
    });
    return NextResponse.json({ messages });
  }

  // List sessions with the same user scoping.
  const sessions = await sbSelect({
    table: "chat_sessions",
    select: "id,title,created_at",
    query: `${scope}order=created_at.desc&limit=100`,
    service: true,
  });
  return NextResponse.json({ sessions });
}
