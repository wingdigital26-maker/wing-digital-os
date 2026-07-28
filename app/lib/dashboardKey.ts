// Shared access-key check for the PUBLIC-facing client dashboard endpoints
// (/api/jackson, /api/jackson-content). These are intentionally reachable without
// an OS login so the client can view their own dashboard — but they return real
// CRM data (lead names, message contents, revenue), so they must be guarded by an
// unguessable per-client key. The key is passed as ?k=... in the dashboard link
// and compared, server-side only, against JACKSON_DASHBOARD_KEY.
//
// Fails CLOSED: if JACKSON_DASHBOARD_KEY is unset, no request is authorized.
export function dashboardKeyOk(req: Request): boolean {
  const key = process.env.JACKSON_DASHBOARD_KEY;
  if (!key) return false;
  const provided = new URL(req.url).searchParams.get("k");
  return provided === key;
}
