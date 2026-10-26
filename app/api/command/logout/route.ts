import { NextResponse } from "next/server";

// Signs out of the Command Center (and the OS: it is the same cookie).
function out(req: Request) {
  const res = NextResponse.redirect(new URL("/command/login", req.url), { status: 303 });
  const opts = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", maxAge: 0, path: "/" };
  res.cookies.set("wingos_session", "", opts);
  res.cookies.set("wingos_auth", "", opts);
  return res;
}

export const POST = out;
export const GET = out;
