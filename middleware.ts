import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authToken } from "./app/lib/authToken";
import { verifySession } from "./app/lib/session";

function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/api/login" ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname === "/manifest.json" ||
    pathname === "/sw.js" ||
    pathname === "/icon.svg" ||
    pathname.startsWith("/icon-") ||
    pathname === "/apple-touch-icon.png" ||
    // Client-facing dashboards: the HTML shell is public, but the DATA endpoints
    // (/api/jackson*) are separately guarded by JACKSON_DASHBOARD_KEY.
    pathname === "/jackson-dashboard.html" ||
    pathname === "/jackson" ||
    pathname === "/jackson-v2" ||
    pathname.startsWith("/api/jackson") ||
    // Machine endpoints: heartbeat ingest (PC posts with x-heartbeat-key) and
    // the Vercel cron watchdog (Bearer CRON_SECRET). Both verify their own key
    // inside the route and fail closed without it.
    pathname === "/api/heartbeat" ||
    pathname === "/api/cron/watchdog" ||
    pathname.startsWith("/demo-freshco") ||
    pathname.startsWith("/demo-roofing") ||
    pathname.startsWith("/demo-clearhaul") ||
    pathname.startsWith("/jackson-site")
  );
}

export async function middleware(req: NextRequest) {
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
  if (pathname === "/demo-clearhaul" || pathname === "/demo-clearhaul/") {
    const url = req.nextUrl.clone();
    url.pathname = "/demo-clearhaul/index.html";
    return NextResponse.redirect(url);
  }
  if (pathname === "/jackson-site" || pathname === "/jackson-site/") {
    const url = req.nextUrl.clone();
    url.pathname = "/jackson-site/index.html";
    return NextResponse.redirect(url);
  }

  if (isPublicPath(pathname)) return NextResponse.next();

  // NEW (additive): a valid Supabase-auth session cookie grants access. Returns
  // null if the cookie is absent/invalid or AUTH_SESSION_SECRET is unset, in
  // which case we fall through to the legacy OS_PASSWORD gate below.
  const session = await verifySession(req.cookies.get("wingos_session")?.value);
  if (session) return NextResponse.next();

  const password = process.env.OS_PASSWORD;
  if (!password) {
    // FAIL CLOSED. A missing password must never silently open the whole OS in a
    // deployed environment. Only local development is allowed to run ungated.
    if (process.env.NODE_ENV === "development") return NextResponse.next();
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "server auth not configured" },
        { status: 503 }
      );
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
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
