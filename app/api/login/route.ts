import { NextResponse } from "next/server";
import { authToken } from "../../lib/authToken";

export async function POST(req: Request) {
  const { password } = await req.json();
  if (!process.env.OS_PASSWORD || password !== process.env.OS_PASSWORD) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set("wingos_auth", authToken(), {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7,
    path: "/",
  });
  return res;
}
