"use client";
import { useState, useEffect, useCallback } from "react";

// ── Jackson Roofing — client-facing live dashboard ───────────────────────────
// Branded in Chris Jackson's colors (black + bright blue #10C0F0), pulling live
// from his GHL sub-account via /api/jackson. All GHL calls + the PIT stay on the
// server; this page only ever fetches its own /api/jackson endpoint.

const BRAND = {
  black: "#0a0a0a",
  blue: "#10C0F0",
  link: "#0b8fb8",
  logo: "https://assets.cdn.filesafe.space/T2HknbMbA9IJ3qFGLm1G/media/1b659f1b-987f-4fe4-bc24-4851d9db8df2.png",
};

const STAGE_COLORS = ["#10C0F0", "#38bdf8", "#60a5fa", "#818cf8", "#34d399", "#fbbf24"];

type JacksonData = {
  updatedAt: string;
  stats: {
    totalLeads: number;
    newLeadsThisMonth: number;
    upcomingAppointments: number;
    openOpportunities: number;
    pipelineValue: number;
    wonCount: number;
    wonValue: number;
  };
  pipeline: { name: string; stages: { id: string; name: string; count: number; value: number }[] };
  appointments: {
    id: string;
    title: string;
    contactName: string;
    calendarName: string;
    startTime: string;
    endTime: string;
    status: string;
  }[];
  appointmentsAvailable: boolean;
  recentLeads: { id: string; name: string; source: string; tags: string[]; dateAdded: string }[];
  recentActivity: {
    id: string;
    contactName: string;
    type: string;
    direction: string;
    body: string;
    date: number | null;
  }[];
  outreach: { messagesSent: number; messagesReceived: number };
};

