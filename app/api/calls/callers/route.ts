import { NextResponse } from "next/server";
import { requireCallUser, sbConfigured, sbGet, sbPost, sbPatch } from "../_guard";
import { sbUrl, sbService } from "../../../../lib/osSupabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Caller-account management. ADMIN ONLY -- a caller must never be able to mint
// another caller, or promote themselves.
//
// Accounts are created here rather than by open sign-up because this is Jack's
// lead data: the only way into the room is an account he made on purpose.

type Profile = { id: string; name: string | null; role: string; created_at: string };

async function adminOnly() {
  const user = await requireCallUser();
  if (!user) return { err: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (!user.isAdmin) {
    return { err: NextResponse.json({ error: "admins only" }, { status: 403 }) };
  }
  if (!sbConfigured()) {
    return { err: NextResponse.json({ error: "call room not configured" }, { status: 503 }) };
  }
  return { user };
}

// GET -- list everyone who can enter the call room, with their dial counts.
export async function GET() {
  const g = await adminOnly();
  if (g.err) return g.err;

  const profiles = await sbGet<Profile>(
    "profiles",
    "select=id,name,role,created_at&role=in.(admin,staff,caller)&order=created_at.desc"
  );
  if (profiles === null) {
    return NextResponse.json({ error: "could not read profiles" }, { status: 502 });
  }

  // Dial counts per person, read from the activity log (the source of truth).
  const activity = await sbGet<{ user_id: string | null; user_email: string | null; outcome: string }>(
    "call_activity",
    "select=user_id,user_email,outcome&limit=10000"
  );
  const stats: Record<string, { calls: number; booked: number; email: string }> = {};
  for (const a of activity ?? []) {
    const k = a.user_id ?? a.user_email ?? "unknown";
    stats[k] ??= { calls: 0, booked: 0, email: a.user_email ?? "" };
    stats[k].calls += 1;
    if (a.outcome === "booked") stats[k].booked += 1;
  }

  return NextResponse.json({
    callers: profiles.map((p) => ({
      ...p,
      calls: stats[p.id]?.calls ?? 0,
      booked: stats[p.id]?.booked ?? 0,
      email: stats[p.id]?.email ?? null,
    })),
  });
}

// POST { email, password, name? } -- create a caller account.
// Uses the Supabase Admin API with the service key, email pre-confirmed so the
// person can sign in immediately without an inbox round-trip.
export async function POST(req: Request) {
  const g = await adminOnly();
  if (g.err) return g.err;

  const body = (await req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
    name?: string;
  };
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const name = String(body.name ?? "").trim() || null;

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "that is not a valid email" }, { status: 400 });
  }
  if (password.length < 10) {
    return NextResponse.json(
      { error: "password must be at least 10 characters" },
      { status: 400 }
    );
  }

  const url = sbUrl();
  const key = sbService();
  if (!url || !key) {
    return NextResponse.json({ error: "call room not configured" }, { status: 503 });
  }

  const created = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });

  if (!created.ok) {
    const detail = await created.text().catch(() => "");
    const dup = /already|exists|registered/i.test(detail);
    return NextResponse.json(
      {
        error: dup
          ? "an account with that email already exists"
          : "Supabase refused to create that user",
        detail: detail.slice(0, 300),
      },
      { status: dup ? 409 : 502 }
    );
  }

  const user = (await created.json()) as { id?: string };
  if (!user.id) {
    return NextResponse.json({ error: "user created but no id returned" }, { status: 502 });
  }

  // The profiles row may be auto-created by a trigger; upsert the role either way.
  const patched = await sbPatch("profiles", `id=eq.${user.id}`, { role: "caller", name });
  if (patched === null || patched.length === 0) {
    const inserted = await sbPost("profiles", { id: user.id, role: "caller", name });
    if (inserted === null) {
      return NextResponse.json(
        {
          error:
            "the login was created but the caller role was NOT set. They can sign in but will not reach the call room. Set profiles.role='caller' manually.",
          userId: user.id,
        },
        { status: 207 }
      );
    }
  }

  return NextResponse.json({ ok: true, id: user.id, email, role: "caller" });
}

// PATCH { id, role } -- change someone's role, including revoking access by
// setting them back to 'client'.
export async function PATCH(req: Request) {
  const g = await adminOnly();
  if (g.err) return g.err;

  const body = (await req.json().catch(() => ({}))) as { id?: string; role?: string };
  const id = String(body.id ?? "");
  const role = String(body.role ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  if (!["caller", "staff", "client"].includes(role)) {
    return NextResponse.json(
      { error: "role must be caller, staff, or client" },
      { status: 400 }
    );
  }
  // Guard against an admin accidentally demoting themselves out of the room.
  if (g.user && id === g.user.id) {
    return NextResponse.json({ error: "you cannot change your own role" }, { status: 400 });
  }

  const out = await sbPatch("profiles", `id=eq.${id}`, { role });
  if (out === null) return NextResponse.json({ error: "role change failed" }, { status: 502 });
  return NextResponse.json({ ok: true, id, role });
}
