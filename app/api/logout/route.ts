import { NextResponse } from "next/server";

// Clears BOTH auth cookies (Supabase session + legacy shared-password) and
// sends the user back to /login. Listed as a public path in middleware so even
// a broken/stuck session can always log out.

function clearCookies(res: NextResponse) {
  const opts = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
    path: "/",
  };
  res.cookies.set("wingos_session", "", opts);
  res.cookies.set("wingos_auth", "", opts);
  return res;
}

export async function POST(req: Request) {
  const url = new URL("/login", req.url);
  return clearCookies(NextResponse.redirect(url, { status: 303 }));
}

export async function GET(req: Request) {
  const url = new URL("/login", req.url);
  return clearCookies(NextResponse.redirect(url, { status: 303 }));
}
