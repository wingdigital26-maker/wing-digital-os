import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authToken } from "./app/lib/authToken";

export function middleware(req: NextRequest) {
  const password = process.env.OS_PASSWORD;
  // No password configured = no gate (local-only use)
  if (!password) return NextResponse.next();

  const { pathname } = req.nextUrl;
  // Static demo sites in public/ have no directory-index resolution in Next;
  // send the bare folder URL to its index.html.
  if (pathname === "/demo-freshco" || pathname === "/demo-freshco/") {
    const url = req.nextUrl.clone();
    url.pathname = "/demo-freshco/index.html";
    return NextResponse.redirect(url);
  }
  if (pathname === "/demo-roofing" || pathname === "/demo-roofing/") {
    const url = req.nextUrl.clone();
    url.pathname = "/demo-roofing/index.html";
    return NextResponse.redirect(url);
  }
  if (pathname === "/jackson-site" || pathname === "/jackson-site/") {
    const url = req.nextUrl.clone();
    url.pathname = "/jackson-site/index.html";
    return NextResponse.redirect(url);
  }
  if (
    pathname === "/login" ||
    pathname === "/api/login" ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname === "/manifest.json" ||
    pathname === "/icon.svg" ||
    pathname.startsWith("/icon-") ||
    pathname === "/apple-touch-icon.png" ||
    pathname === "/jackson-dashboard.html" ||
    pathname === "/jackson" ||
    pathname.startsWith("/api/jackson") ||
    pathname.startsWith("/demo-freshco") ||
    pathname.startsWith("/demo-roofing") ||
    pathname.startsWith("/jackson-site")
  ) {
    return NextResponse.next();
  }

  const cookie = req.cookies.get("wingos_auth")?.value;
  if (cookie === authToken()) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
