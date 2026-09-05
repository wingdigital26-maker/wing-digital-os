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
    // Interactive client dashboards (scripts/client_dashboard/build.py). Each file
    // is self-contained: the client's own published content, no secrets, no API
    // calls. Public by design so a client can open the link without a login.
    pathname.startsWith("/dashboards/") ||
    // Clean path-style dashboard link /d/<slug>/<key>. Public like /dashboards/:
    // it only 302-redirects to the dashboard page, and the /api/dashboard/ gate
    // still enforces the key. Without this the OS login shadows the link.
    pathname.startsWith("/d/") ||
    // Live dashboard data. Public by design: it is the client's own published
    // content, assembled from sources anyone can already read (their WordPress
    // REST feed, their public repo, their sitemap). No secret passes through it.
    pathname.startsWith("/api/dashboard/") ||
    // Referral-partner lead lists for a client dashboard. NOT public: the route
    // carries its own fail-closed key check (LEADS_DASHBOARD_KEY) because this
    // is enriched B2B contact data, not the client's published content. It is
    // listed here only so the OS login gate does not shadow that check -- a
    // client has no OS account, so without this the middleware 401s every
    // request and the route never runs.
    pathname.startsWith("/api/leads/") ||
    // Machine endpoints: heartbeat ingest (PC posts with x-heartbeat-key), the
    // agent notification pipe (same key), the Vercel cron watchdog (Bearer
    // CRON_SECRET), and the schedule app's due-tomorrow push trigger (Bearer
    // SCHEDULE_PUSH_SECRET, called twice a day by a GitHub Actions job), and
    // the schedule app's lecture summariser (Bearer LECTURE_API_SECRET).
    // All verify their own key inside the route and fail closed.
    pathname === "/api/heartbeat" ||
    pathname === "/api/notify" ||
    pathname === "/api/cron/watchdog" ||
    // Automation engine catch-up (GitHub Actions every 10 min, same key
    // contract as the watchdog: Bearer CRON_SECRET or x-heartbeat-key).
    pathname === "/api/cron/automations" ||
    pathname === "/api/push/schedule" ||
    pathname === "/api/lecture/summarize" ||
    // Twilio webhooks: incoming SMS and delivery-status callbacks. Both verify
    // the X-Twilio-Signature inside the route with TWILIO_AUTH_TOKEN and fail
    // closed (503 when Twilio is unconfigured, 403 on a bad signature).
    pathname === "/api/sms/inbound" ||
    pathname === "/api/sms/status" ||
    // SMS send + message-ledger ingest: machine endpoints. /api/sms/send
    // accepts x-heartbeat-key OR a staff session and fails closed; nothing
    // calls it automatically. /api/messages/log is the email senders' ledger
    // ingest, x-heartbeat-key gated like /api/notify.
    pathname === "/api/sms/send" ||
    pathname === "/api/messages/log" ||
    // Public lead-capture endpoint client sites POST to: /api/forms/<slug>.
    // The route looks the slug up, rate-limits per IP, drops honeypot hits,
    // and answers 404/410 for unknown or paused forms. The bare /api/forms
    // list and /api/forms/submissions are the staff admin side and stay gated.
    (pathname.startsWith("/api/forms/") && !pathname.startsWith("/api/forms/submissions")) ||
    // Twilio Voice webhooks: the inbound-call handler and the <Dial> outcome
    // callback. Same fail-closed auth as the SMS webhooks (signature with
    // TWILIO_AUTH_TOKEN, else the ?k=TWILIO_WEBHOOK_KEY gate) inside the route.
    pathname === "/api/voice/inbound" ||
    pathname === "/api/voice/status" ||
    // Public self-serve booking link (GHL calendar replacement). The page is
    // public by design; /api/booking validates and rate-limits inside the
    // route, and its staff-only modes (?admin=1, PATCH) re-check auth there.
    pathname === "/book" ||
    pathname === "/api/booking" ||
    // Sequence-engine feed for the external sender. Bearer OUTBOUND_EXPORT_KEY
    // verified inside the route, fails closed, same contract as outbound/export.
    pathname === "/api/sequences/due" ||
    pathname.startsWith("/demo-freshco") ||
    pathname.startsWith("/demo-roofing") ||
    pathname.startsWith("/demo-clearhaul")
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