function fmtDate(d?: string | number | null) {
  if (!d) return "";
  const date = new Date(d);
  if (isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function fmtDateTime(d?: string | number | null) {
  if (!d) return "";
  const date = new Date(d);
  if (isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function JacksonDashboard() {
  const [data, setData] = useState<JacksonData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retired, setRetired] = useState(false);
  const [lastSync, setLastSync] = useState<Date | null>(null);

  const fetchData = useCallback(() => {
    fetch("/api/jackson")
      .then(async (r) => {
        // 410 Gone: the reporting source was retired for good, so stop polling
        // and tell the client the truth instead of promising a retry.
        if (r.status === 410) {
          setRetired(true);
          setError(true);
          setLoading(false);
          return null;
        }
        return r.json();
      })
      .then((d) => {
        if (!d) return;
        if (d.error) {
          setError(true);
        } else {
          setData(d);
          setLastSync(new Date());
          setError(false);
        }
        setLoading(false);
      })
      .catch(() => {
        setError(true);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchData();
    if (retired) return; // nothing to poll for, the source is gone for good
    const id = setInterval(fetchData, 5 * 60 * 1000); // auto-refresh every 5 min
    return () => clearInterval(id);
  }, [fetchData, retired]);

  const s = data?.stats;

  const STATS = [
    { label: "Total Leads", value: s?.totalLeads ?? 0, color: BRAND.blue, hint: "in your CRM" },
    { label: "New This Month", value: s?.newLeadsThisMonth ?? 0, color: "#34d399", hint: "fresh leads" },
    { label: "Upcoming Appointments", value: s?.upcomingAppointments ?? 0, color: "#60a5fa", hint: "booked ahead" },
    { label: "Open Opportunities", value: s?.openOpportunities ?? 0, color: "#818cf8", hint: "in pipeline" },
    {
      label: "Pipeline Value",
      value: `$${(s?.pipelineValue ?? 0).toLocaleString()}`,
      color: "#fbbf24",
      hint: "potential revenue",
    },
    {
      label: "Jobs Won",
      value: s?.wonCount ?? 0,
      color: "#f472b6",
      hint: s?.wonValue ? `$${s.wonValue.toLocaleString()} value` : "closed sales",
    },
  ];

  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(ellipse 60% 50% at 80% -10%, rgba(16,192,240,0.10), transparent 60%), radial-gradient(ellipse 50% 50% at 5% 105%, rgba(16,192,240,0.06), transparent 60%), #0a0a0a",
        color: "#eef1f8",
        fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
        padding: "0 0 60px 0",
      }}
    >
      {/* Header — branded with Jackson's logo + blue accent */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 16,
          padding: "22px 32px",
          borderBottom: `1px solid rgba(16,192,240,0.22)`,
          background: "linear-gradient(180deg, rgba(16,192,240,0.06), rgba(10,10,10,0.4))",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={BRAND.logo}
            alt="Jackson Roofing"
            style={{ height: 46, width: "auto", objectFit: "contain" }}
          />
          <div>
            <h1
              style={{
                fontSize: 20,
                fontWeight: 800,
                fontFamily: "'Space Grotesk', 'Inter', sans-serif",
                letterSpacing: "-0.01em",
                margin: 0,
              }}
            >
              Jackson Roofing{" "}
              <span style={{ color: BRAND.blue }}>Results Dashboard</span>
            </h1>
            <p style={{ fontSize: 12.5, color: "#9aa3c0", marginTop: 3 }}>
              Live marketing &amp; CRM performance · Plano, TX
            </p>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              fontSize: 11.5,
              fontWeight: 600,
              color: retired ? "#9aa3c0" : BRAND.blue,
              background: retired ? "rgba(154,163,192,0.10)" : "rgba(16,192,240,0.10)",
              border: retired ? "1px solid rgba(154,163,192,0.3)" : `1px solid rgba(16,192,240,0.3)`,
              padding: "6px 13px",
              borderRadius: 999,
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: retired ? "#9aa3c0" : BRAND.blue,
                boxShadow: retired ? "none" : `0 0 8px ${BRAND.blue}`,
                animation: retired ? "none" : "jpulse 2s ease-in-out infinite",
              }}
            />
            {retired ? "NO DATA SOURCE" : "LIVE"}
          </div>
          <p style={{ fontSize: 11, color: "#545d7d", marginTop: 6 }}>
            {retired
              ? "Reporting rebuild in progress"
              : lastSync
                ? `Updated ${lastSync.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
                : "Syncing…"}
          </p>
        </div>
      </header>

      <style>{`
        @keyframes jpulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
        @keyframes jspin { to { transform: rotate(360deg) } }
      `}</style>

      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "28px 32px", display: "flex", flexDirection: "column", gap: 26 }}>
        {error ? (
          <Card>
            <p style={{ color: "#fb7185", fontSize: 14, fontWeight: 600 }}>
              {retired
                ? "This reporting dashboard is being rebuilt."
                : "We couldn't reach your reporting data right now."}
            </p>
            <p style={{ color: "#9aa3c0", fontSize: 12.5, marginTop: 6 }}>
              {retired
                ? "Wing Digital moved off the previous marketing platform, so lead and pipeline reporting is not connected to a data source right now. Your Wing Digital team can walk you through current results in the meantime."
                : "This will retry automatically. If it persists, let your Wing Digital team know."}
            </p>
          </Card>
        ) : (
          <>
            {/* Stat row */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(165px, 1fr))",
                gap: 14,
              }}
            >
              {STATS.map((stat) => (
                <div
                  key={stat.label}
                  style={{
                    position: "relative",
                    background: `radial-gradient(ellipse 90% 70% at 50% -20%, ${stat.color}18, transparent 60%), linear-gradient(180deg, #10131f, rgba(12,15,26,0.85))`,
                    border: "1px solid var(--border)",
                    borderRadius: 16,
                    padding: "18px 20px",
                    boxShadow: "0 8px 24px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.04)",
                    overflow: "hidden",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: stat.color,
                        boxShadow: `0 0 8px ${stat.color}`,
                      }}
                    />
                    <p
                      style={{
                        fontSize: 10.5,
                        color: "#9aa3c0",
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                        fontWeight: 600,
                      }}
                    >
                      {stat.label}
                    </p>
                  </div>
                  <p
                    style={{
                      fontSize: 30,
                      fontWeight: 800,
                      color: stat.color,
                      fontFamily: "'Space Grotesk', sans-serif",
                      textShadow: `0 0 20px ${stat.color}44`,
                      lineHeight: 1,
                    }}
                  >
                    {loading ? "…" : stat.value}
                  </p>
                  <p style={{ fontSize: 10.5, color: "#545d7d", marginTop: 8 }}>{stat.hint}</p>
                </div>
              ))}
            </div>

            {/* Pipeline */}
            <Card>
              <SectionTitle color={BRAND.blue}>
                {data?.pipeline?.name ?? "Marketing Pipeline"}
              </SectionTitle>
              {loading ? (
                <Loader />
              ) : data?.pipeline?.stages?.length ? (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                    gap: 12,
                    marginTop: 6,
                  }}
                >
                  {data.pipeline.stages.map((stage, i) => {
                    const c = STAGE_COLORS[i % STAGE_COLORS.length];
                    return (
                      <div
                        key={stage.id}
                        style={{
                          background: `linear-gradient(180deg, ${c}12, rgba(255,255,255,0.02))`,
                          border: `1px solid ${c}33`,
                          borderRadius: 13,
                          padding: "14px 15px",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                          <span
                            style={{
                              width: 7,
                              height: 7,
                              borderRadius: "50%",
                              background: c,
                              boxShadow: `0 0 8px ${c}`,
                            }}
                          />
                          <p style={{ fontSize: 11.5, fontWeight: 700, color: "#c7cde0" }}>{stage.name}</p>
                        </div>
                        <p
                          style={{
                            fontSize: 24,
                            fontWeight: 800,
                            color: c,
                            fontFamily: "'Space Grotesk', sans-serif",
                            lineHeight: 1,
                          }}
                        >
                          {stage.count}
                        </p>
                        {stage.value > 0 && (
                          <p style={{ fontSize: 11, color: "#34d399", marginTop: 6, fontWeight: 600 }}>
                            ${stage.value.toLocaleString()}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <Empty>No pipeline stages found yet.</Empty>
              )}
              {!loading &&
                data?.pipeline?.stages?.every((s) => s.count === 0) && (
                  <p style={{ fontSize: 12, color: "#545d7d", marginTop: 14 }}>
                    No opportunities have been added to your pipeline yet — as leads move
                    through, they'll populate these stages live.
                  </p>
                )}
            </Card>

            {/* Two-column: Appointments + Recent Leads */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
                gap: 26,
              }}
            >
              {/* Upcoming Appointments */}
              <Card>
                <SectionTitle color="#60a5fa">Upcoming Appointments</SectionTitle>
                {loading ? (
                  <Loader />
                ) : !data?.appointmentsAvailable ? (
                  <Empty>Appointments are temporarily unavailable.</Empty>
                ) : data?.appointments?.length ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
                    {data.appointments.map((a) => (
                      <div
                        key={a.id}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 12,
                          padding: "11px 14px",
                          background: "rgba(255,255,255,0.03)",
                          border: "1px solid var(--border)",
                          borderLeft: "3px solid #60a5fa",
                          borderRadius: 11,
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <p style={{ fontSize: 13.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {a.contactName || a.title}
                          </p>
                          <p style={{ fontSize: 11, color: "#9aa3c0", marginTop: 2 }}>{a.calendarName}</p>
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <p style={{ fontSize: 12, fontWeight: 700, color: "#60a5fa" }}>{fmtDateTime(a.startTime)}</p>
                          {a.status && (
                            <p style={{ fontSize: 10.5, color: "#34d399", marginTop: 2, textTransform: "capitalize" }}>
                              {a.status}
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty>No upcoming appointments booked.</Empty>
                )}
              </Card>

              {/* Recent Leads */}
              <Card>
                <SectionTitle color="#34d399">Recent Leads</SectionTitle>
                {loading ? (
                  <Loader />
                ) : data?.recentLeads?.length ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 4 }}>
                    {data.recentLeads.map((l) => (
                      <div
                        key={l.id}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 10,
                          padding: "10px 4px",
                          borderBottom: "1px solid var(--border)",
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <p style={{ fontSize: 13, fontWeight: 600, textTransform: "capitalize", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {l.name}
                          </p>
                          <p style={{ fontSize: 11, color: "#9aa3c0", marginTop: 2 }}>
                            <span style={{ color: BRAND.blue }}>{l.source}</span>
                            {l.tags?.length ? ` · ${l.tags.slice(0, 2).join(", ")}` : ""}
                          </p>
                        </div>
                        <span style={{ fontSize: 11, color: "#545d7d", whiteSpace: "nowrap" }}>
                          {fmtDate(l.dateAdded)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty>No leads yet.</Empty>
                )}
              </Card>
            </div>

            {/* Outreach activity */}
            <Card>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <SectionTitle color="#a78bfa" noMargin>
                  Recent Outreach on Your Behalf
                </SectionTitle>
                {!loading && data?.outreach && (
                  <div style={{ display: "flex", gap: 8 }}>
                    <Pill color="#a78bfa">{data.outreach.messagesSent} sent</Pill>
                    <Pill color="#34d399">{data.outreach.messagesReceived} replied</Pill>
                  </div>
                )}
              </div>
              {loading ? (
                <Loader />
              ) : data?.recentActivity?.length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 12 }}>
                  {data.recentActivity.map((a) => {
                    const inbound = a.direction === "inbound";
                    return (
                      <div
                        key={a.id}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 12,
                          padding: "10px 4px",
                          borderBottom: "1px solid var(--border)",
                        }}
                      >
                        <span
                          style={{
                            fontSize: 9.5,
                            fontWeight: 700,
                            color: inbound ? "#34d399" : "#a78bfa",
                            background: inbound ? "rgba(52,211,153,0.12)" : "rgba(167,139,250,0.12)",
                            border: `1px solid ${inbound ? "rgba(52,211,153,0.3)" : "rgba(167,139,250,0.3)"}`,
                            padding: "3px 8px",
                            borderRadius: 999,
                            whiteSpace: "nowrap",
                            marginTop: 2,
                            flexShrink: 0,
                          }}
                        >
                          {inbound ? "↓ REPLY" : "↑ " + (a.type || "MSG")}
                        </span>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                            <p style={{ fontSize: 12.5, fontWeight: 600, textTransform: "capitalize" }}>
                              {a.contactName}
                            </p>
                            <span style={{ fontSize: 10.5, color: "#545d7d", whiteSpace: "nowrap" }}>
                              {fmtDate(a.date)}
                            </span>
                          </div>
                          {a.body && (
                            <p
                              style={{
                                fontSize: 11.5,
                                color: "#9aa3c0",
                                marginTop: 3,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {a.body}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <Empty>No recent outreach activity.</Empty>
              )}
            </Card>

            <p style={{ textAlign: "center", fontSize: 11, color: "#3a4160", marginTop: 4 }}>
              Powered by Wing Digital · Data pulled live from your GoHighLevel account · Auto-refreshes every 5 minutes
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "linear-gradient(180deg, #10131f, rgba(12,15,26,0.85))",
        border: "1px solid var(--border)",
        borderRadius: 18,
        padding: "20px 22px",
        boxShadow: "0 8px 24px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.04)",
      }}
    >
      {children}
    </div>
  );
}

function SectionTitle({ children, color, noMargin }: { children: React.ReactNode; color: string; noMargin?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: noMargin ? 0 : 16 }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, boxShadow: `0 0 8px ${color}` }} />
      <p
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: "#c7cde0",
          textTransform: "uppercase",
          letterSpacing: "0.07em",
        }}
      >
        {children}
      </p>
    </div>
  );
}

function Pill({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 700,
        color,
        background: `${color}14`,
        border: `1px solid ${color}33`,
        padding: "3px 11px",
        borderRadius: 999,
      }}
    >
      {children}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p style={{ color: "#545d7d", fontSize: 13, padding: "18px 0" }}>{children}</p>;
}

function Loader() {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "28px 0" }}>
      <div
        style={{
          width: 26,
          height: 26,
          border: "3px solid rgba(16,192,240,0.2)",
          borderTopColor: "#10C0F0",
          borderRadius: "50%",
          animation: "jspin 0.8s linear infinite",
        }}
      />
    </div>
  );
}
