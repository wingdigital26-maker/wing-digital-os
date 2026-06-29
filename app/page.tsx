"use client";
import { useState, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import dynamic from "next/dynamic";

const VaultGraph = dynamic(() => import("./components/VaultGraph"), { ssr: false });
const AgentsView = dynamic(() => import("./components/AgentPanel"), { ssr: false });

const NAV = [
  { id: "command", label: "Command Center", icon: "⚡" },
  { id: "pipeline", label: "Lead Pipeline", icon: "🎯" },
  { id: "clients", label: "Clients", icon: "👥" },
  { id: "knowledge", label: "Knowledge Base", icon: "🧠" },
  { id: "agent", label: "AI Agents", icon: "🤖" },
  { id: "personal", label: "Personal", icon: "📅" },
  { id: "log", label: "Activity Log", icon: "📋" },
];

export default function Home() {
  const [active, setActive] = useState("command");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [ghlData, setGhlData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/ghl")
      .then(r => r.json())
      .then(d => { setGhlData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div style={{ display: "flex", height: "100vh", background: "var(--bg-primary)" }}>

      {/* Sidebar */}
      <aside style={{
        width: sidebarOpen ? 220 : 60,
        background: "var(--bg-secondary)",
        borderRight: "1px solid var(--border)",
        display: "flex", flexDirection: "column",
        transition: "width 0.2s ease",
        flexShrink: 0, overflow: "hidden",
      }}>
        <div style={{
          padding: "20px 16px", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: "linear-gradient(135deg, #7c6af5, #4f46a8)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 16, flexShrink: 0, fontWeight: 700,
          }}>W</div>
          {sidebarOpen && (
            <span style={{ fontWeight: 700, fontSize: 14, color: "var(--text-primary)", whiteSpace: "nowrap" }}>
              Wing Digital OS
            </span>
          )}
        </div>

        <nav style={{ flex: 1, padding: "12px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
          {NAV.map(item => (
            <button key={item.id} onClick={() => setActive(item.id)} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "10px 10px", borderRadius: 8, border: "none",
              background: active === item.id ? "var(--accent-glow)" : "transparent",
              borderLeft: active === item.id ? "2px solid var(--accent)" : "2px solid transparent",
              color: active === item.id ? "var(--text-primary)" : "var(--text-secondary)",
              cursor: "pointer", width: "100%", textAlign: "left",
              fontSize: 13, fontWeight: active === item.id ? 600 : 400,
              transition: "all 0.15s",
            }}>
              <span style={{ fontSize: 16, flexShrink: 0 }}>{item.icon}</span>
              {sidebarOpen && <span style={{ whiteSpace: "nowrap" }}>{item.label}</span>}
            </button>
          ))}
        </nav>

        <button onClick={() => setSidebarOpen(!sidebarOpen)} style={{
          margin: "8px", padding: "8px", borderRadius: 8, border: "none",
          background: "transparent", color: "var(--text-muted)",
          cursor: "pointer", fontSize: 16,
        }}>
          {sidebarOpen ? "◀" : "▶"}
        </button>
      </aside>

      {/* Main */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <header style={{
          padding: "16px 24px", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          background: "var(--bg-secondary)", flexShrink: 0,
        }}>
          <div>
            <h1 style={{ fontSize: 18, fontWeight: 700 }}>
              {NAV.find(n => n.id === active)?.icon}{" "}
              {NAV.find(n => n.id === active)?.label}
            </h1>
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
              {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{
              background: "var(--bg-card)", border: "1px solid var(--border)",
              borderRadius: 8, padding: "8px 14px", display: "flex", alignItems: "center", gap: 8,
              color: "var(--text-muted)", fontSize: 13, cursor: "pointer",
            }}>
              <span>🔍</span><span>Search... ⌘K</span>
            </div>
            <div style={{
              width: 34, height: 34, borderRadius: "50%",
              background: "linear-gradient(135deg, #7c6af5, #4f46a8)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 14, fontWeight: 700,
            }}>J</div>
          </div>
        </header>

        <div style={{ flex: 1, overflow: "auto", padding: "24px" }}>
          {active === "command" && <CommandCenter data={ghlData} loading={loading} />}
          {active === "pipeline" && <Pipeline data={ghlData} loading={loading} />}
          {active === "clients" && <Clients data={ghlData} loading={loading} />}
          {active === "knowledge" && <KnowledgeBase />}
          {active === "agent" && <AgentsView />}
          {active !== "command" && active !== "pipeline" && active !== "clients" && active !== "knowledge" && active !== "agent" && (
            <Placeholder label={NAV.find(n => n.id === active)?.label ?? ""} icon={NAV.find(n => n.id === active)?.icon ?? ""} />
          )}
        </div>
      </main>
    </div>
  );
}

function CommandCenter({ data, loading }: { data: any; loading: boolean }) {
  const stats = data?.stats;
  const STATS = [
    { label: "Active Clients", value: loading ? "..." : (stats?.activeClients ?? 0), color: "#7c6af5" },
    { label: "Open Leads", value: loading ? "..." : (stats?.openLeads ?? 0), color: "#4ade80" },
    { label: "MRR", value: loading ? "..." : `$${(stats?.mrr ?? 0).toLocaleString()}`, color: "#fb923c" },
    { label: "Appts This Week", value: loading ? "..." : (stats?.apptsThisWeek ?? 0), color: "#60a5fa" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 14 }}>
          Live Stats
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
          {STATS.map(stat => (
            <div key={stat.label} style={{
              background: "var(--bg-card)", border: "1px solid var(--border)",
              borderRadius: 12, padding: "18px 20px",
              borderTop: `2px solid ${stat.color}`,
            }}>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>{stat.label}</p>
              <p style={{ fontSize: 28, fontWeight: 700, color: stat.color }}>{stat.value}</p>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 14 }}>Recent Leads</p>
          {loading ? <Spinner /> : (data?.recentLeads?.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {data.recentLeads.slice(0, 6).map((lead: any) => (
                <div key={lead.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                  <div>
                    <p style={{ fontSize: 13, fontWeight: 600 }}>{lead.name}</p>
                    <p style={{ fontSize: 11, color: "var(--text-muted)" }}>{lead.email}</p>
                  </div>
                  {lead.tags?.slice(0, 1).map((tag: string) => (
                    <span key={tag} style={{ fontSize: 10, background: "var(--accent-glow)", color: "var(--accent)", padding: "2px 8px", borderRadius: 20 }}>{tag}</span>
                  ))}
                </div>
              ))}
            </div>
          ) : <p style={{ color: "var(--text-muted)", fontSize: 13 }}>No contacts yet</p>)}
        </div>

        <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 14 }}>Active Clients</p>
          {loading ? <Spinner /> : (data?.activeClients?.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {data.activeClients.slice(0, 6).map((client: any) => (
                <div key={client.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                  <p style={{ fontSize: 13, fontWeight: 600 }}>{client.name}</p>
                  <span style={{ fontSize: 13, color: "#4ade80", fontWeight: 600 }}>${client.value.toLocaleString()}/mo</span>
                </div>
              ))}
            </div>
          ) : <p style={{ color: "var(--text-muted)", fontSize: 13 }}>No won opportunities yet</p>)}
        </div>
      </div>

      <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 14 }}>Quick Actions</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {["Add Lead", "New Note", "Log Call", "Create Task"].map(action => (
            <button key={action} style={{
              background: "var(--bg-hover)", border: "1px solid var(--border)",
              borderRadius: 8, padding: "8px 16px", color: "var(--text-primary)",
              fontSize: 13, cursor: "pointer", fontWeight: 500,
            }}>{action}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Pipeline({ data, loading }: { data: any; loading: boolean }) {
  const leads = data?.recentLeads ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
        {loading ? "Loading..." : `${data?.stats?.totalContacts ?? 0} Total Contacts`}
      </p>
      {loading ? <Spinner /> : (
        <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", padding: "12px 20px", borderBottom: "1px solid var(--border)", background: "var(--bg-hover)" }}>
            {["Name", "Email", "Phone", "Tags"].map(h => (
              <p key={h} style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</p>
            ))}
          </div>
          {leads.map((lead: any, i: number) => (
            <div key={lead.id} style={{
              display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto",
              padding: "14px 20px", borderBottom: i < leads.length - 1 ? "1px solid var(--border)" : "none",
              alignItems: "center",
            }}>
              <p style={{ fontSize: 13, fontWeight: 600 }}>{lead.name || "—"}</p>
              <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>{lead.email || "—"}</p>
              <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>{lead.phone || "—"}</p>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {lead.tags?.slice(0, 2).map((tag: string) => (
                  <span key={tag} style={{ fontSize: 10, background: "var(--accent-glow)", color: "var(--accent)", padding: "2px 8px", borderRadius: 20 }}>{tag}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Clients({ data, loading }: { data: any; loading: boolean }) {
  const clients = data?.activeClients ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
        {loading ? "Loading..." : `${clients.length} Active Clients`}
      </p>
      {loading ? <Spinner /> : clients.length ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
          {clients.map((client: any) => (
            <div key={client.id} style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, borderLeft: "3px solid var(--accent)" }}>
              <p style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>{client.name}</p>
              <p style={{ fontSize: 13, color: "#4ade80", fontWeight: 600 }}>${client.value.toLocaleString()}/mo</p>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>{client.stage}</p>
            </div>
          ))}
        </div>
      ) : (
        <p style={{ color: "var(--text-muted)", fontSize: 14 }}>No won opportunities in GHL yet. Mark deals as "Won" in GHL and they'll show here.</p>
      )}
    </div>
  );
}

function KnowledgeBase() {
  const [tree, setTree] = useState<any[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [loadingFile, setLoadingFile] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["wiki"]));

  useEffect(() => {
    fetch("/api/vault").then(r => r.json()).then(d => setTree(d.tree ?? []));
  }, []);

  const openFile = useCallback((filePath: string) => {
    setSelectedFile(filePath);
    setLoadingFile(true);
    fetch(`/api/vault/file?path=${encodeURIComponent(filePath)}`)
      .then(r => r.json())
      .then(d => { setContent(d.content ?? ""); setLoadingFile(false); });
  }, []);

  const toggleFolder = (p: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(p) ? next.delete(p) : next.add(p);
      return next;
    });
  };

  function FileTree({ nodes, depth = 0 }: { nodes: any[]; depth?: number }) {
    return (
      <div>
        {nodes.map(node => (
          <div key={node.path}>
            {node.type === "folder" ? (
              <>
                <button onClick={() => toggleFolder(node.path)} style={{
                  display: "flex", alignItems: "center", gap: 6,
                  width: "100%", textAlign: "left", border: "none", background: "transparent",
                  color: "var(--text-secondary)", padding: `5px 8px 5px ${12 + depth * 14}px`,
                  fontSize: 12, fontWeight: 600, cursor: "pointer",
                  textTransform: "uppercase", letterSpacing: "0.05em",
                }}>
                  <span>{expanded.has(node.path) ? "▾" : "▸"}</span>
                  {node.name}
                </button>
                {expanded.has(node.path) && node.children && (
                  <FileTree nodes={node.children} depth={depth + 1} />
                )}
              </>
            ) : (
              <button onClick={() => openFile(node.path)} style={{
                display: "block", width: "100%", textAlign: "left", border: "none",
                background: selectedFile === node.path ? "var(--accent-glow)" : "transparent",
                borderLeft: selectedFile === node.path ? "2px solid var(--accent)" : "2px solid transparent",
                color: selectedFile === node.path ? "var(--text-primary)" : "var(--text-secondary)",
                padding: `5px 8px 5px ${12 + depth * 14}px`,
                fontSize: 13, cursor: "pointer",
              }}>
                📄 {node.name}
              </button>
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "calc(100vh - 130px)", margin: "-24px", overflow: "hidden" }}>

      {/* Left: File tree */}
      <div style={{ width: 220, flexShrink: 0, borderRight: "1px solid var(--border)", overflow: "auto", padding: "16px 0", background: "var(--bg-secondary)" }}>
        <p style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", padding: "0 12px 10px", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Vault
        </p>
        <FileTree nodes={tree} />
      </div>

      {/* Middle: Graph always visible */}
      <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
        <VaultGraph onSelectNode={(p) => openFile(p)} />
      </div>

      {/* Right: Note content slides in when a file is selected */}
      {selectedFile && (
        <div style={{ width: 420, flexShrink: 0, borderLeft: "1px solid var(--border)", overflow: "auto", padding: "28px 28px", background: "var(--bg-secondary)", position: "relative" }}>
          <button onClick={() => setSelectedFile(null)} style={{
            position: "absolute", top: 12, right: 12, background: "transparent", border: "none",
            color: "var(--text-muted)", cursor: "pointer", fontSize: 18, lineHeight: 1,
          }}>✕</button>
          {loadingFile ? (
            <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading...</p>
          ) : (
            <>
              <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 20, fontFamily: "monospace", paddingRight: 24 }}>{selectedFile}</p>
              <div className="markdown-body" style={{ lineHeight: 1.8, fontSize: 14 }}>
                <ReactMarkdown>{content}</ReactMarkdown>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return <div style={{ color: "var(--text-muted)", fontSize: 13, padding: "20px 0" }}>Loading from GHL...</div>;
}

function Placeholder({ label, icon }: { label: string; icon: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "60vh", flexDirection: "column", gap: 16 }}>
      <span style={{ fontSize: 48 }}>{icon}</span>
      <h2 style={{ fontSize: 20, fontWeight: 700 }}>{label}</h2>
      <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Being built next</p>
    </div>
  );
}
