import { NextResponse } from "next/server";
import { signSession } from "@/app/lib/session";
import { codeFor, codeMatches, SESSION_PREFIX } from "@/lib/command/auth";
import { USERS, type UserId } from "@/lib/command/team";

// Command Center sign-in: pick your name, type your code. Fails closed: a user
// with no COMMAND_CODE_<NAME> set cannot sign in, and with no
// AUTH_SESSION_SECRET nobody can. Brute force is slowed per IP like /api/login.

declare global {
  // eslint-disable-next-line no-var
  var __ccLoginAttempts: Map<string, { count: number; first: number }> | undefined;
}
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const WEEK = 60 * 60 * 24 * 7;

export async function POST(req: Request) {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
  const store = (globalThis.__ccLoginAttempts ??= new Map());
  const now = Date.now();
  const rec = store.get(ip);
  if (rec && now - rec.first < WINDOW_MS && rec.count >= MAX_ATTEMPTS) {
    return NextResponse.json({ ok: false, error: "Too many tries. Wait 15 minutes." }, { status: 429 });
  }
  const failed = (error: string, status = 401) => {
    if (!rec || now - rec.first >= WINDOW_MS) store.set(ip, { count: 1, first: now });
    else rec.count += 1;
    return NextResponse.json({ ok: false, error }, { status });
  };

  const b = (await req.json().catch(() => ({}))) as { user?: string; code?: string };
  const user = String(b.user || "").toLowerCase() as UserId;
  if (!USERS.includes(user)) return failed("Pick your name.");
  if (!codeFor(user)) {
    return NextResponse.json(
      { ok: false, error: "Sign-in is not set up for you yet. Ask Jack to add your code." },
      { status: 503 }
    );
  }
  if (!codeMatches(user, String(b.code || ""))) return failed("That code is not right.");

  let token: string;
  try {
    token = await signSession({
      sub: `${SESSION_PREFIX}${user}`,
      email: `${user}@command.wing`,
      role: user === "jack" ? "admin" : "member",
    });
  } catch {
    return NextResponse.json({ ok: false, error: "Sign-in is misconfigured (AUTH_SESSION_SECRET)." }, { status: 500 });
  }
  store.delete(ip);
  const res = NextResponse.json({ ok: true });
  res.cookies.set("wingos_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: WEEK,
    path: "/",
  });
  return res;
}
