import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authToken } from "./app/lib/authToken";
import { verifySession } from "./app/lib/session";

function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/api/login" ||
    pathname === "/api/logout" ||
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
    // Interactive client dashboards (scripts/client_dashboard/build.py). Each file
    // is self-contained: the client's own published content, no secrets, no API
    // calls. Public by design so a client can open the link without a login.
    pathname.startsWith("/dashboards/") ||
    // Live dashboard data. Public by design: it is the client's own published
    // content, assembled from sources anyone can already read (their WordPress
    // REST feed, their public repo, their sitemap). No secret passes through it.
    pathname.startsWith("/api/dashboard/") ||
    pathname === "/jackson" ||
    pathname === "/jackson-v2" ||
    pathname.startsWith("/api/jackson") ||
    // Machine endpoints: heartbeat ingest (PC posts with x-heartbeat-key), the
    // agent notification pipe (same key), the Vercel cron watchdog (Bearer
    // CRON_SECRET), and the schedule app's due-tomorrow push trigger (Bearer
    // SCHEDULE_PUSH_SECRET, called twice a day by a GitHub Actions job).
    // All verify their own key inside the route and fail closed.
    pathname === "/api/heartbeat" ||
    pathname === "/api/notify" ||
    pathname === "/api/cron/watchdog" ||
    pathname === "/api/push/schedule" ||
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
  if (session) {
    const isStaff =
      session.role === "admin" ||
      session.role === "owner" ||
      session.role === "staff";
    if (isStaff) return NextResponse.next();

    // Caller-role sessions reach the Cold Call Room and NOTHING else. These are
    // outside dialers working Jack's lead list; they must never see revenue,
    // the client roster, Sonar, Jarvis, or any client's data. Scoped here at the
    // edge AND re-checked inside every /api/calls route.
    if (session.role === "caller") {
      if (
        pathname === "/calls" ||
        pathname.startsWith("/calls/") ||
        pathname.startsWith("/api/calls/")
      ) {
        // The caller-account admin screen is for Jack only.
        if (pathname.startsWith("/calls/team") || pathname.startsWith("/api/calls/callers")) {
          if (pathname.startsWith("/api/")) {
            return NextResponse.json({ error: "forbidden" }, { status: 403 });
          }
          const url = req.nextUrl.clone();
          url.pathname = "/calls";
          return NextResponse.redirect(url);
        }
        return NextResponse.next();
      }
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
      const url = req.nextUrl.clone();
      url.pathname = "/calls";
      return NextResponse.redirect(url);
    }

    // Client-role sessions only ever reach their client portal. Everything
    // else -- admin pages AND admin API routes -- is blocked.
    if (pathname === "/portal" || pathname.startsWith("/portal/")) {
      return NextResponse.next();
    }
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    // Slug-less client sessions go to the bare /portal page (which resolves a
    // fresh slug server-side or shows an honest "not linked" state + logout),
    // NEVER back to /login -- that looped forever with an httpOnly cookie the
    // user could not clear.
    const url = req.nextUrl.clone();
    url.pathname = session.portal ? `/portal/${session.portal}` : "/portal";
    return NextResponse.redirect(url);
  }

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
  if (cookie && cookie === (await authToken())) return NextResponse.next();

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
