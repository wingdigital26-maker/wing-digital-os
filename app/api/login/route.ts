import { NextResponse } from "next/server";
import { authToken } from "../../lib/authToken";

// Simple in-memory rate limiter (per IP) to stop brute-forcing the single shared
// password. Persisted on globalThis so it survives Next hot-reloads in dev.
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

  const { password } = await req.json();
  if (!process.env.OS_PASSWORD || password !== process.env.OS_PASSWORD) {
    if (!rec || now - rec.first >= WINDOW_MS) store.set(ip, { count: 1, first: now });
    else rec.count += 1;
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  store.delete(ip); // success clears the counter
  const res = NextResponse.json({ ok: true });
  res.cookies.set("wingos_auth", authToken(), {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7,
    path: "/",
  });
  return res;
}
