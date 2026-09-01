import { redirect } from "next/navigation";
import { getOsSession, sbSelect } from "@/lib/osSupabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bare /portal landing page. Client-role sessions whose JWT carries no portal
// slug land here (middleware sends them). We re-resolve the slug FRESH from the
// database on every visit, so fixing the client_users mapping takes effect
// immediately even though the stale JWT (valid up to 7 days) has no slug baked
// in. If no mapping exists yet, show an honest state plus a working logout.

export default async function PortalIndexPage() {
  const session = await getOsSession();
  if (!session) redirect("/login");

  // If the JWT already knows the portal, go there.
  if (session.portal) redirect(`/portal/${session.portal}`);

  // Fresh server-side lookup: client_users -> clients.slug.
  const mappings = await sbSelect<{ client_id: string }>({
    table: "client_users",
    select: "client_id",
    query: `user_id=eq.${session.sub}&limit=1`,
    service: true,
  });
  const clientId = mappings[0]?.client_id;
  if (clientId) {
    const clients = await sbSelect<{ slug: string }>({
      table: "clients",
      select: "slug",
      query: `id=eq.${encodeURIComponent(clientId)}&limit=1`,
      service: true,
    });
    const slug = clients[0]?.slug;
    if (slug) redirect(`/portal/${slug}`);
  }

  // Staff sessions have no single portal; send them to the OS home.
  const isStaff =
    session.role === "admin" ||
    session.role === "owner" ||
    session.role === "staff";
  if (isStaff) redirect("/");

  return (
    <div className="page-scroll" style={{ minHeight: "100vh", background: "var(--bg-primary)", color: "var(--text-primary)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ textAlign: "center", maxWidth: 440, padding: 32 }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🔗</div>
        <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>
          Your account is not linked to a client yet
        </h1>
        <p style={{ fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          You are signed in as {session.email}, but this account is not connected
          to a client portal yet. Contact Wing Digital and we will link it up.
        </p>
        <form action="/api/logout" method="post" style={{ marginTop: 24 }}>
          <button
            type="submit"
            style={{
              padding: "10px 24px", borderRadius: 10, border: "1px solid var(--border)",
              background: "var(--bg-card)", color: "var(--text-primary)",
              fontSize: 13, fontWeight: 600, cursor: "pointer",
            }}
          >
            Log out
          </button>
        </form>
      </div>
    </div>
  );
}
