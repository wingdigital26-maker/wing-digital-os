import { NextResponse } from "next/server";
import { authToken } from "../../lib/authToken";
import { signSession } from "../../lib/session";

// Simple in-memory rate limiter (per IP) to stop brute-forcing. Persisted on
// globalThis so it survives Next hot-reloads in dev.
declare global {
  // eslint-disable-next-line no-var
  var __loginAttempts: Map<string, { count: number; first: number }> | undefined;
}
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 8;

function attempts() {
  if (!globalThis.__loginAttempts) globalThis.__loginAttempts = new Map();
  return globalThis.__loginAttempts;
}

const WEEK = 60 * 60 * 24 * 7;

export async function POST(req: Request) {
  const ip =
    (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
  const now = Date.now();
  const store = attempts();
  const rec = store.get(ip);

  if (rec && now - rec.first < WINDOW_MS && rec.count >= MAX_ATTEMPTS) {
    return NextResponse.json(
      { ok: false, error: "Too many attempts. Try again later." },
      { status: 429 }
    );
  }

  const fail = () => {
    if (!rec || now - rec.first >= WINDOW_MS) store.set(ip, { count: 1, first: now });
    else rec.count += 1;
    return NextResponse.json({ ok: false }, { status: 401 });
  };

  const body = await req.json().catch(() => ({}));
  const { password, email } = body as { password?: string; email?: string };

  // --- NEW: Supabase email + password path (additive) ---
  // Only engages when an email is supplied AND Supabase env is configured.
  // Any failure here falls through to the legacy password path below.
  const sbUrl = process.env.OS_SUPABASE_URL;
  const anon = process.env.OS_SUPABASE_ANON_KEY;
  if (email && sbUrl && anon) {
    // Filled in only when Supabase positively authenticates the user. JWT
    // minting happens AFTER the try/catch below so a signSession failure can
    // never fall through to the legacy OS_PASSWORD path.
    let authed: { uid: string; role: string; portal?: string } | null = null;
    try {
      const r = await fetch(`${sbUrl}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: anon, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (r.ok) {
        const data = await r.json();
        const uid: string | undefined = data.user?.id;
        // Look up the role from profiles (service key, server-side only).
        let role = "client";
        const svc = process.env.OS_SUPABASE_SERVICE_KEY;
        if (svc && uid) {
          const pr = await fetch(
            `${sbUrl}/rest/v1/profiles?id=eq.${uid}&select=role`,
            { headers: { apikey: svc, Authorization: `Bearer ${svc}` } }
          );
          if (pr.ok) {
            const rows = await pr.json();
            if (rows?.[0]?.role) role = rows[0].role;
          }
        }
        if (uid) {
          // For client-role users, resolve their portal slug (client_users ->
          // clients) so middleware can redirect them home without a DB call.
          // Server-side lookups only -- nothing here trusts client input.
          let portal: string | undefined;
          const isStaffRole =
            role === "admin" || role === "owner" || role === "staff";
          if (!isStaffRole && svc) {
            try {
              const mp = await fetch(
                `${sbUrl}/rest/v1/client_users?user_id=eq.${uid}&select=client_id&limit=1`,
                { headers: { apikey: svc, Authorization: `Bearer ${svc}` } }
              );
              const maps = mp.ok ? await mp.json() : [];
              const clientId = maps?.[0]?.client_id;
              if (clientId) {
                const cr = await fetch(
                  `${sbUrl}/rest/v1/clients?id=eq.${clientId}&select=slug&limit=1`,
                  { headers: { apikey: svc, Authorization: `Bearer ${svc}` } }
                );
                const rows = cr.ok ? await cr.json() : [];
                if (rows?.[0]?.slug) portal = String(rows[0].slug);
              }
            } catch {
              // Portal lookup is best-effort; the session still works without it.
            }
          }
          authed = { uid, role, portal };
        } else {
          // Supabase OK but no user id -> failed attempt.
          return fail();
        }
      } else {
        // Supabase said no -> count as a failed attempt.
        return fail();
      }
    } catch {
      // Network/config problem reaching Supabase -> fall through to legacy path.
    }

    if (authed) {
      // Supabase auth SUCCEEDED. From here on, nothing may fall through to the
      // legacy OS_PASSWORD path: a broken session secret is a server
      // misconfiguration, not a login failure.
      let token: string;
      try {
        token = await signSession({
          sub: authed.uid,
          email,
          role: authed.role,
          portal: authed.portal,
        });
      } catch {
        return NextResponse.json(
          { ok: false, error: "auth misconfigured" },
          { status: 500 }
        );
      }
      store.delete(ip);
      const res = NextResponse.json({
        ok: true,
        role: authed.role,
        portal: authed.portal,
      });
      res.cookies.set("wingos_session", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: WEEK,
        path: "/",
      });
      return res;
    }
  }

  // --- LEGACY: shared OS_PASSWORD path (unchanged behavior) ---
  if (!process.env.OS_PASSWORD || password !== process.env.OS_PASSWORD) {
    return fail();
  }

  store.delete(ip); // success clears the counter
  const res = NextResponse.json({ ok: true });
  res.cookies.set("wingos_auth", await authToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: WEEK,
    path: "/",
  });
  return res;
}
