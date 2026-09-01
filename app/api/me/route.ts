import { NextResponse } from "next/server";
import { getOsSession, hasLegacyAuth } from "@/lib/osSupabase";

// ───────────────────────────────────────────────────────────────────────────
// Who am I — the one fact the shell needs to shape the nav per user.
//
// Returns the session's role (and email) for Supabase-auth users, or
// role "legacy" for the shared OS_PASSWORD cookie (which is Jack himself and
// keeps full access). No profile data, no ids beyond the email the user
// already typed to log in. Unauthenticated callers get 401 — middleware
// should have bounced them already; this is the second lock.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getOsSession();
  if (session) {
    return NextResponse.json({ role: session.role, email: session.email ?? null });
  }
  if (await hasLegacyAuth()) {
    return NextResponse.json({ role: "legacy", email: null });
  }
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
