import { getOsSession, sbSelect } from "@/lib/osSupabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Client = {
  id: string;
  slug: string;
  name: string;
  ghl_location_id?: string;
  retainer?: number;
  phase?: string;
};
type Health = {
  client_id: string;
  date?: string;
  overall?: number;
  seo?: number;
  content?: number;
  website?: number;
  crm?: number;
  onboarding?: number;
  detail?: any;
};

const PILLARS: { key: keyof Health; label: string }[] = [
  { key: "seo", label: "SEO" },
  { key: "content", label: "Content" },
  { key: "website", label: "Website" },
  { key: "crm", label: "CRM" },
  { key: "onboarding", label: "Onboarding" },
];

function scoreColor(n: number | undefined): string {
  if (n === undefined || n === null) return "var(--text-muted)";
  if (n >= 80) return "var(--green)";
  if (n >= 50) return "var(--orange)";
  return "var(--red)";
}

function NotAuthorized({ reason }: { reason: string }) {
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-primary)", color: "var(--text-primary)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ textAlign: "center", maxWidth: 420, padding: 32 }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🔒</div>
        <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Not authorized</h1>
        <p style={{ fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>{reason}</p>
        <a href="/login" style={{ display: "inline-block", marginTop: 20, color: "var(--accent)", fontSize: 13, textDecoration: "none" }}>Go to login →</a>
      </div>
    </div>
  );
}

export default async function PortalPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getOsSession();

  // A per-client portal is identity-scoped. Legacy shared-password access has no
  // user, so we require a real Supabase session here.
  if (!session) {
    return <NotAuthorized reason="This client portal requires you to sign in with your account." />;
  }

  const role = session.role;
  const isStaff = role === "admin" || role === "staff";

  // Look up the client by slug (service read; access is enforced below).
  const clients = await sbSelect<Client>({
    table: "clients",
    select: "id,slug,name,ghl_location_id,retainer,phase",
    query: `slug=eq.${encodeURIComponent(slug)}&limit=1`,
    service: true,
  });
  const client = clients[0];
  if (!client) {
    return <NotAuthorized reason="No client exists at this address." />;
  }

  // Access: staff/admin see any client; a client user must have a client_users
  // mapping to THIS client.
  if (!isStaff) {
    const mapping = await sbSelect<{ client_id: string }>({
      table: "client_users",
      select: "client_id,access",
      query: `user_id=eq.${session.sub}&client_id=eq.${client.id}&limit=1`,
      service: true,
    });
    if (mapping.length === 0) {
      return <NotAuthorized reason="Your account is not linked to this client." />;
    }
  }

  // Load the client's data.
  const [healthRows, agentRuns, deliverables] = await Promise.all([
    sbSelect<Health>({
      table: "health_scores",
      select: "*",
      query: `client_id=eq.${client.id}&order=date.desc&limit=1`,
      service: true,
    }),
    sbSelect<any>({
      table: "agent_runs",
      select: "*",
      query: `client_id=eq.${client.id}&order=created_at.desc&limit=10`,
      service: true,
    }),
    sbSelect<any>({
      table: "deliverables",
      select: "*",
      query: `client_id=eq.${client.id}&order=created_at.desc&limit=20`,
      service: true,
    }),
  ]);
  const health = healthRows[0];

  const card: React.CSSProperties = {
    background: "linear-gradient(180deg, var(--bg-card), rgba(12,15,26,0.85))",
    border: "1px solid var(--border)", borderRadius: 16, padding: 20,
  };
  const sectionTitle: React.CSSProperties = {
    fontSize: 11, fontWeight: 700, color: "var(--text-muted)",
    textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14,
  };

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-primary)", color: "var(--text-primary)" }}>
      <header style={{ padding: "20px 28px", borderBottom: "1px solid var(--border)", background: "var(--bg-secondary)" }}>
        <p style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.1em" }}>Client Portal</p>
        <h1 style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{client.name}</h1>
        <div style={{ display: "flex", gap: 14, marginTop: 8, flexWrap: "wrap" }}>
          {client.phase && <span style={{ fontSize: 12, color: "var(--accent-2)" }}>Phase: {client.phase}</span>}
          {typeof client.retainer === "number" && <span style={{ fontSize: 12, color: "var(--green)" }}>${client.retainer.toLocaleString()}/mo</span>}
          {isStaff && <span style={{ fontSize: 11, color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 999, padding: "1px 10px" }}>staff view</span>}
        </div>
      </header>

      <div style={{ maxWidth: 980, margin: "0 auto", padding: "28px", display: "flex", flexDirection: "column", gap: 24 }}>
        {/* Health scores */}
        <section>
          <p style={sectionTitle}>Health {health?.date ? `· as of ${new Date(health.date).toLocaleDateString()}` : ""}</p>
          {health ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ ...card, display: "flex", alignItems: "center", gap: 20 }}>
                <div>
                  <p style={{ fontSize: 44, fontWeight: 800, lineHeight: 1, color: scoreColor(health.overall), fontFamily: "'Space Grotesk', sans-serif" }}>
                    {health.overall ?? "—"}
                  </p>
                  <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Overall</p>
                </div>
                <div style={{ flex: 1, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12 }}>
                  {PILLARS.map((p) => {
                    const v = health[p.key] as number | undefined;
                    return (
                      <div key={p.label}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                          <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>{p.label}</span>
                          <span style={{ fontSize: 11.5, fontWeight: 700, color: scoreColor(v) }}>{v ?? "—"}</span>
                        </div>
                        <div style={{ height: 6, background: "rgba(255,255,255,0.05)", borderRadius: 999, overflow: "hidden" }}>
                          <div style={{ width: `${Math.min(Number(v) || 0, 100)}%`, height: "100%", background: scoreColor(v), borderRadius: 999 }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div style={card}><p style={{ fontSize: 13, color: "var(--text-muted)" }}>No health scores recorded yet.</p></div>
          )}
        </section>

        {/* Deliverables */}
        <section>
          <p style={sectionTitle}>Deliverables</p>
          <div style={card}>
            {deliverables.length ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {deliverables.map((d: any, i: number) => (
                  <div key={d.id ?? i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: i < deliverables.length - 1 ? "1px solid var(--border)" : "none" }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{d.title ?? d.name ?? d.type ?? "Deliverable"}</span>
                    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                      {d.status && <span style={{ fontSize: 11, color: "var(--accent-2)" }}>{d.status}</span>}
                      {(d.url ?? d.link) && (
                        <a href={d.url ?? d.link} target="_blank" rel="noreferrer" style={{ fontSize: 11.5, color: "var(--accent)", textDecoration: "none" }}>View →</a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : <p style={{ fontSize: 13, color: "var(--text-muted)" }}>No published deliverables yet.</p>}
          </div>
        </section>

        {/* Recent agent runs */}
        <section>
          <p style={sectionTitle}>Recent Activity</p>
          <div style={card}>
            {agentRuns.length ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {agentRuns.map((r: any, i: number) => (
                  <div key={r.id ?? i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: i < agentRuns.length - 1 ? "1px solid var(--border)" : "none" }}>
                    <span style={{ fontSize: 13 }}>{r.agent ?? r.name ?? r.type ?? "Agent run"}</span>
                    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                      {r.status && <span style={{ fontSize: 11, color: r.status === "ok" ? "var(--green)" : "var(--text-muted)" }}>{r.status}</span>}
                      {(r.created_at ?? r.date) && (
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{new Date(r.created_at ?? r.date).toLocaleDateString()}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : <p style={{ fontSize: 13, color: "var(--text-muted)" }}>No agent activity yet.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
