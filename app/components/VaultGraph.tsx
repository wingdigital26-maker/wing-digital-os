"use client";
// VAULT GRAPH — Jack's business brain, drawn as a living map of notes + threads.
//
// 3D ONLY. This used to ship two renderers (a canvas-2D fallback plus an opt-in
// WebGL galaxy) with a toggle between them. Jack only wants the galaxy, so the
// 2D path and its toggle are gone: this component is now the data + chrome
// shell, and VaultGraph3D does all the drawing. If WebGL is genuinely
// unavailable — or the scene throws — we show an honest message instead of a
// blank void (there is no longer a second renderer to fall back to).
//
// ── Why the scene stays DARK in a light app ──
// The app is a light theme, but this panel is deliberately a dark inset, not an
// oversight. The galaxy's whole visual language is additive: bloom, glowing
// node cores, luminous link particles. Every one of those effects is light
// EMITTED against darkness — on a white ground bloom does nothing, particles
// disappear, and the "map of a mind at night" metaphor collapses into gray
// spaghetti. So instead of half-converting it, we commit: the panel reads as an
// intentional observatory window set into the light UI — framed with a proper
// bezel, and with its floating chrome styled as dark glass so the controls
// belong to the scene rather than looking like light-theme cards stranded on a
// black rectangle.
//
// This component is only ever loaded client-side (page.tsx imports it via
// next/dynamic { ssr:false }).
import { useEffect, useMemo, useRef, useState, useCallback, Component } from "react";
import type { ReactNode } from "react";
import dynamic from "next/dynamic";
import { sfx } from "../lib/sounds";
import type { GNode, GLink } from "./graphTypes";

// three.js is heavy, so the scene is still code-split out of the main bundle.
const VaultGraph3D = dynamic(() => import("./VaultGraph3D"), { ssr: false });

const LS_DATA = "wingos-vault-graph-3d-v1"; // cached graph JSON for instant paint

// The scene's own ground color. Kept here (not just in VaultGraph3D) so the
// wrapper paints the identical value behind the canvas — otherwise there is a
// pale flash before WebGL takes over.
const SCENE_BG = "#05060d";

// ── Warm the graph API as soon as this module loads ──
if (typeof window !== "undefined") {
  try {
    if (!window.sessionStorage.getItem("wingos-graph-prefetched")) {
      window.sessionStorage.setItem("wingos-graph-prefetched", "1");
      fetch("/api/vault/graph", { priority: "low" } as RequestInit).catch(() => {});
    }
  } catch {
    /* noop */
  }
}

// ── Folder palette: 5 hue families instead of a 12-hue rainbow ──
const FAMILY_ORDER = ["business", "clients", "automation", "knowledge", "other"] as const;
const FAMILY_LABEL: Record<string, string> = {
  business: "business / campaigns",
  clients: "clients / partners",
  automation: "automations / agents",
  knowledge: "wiki / knowledge",
  other: "root / other",
};
const GROUP_FAMILY: Record<string, string> = {
  campaigns: "business", seo: "business", outreach: "business", business: "business",
  clients: "clients", partners: "clients",
  automations: "automation", agents: "automation", state: "automation",
  wiki: "knowledge", concepts: "knowledge", syntheses: "knowledge", personas: "knowledge", inbox: "knowledge",
  root: "other",
};
// LITERAL HEX ONLY — these feed three.js materials and canvas label sprites,
// neither of which can resolve CSS custom properties. The old table mixed in
// values like "var(--green)", which THREE.Color cannot parse: those groups were
// silently painting the wrong color. They are also tuned BRIGHT on purpose,
// because they are emitted against the dark scene (see the header note) and
// need to sit above the bloom threshold to actually glow.
const GROUP_COLORS: Record<string, string> = {
  campaigns: "#fbbf24", seo: "#f59e0b", outreach: "#fb923c", business: "#fcd34d",
  clients: "#34d399", partners: "#2dd4bf",
  automations: "#a78bfa", agents: "#8b5cf6", state: "#c4b5fd",
  wiki: "#38bdf8", concepts: "#7dd3fc", syntheses: "#22d3ee", personas: "#67e8f9", inbox: "#93c5fd",
  root: "#94a3b8",
};
const FAMILY_COLOR: Record<string, string> = {
  business: "#fbbf24", clients: "#34d399", automation: "#a78bfa", knowledge: "#38bdf8", other: "#94a3b8",
};
const fallbackCache = new Map<string, string>();
function colorOf(g: string): string {
  const known = GROUP_COLORS[g];
  if (known) return known;
  let c = fallbackCache.get(g);
  if (!c) {
    let h = 0;
    for (let i = 0; i < g.length; i++) h = (h * 31 + g.charCodeAt(i)) >>> 0;
    c = hslToHex(200 + (h % 24), 45, 62 + (h % 4) * 5);
    fallbackCache.set(g, c);
  }
  return c;
}
function familyOf(g: string): string {
  return GROUP_FAMILY[g] ?? "other";
}
function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100, ln = l / 100;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const col = ln - sn * Math.min(ln, 1 - ln) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * col).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

const HUB_DEG = 8; // degree at which a node reads as a hub (bigger, brighter)

// Node size by degree, wide range so hubs are dramatically bigger.
function nodeVal(deg: number): number {
  return 1.6 + Math.sqrt(deg) * 2.2;
}

function lid(x: string | GNode): string {
  return typeof x === "string" ? x : x.id;
}

// Small-screen / low-power detection.
function detectMobile(): boolean {
  if (typeof window === "undefined") return false;
  const narrow = window.matchMedia?.("(max-width: 820px)")?.matches;
  const coarse = window.matchMedia?.("(pointer: coarse)")?.matches;
  return !!(narrow || coarse);
}

interface RawGraph {
  nodes: { id: string; name: string; path: string; group: string }[];
  links: { source: string; target: string }[];
  hash?: string;
}

function loadCache(): RawGraph | null {
  try {
    const raw = window.localStorage.getItem(LS_DATA);
    if (!raw) return null;
    const v = JSON.parse(raw) as RawGraph;
    if (!v || !Array.isArray(v.nodes) || !Array.isArray(v.links)) return null;
    return v;
  } catch {
    return null;
  }
}

// Enrich raw nodes with degree / family / color / size, and normalize links.
function buildGraph(raw: RawGraph): { nodes: GNode[]; links: GLink[] } {
  const deg = new Map<string, number>();
  for (const n of raw.nodes) deg.set(n.id, 0);
  const ids = new Set(raw.nodes.map(n => n.id));
  const links: GLink[] = [];
  for (const l of raw.links) {
    if (!ids.has(l.source) || !ids.has(l.target)) continue;
    deg.set(l.source, (deg.get(l.source) ?? 0) + 1);
    deg.set(l.target, (deg.get(l.target) ?? 0) + 1);
    links.push({ source: l.source, target: l.target });
  }
  const nodes: GNode[] = raw.nodes.map(n => {
    const d = deg.get(n.id) ?? 0;
    return {
      ...n,
      deg: d,
      fam: familyOf(n.group),
      color: colorOf(n.group),
      val: nodeVal(d),
      isHub: d >= HUB_DEG,
    };
  });
  return { nodes, links };
}

// ── Error boundary ──
// With the 2D renderer gone there is nothing to fall back TO, so a throw inside
// the WebGL scene must surface as an honest message rather than a silent void.
class GraphErrorBoundary extends Component<
  { onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  constructor(props: { onError: () => void; children: ReactNode }) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

export default function VaultGraph({ onSelectNode, onToggleTree }: { onSelectNode: (path: string) => void; onToggleTree?: () => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [graph, setGraph] = useState<{ nodes: GNode[]; links: GLink[] }>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);
  const [restored, setRestored] = useState(false);
  const [query, setQuery] = useState("");
  // FLOW IS ON BY DEFAULT (Jack's ask): the galaxy should always look alive, not
  // wait for a click. VaultGraph3D bounds the cost by sampling a subset of links
  // for the ambient stream instead of animating all ~884 of them.
  const [flow, setFlow] = useState(true);
  // Bloom / depth-of-field. Opt-in: it is the prettiest but priciest pass.
  const [glow, setGlow] = useState(false);
  // Set by the error boundary: the scene threw and cannot be shown.
  const [sceneFailed, setSceneFailed] = useState(false);
  const [mobile] = useState<boolean>(detectMobile);
  // Mobile-only: the cluttered control row collapses into one compact bar.
  const [mSearchOpen, setMSearchOpen] = useState(false);
  const [mMenuOpen, setMMenuOpen] = useState(false);
  // WebGL capability probe. There is no 2D fallback any more, so this decides
  // between "galaxy" and "explain why there is no galaxy".
  const [webglOK] = useState<boolean>(() => {
    if (typeof document === "undefined") return true;
    try {
      const c = document.createElement("canvas");
      return !!(c.getContext("webgl2") || c.getContext("webgl") || c.getContext("experimental-webgl"));
    } catch {
      return false;
    }
  });
  const canRender3D = webglOK && !sceneFailed;

  const onSelectRef = useRef(onSelectNode);
  onSelectRef.current = onSelectNode;

  // Highlight state kept in refs (read by the scene); a tick forces React
  // re-renders so dependent visuals resync.
  const highlightNodes = useRef<Set<string>>(new Set());
  const highlightLinks = useRef<Set<GLink>>(new Set());
  const hoverId = useRef<string | null>(null);
  const focusId = useRef<string | null>(null);
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick(t => (t + 1) % 1e9), []);
  // Bumped by the explicit Recenter button; the ONLY sanctioned way to re-fit
  // after Jack has taken control of the view.
  const [recenterN, setRecenterN] = useState(0);

  // adjacency for neighborhood highlighting
  const adj = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const n of graph.nodes) m.set(n.id, new Set());
    for (const l of graph.links) {
      const s = lid(l.source), t = lid(l.target);
      m.get(s)?.add(t);
      m.get(t)?.add(s);
    }
    return m;
  }, [graph]);

  const stats = { nodes: graph.nodes.length, links: graph.links.length };

  // ── Size tracking ──
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const apply = () => {
      const vw = typeof window !== "undefined" ? window.innerWidth : 800;
      const vh = typeof window !== "undefined" ? window.innerHeight : 600;
      const w = wrap.clientWidth || vw || 800;
      const h = wrap.clientHeight || Math.max(320, Math.round(vh * 0.6)) || 600;
      setSize({ w, h });
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(wrap);
    window.addEventListener("resize", apply);
    return () => { ro.disconnect(); window.removeEventListener("resize", apply); };
  }, []);

  // ── Load: cache instantly, then reconcile with the API ──
  useEffect(() => {
    let cancelled = false;
    const cached = loadCache();
    const haveCache = !!(cached && cached.nodes.length);
    if (haveCache) {
      setGraph(buildGraph(cached!));
      setLoading(false);
      setRestored(true);
    }
    const attempt = (tries: number) => {
      fetch("/api/vault/graph", { cache: "no-store" })
        .then(r => r.json())
        .then((g: RawGraph) => {
          if (cancelled) return;
          const ok = g && Array.isArray(g.nodes) && g.nodes.length > 0;
          if (!ok) {
            // Empty/invalid payload: keep any cached paint and retry a few times
            // with backoff before giving up.
            if (tries < 4) { window.setTimeout(() => attempt(tries + 1), 400 * (tries + 1)); return; }
            setLoading(false);
            return;
          }
          try {
            window.localStorage.setItem(LS_DATA, JSON.stringify({ nodes: g.nodes, links: g.links, hash: g.hash }));
          } catch { /* storage full */ }
          if (haveCache && cached!.hash && g.hash && cached!.hash === g.hash) {
            setLoading(false);
            return;
          }
          setGraph(buildGraph(g));
          setLoading(false);
          setRestored(false);
        })
        .catch(() => {
          if (cancelled) return;
          if (tries < 4) { window.setTimeout(() => attempt(tries + 1), 400 * (tries + 1)); return; }
          setLoading(false);
        });
    };
    attempt(0);
    return () => { cancelled = true; };
  }, []);

  // Debug hook
  useEffect(() => {
    if (!graph.nodes.length) return;
    const degs = graph.nodes.map(n => n.deg ?? 0);
    (window as unknown as { __vaultGraphDebug?: unknown }).__vaultGraphDebug = {
      nodes: graph.nodes.length, links: graph.links.length,
      degMax: Math.max(...degs, 0), mobile, webglOK, sceneFailed, flow,
    };
  }, [graph, mobile, webglOK, sceneFailed, flow]);

  // ── Search highlight: matches drive the same dim/highlight machinery ──
  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      if (!hoverId.current && !focusId.current) {
        highlightNodes.current = new Set();
        highlightLinks.current = new Set();
        bump();
      }
      return;
    }
    const nodes = new Set<string>();
    for (const n of graph.nodes) if (n.name.toLowerCase().includes(q)) nodes.add(n.id);
    const links = new Set<GLink>();
    for (const l of graph.links) {
      if (nodes.has(lid(l.source)) && nodes.has(lid(l.target))) links.add(l);
    }
    highlightNodes.current = nodes;
    highlightLinks.current = links;
    bump();
  }, [query, graph, bump]);

  // ── Highlight a node's neighborhood ──
  const setNeighborhood = useCallback((id: string | null) => {
    const nodes = new Set<string>();
    const links = new Set<GLink>();
    if (id) {
      nodes.add(id);
      for (const nb of adj.get(id) ?? []) nodes.add(nb);
      for (const l of graph.links) {
        const s = lid(l.source), t = lid(l.target);
        if (s === id || t === id) links.add(l);
      }
    }
    highlightNodes.current = nodes;
    highlightLinks.current = links;
    bump();
  }, [adj, graph, bump]);

  // ── Shared handlers ──
  const onNodeHover = useCallback((node: GNode | null) => {
    if (mobile) return; // no hover on touch
    const id = node?.id ?? null;
    if (id === hoverId.current) return;
    hoverId.current = id;
    if (!focusId.current) setNeighborhood(id);
    if (id) sfx.play("graph-hover");
  }, [mobile, setNeighborhood]);

  const onNodeClick = useCallback((node: GNode) => {
    focusId.current = node.id;
    setNeighborhood(node.id);
    sfx.play("graph-focus");
    onSelectRef.current(node.path);
  }, [setNeighborhood]);

  const onBgClick = useCallback(() => {
    focusId.current = null;
    if (!query.trim()) setNeighborhood(null);
  }, [query, setNeighborhood]);

  // ── Legend: families present ──
  const legend = useMemo(() => {
    const byFamily = new Map<string, Map<string, number>>();
    for (const n of graph.nodes) {
      const f = n.fam ?? "other";
      const inner = byFamily.get(f) ?? new Map<string, number>();
      inner.set(n.group, (inner.get(n.group) ?? 0) + 1);
      byFamily.set(f, inner);
    }
    return FAMILY_ORDER.filter(f => byFamily.has(f)).map(f => ({
      family: FAMILY_LABEL[f] ?? f,
      color: FAMILY_COLOR[f] ?? "#94a3b8",
      groups: [...(byFamily.get(f) ?? new Map()).entries()]
        // 3 per family, not 5: the legend is a key, not an index, and at 5 it
        // grew into a 200px slab crowding the bottom-left of the panel.
        .sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([g]) => [g, colorOf(g)] as [string, string]),
    }));
  }, [graph]);

  const recenter = useCallback(() => setRecenterN(n => n + 1), []);

  return (
    <div
      ref={wrapRef}
      className="vault-graph"
      style={{
        position: "relative", width: "100%", height: "100%", minHeight: "60vh", maxWidth: "100%",
        borderRadius: 16, overflow: "hidden",
        // Deliberate dark inset in a light app: a real bezel (hairline + soft
        // outer shadow) so it reads as a framed window, not an unstyled hole.
        background: SCENE_BG,
        border: "1px solid var(--border)",
        boxShadow: "0 18px 44px rgba(15,23,42,0.16), inset 0 0 0 1px rgba(148,163,184,0.10)",
      }}
    >
      {loading && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(203,213,225,0.65)", fontSize: 14, zIndex: 2 }}>
          Charting the galaxy...
        </div>
      )}

      {/* The galaxy — the one and only renderer. */}
      {canRender3D && graph.nodes.length > 0 && (
        <GraphErrorBoundary onError={() => { setSceneFailed(true); setGlow(false); }}>
          <VaultGraph3D
            graph={graph}
            size={size}
            mobile={mobile}
            flow={flow}
            glow={glow}
            restored={restored}
            highlightNodes={highlightNodes}
            highlightLinks={highlightLinks}
            tick={tick}
            recenterN={recenterN}
            onNodeHover={onNodeHover}
            onNodeClick={onNodeClick}
            onBackgroundClick={onBgClick}
          />
        </GraphErrorBoundary>
      )}

      {/* No WebGL / the scene threw: say so plainly instead of showing a void. */}
      {!canRender3D && !loading && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 2, display: "flex",
          flexDirection: "column", alignItems: "center", justifyContent: "center",
          gap: 8, padding: 24, textAlign: "center",
        }}>
          <p style={{ color: "#e2e8f0", fontSize: 14, fontWeight: 600 }}>The vault map needs WebGL</p>
          <p style={{ color: "rgba(148,163,184,0.85)", fontSize: 12, maxWidth: 340, lineHeight: 1.5 }}>
            {sceneFailed
              ? "The 3D scene failed to start in this browser. Reload, or enable hardware acceleration."
              : "This browser has WebGL disabled or blocked. Enable hardware acceleration to see the graph."}
          </p>
          <p style={{ color: "rgba(148,163,184,0.6)", fontSize: 11 }}>
            {stats.nodes} notes · {stats.links} threads are still indexed — use the contents list to browse them.
          </p>
        </div>
      )}

      {/* ═══════════ MOBILE: one compact, unobtrusive control bar ═══════════ */}
      {mobile && (
        <>
          <div className="vg-mbar" style={{
            position: "absolute", top: 10, left: 10, right: 10, zIndex: 4,
            display: "flex", alignItems: "center", gap: 6,
          }}>
            {onToggleTree && (
              <button onClick={onToggleTree} aria-label="Vault contents" title="Contents" style={mIconStyle(false)}>
                <IconTree />
              </button>
            )}
            <button onClick={() => { setMSearchOpen(o => !o); setMMenuOpen(false); }} aria-pressed={mSearchOpen} aria-label="Search notes" title="Search" style={mIconStyle(mSearchOpen || !!query)}>
              <IconSearch />
            </button>
            <div style={{ flex: 1 }} />
            <button onClick={recenter} aria-label="Recenter map" title="Recenter" style={mIconStyle(false)}>
              <IconRecenter />
            </button>
            <button onClick={() => { setMMenuOpen(o => !o); setMSearchOpen(false); }} aria-pressed={mMenuOpen} aria-label="More controls" title="More" style={mIconStyle(mMenuOpen)}>
              <IconSliders />
            </button>
          </div>

          {/* Inline search — only when tapped */}
          {mSearchOpen && (
            <input
              className="vg-msearch"
              value={query}
              autoFocus
              onChange={e => setQuery(e.target.value)}
              placeholder="Search notes..."
              aria-label="Search graph nodes"
              style={{ ...glassPanel(), position: "absolute", top: 52, left: 10, right: 10, zIndex: 4, borderRadius: 10, padding: "9px 12px", color: "#e8edf7", fontSize: 13, outline: "none" }}
            />
          )}

          {/* "More" popover — secondary toggles + legend + stats, tucked away */}
          {mMenuOpen && (
            <div className="vg-mpop" style={{
              ...glassPanel(), position: "absolute", top: 52, right: 10, zIndex: 5, width: "min(72vw, 260px)",
              borderRadius: 14, padding: 12,
              display: "flex", flexDirection: "column", gap: 12,
            }}>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setFlow(f => !f)} aria-pressed={flow} style={{ ...toggleStyle(flow), flex: 1, textAlign: "center" }}>Flow</button>
                <button onClick={() => setGlow(g => !g)} aria-pressed={glow} title="Bloom / depth-of-field glow" style={{ ...toggleStyle(glow), flex: 1, textAlign: "center" }}>Glow</button>
              </div>
              <div style={{ borderTop: "1px solid rgba(148,163,184,0.18)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 6, maxHeight: "34vh", overflow: "auto" }}>
                <p style={{ fontSize: 9, fontWeight: 700, color: "rgba(148,163,184,0.9)", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                  {stats.nodes} notes · {stats.links} threads
                </p>
                {legend.map(({ family, color }) => (
                  <div key={family} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, boxShadow: `0 0 8px ${color}`, flexShrink: 0 }} />
                    <span style={{ fontSize: 10.5, color: "#cbd5e1", textTransform: "capitalize" }}>{family}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* ═══════════ DESKTOP: the full, always-visible control layout ═══════════ */}
      {!mobile && (<>
      {/* Search-to-highlight */}
      <input
        className="vg-search"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Search notes..."
        aria-label="Search graph nodes"
        style={{
          ...glassPanel(), position: "absolute", top: 12, right: 12, zIndex: 3, width: 180, maxWidth: "40vw",
          borderRadius: 10, padding: "7px 12px", color: "#e8edf7", fontSize: 12, outline: "none",
        }}
      />

      {/* Stats chip */}
      <div className="vg-stats" style={{ ...glassPanel(), position: "absolute", top: 12, left: 12, zIndex: 3, borderRadius: 12, padding: "8px 12px" }}>
        <p style={{ fontSize: 9.5, fontWeight: 700, color: "#e2e8f0", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 3 }}>
          Vault Map
        </p>
        <p style={{ fontSize: 10.5, color: "rgba(148,163,184,0.95)" }}>
          {stats.nodes} notes · {stats.links} threads{restored ? " · restored" : ""}
        </p>
      </div>

      {/* Toggles — the 2D/3D switch is gone; 3D is the only mode now. */}
      <div className="vg-toggles" style={{ position: "absolute", top: 54, right: 12, zIndex: 3, display: "flex", gap: 6 }}>
        <button onClick={recenter} title="Re-frame the whole map" style={toggleStyle(false)}>Recenter</button>
        <button onClick={() => setFlow(f => !f)} aria-pressed={flow} title="Animated link particles" style={toggleStyle(flow)}>Flow</button>
        <button onClick={() => setGlow(g => !g)} aria-pressed={glow} title="Bloom / depth-of-field glow" style={toggleStyle(glow)}>Glow</button>
      </div>

      {/* Legend */}
      <div className="vg-legend" style={{
        ...glassPanel(), position: "absolute", bottom: 12, left: 12, zIndex: 3,
        borderRadius: 12, padding: "8px 12px",
        display: "flex", flexDirection: "column", gap: 4, maxWidth: 220,
        // The legend grows with the number of folder families and was running
        // off the bottom of the panel (last rows clipped). Cap it against the
        // panel height and let it scroll instead.
        maxHeight: "calc(100% - 140px)", overflowY: "auto",
      }}>
        {legend.map(({ family, color, groups }) => (
          <div key={family}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, boxShadow: `0 0 8px ${color}` }} />
              <p style={{ fontSize: 8.5, color: "rgba(148,163,184,0.95)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{family}</p>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingLeft: 14 }}>
              {groups.map(([name, c]) => (
                <div key={name} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: c }} />
                  <span style={{ fontSize: 9.5, color: "#cbd5e1", textTransform: "capitalize" }}>{name}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Hint */}
      <div style={{ position: "absolute", bottom: 12, right: 12, zIndex: 3, fontSize: 9.5, color: "rgba(148,163,184,0.55)" }}>
        hover to light · click to open · scroll to zoom · drag to orbit
      </div>
      </>)}
    </div>
  );
}

// ── Chrome styling ──
// These panels float ON the dark scene, not on the light app surface, so they
// deliberately use dark-glass literals instead of the light theme's --bg-card /
// --text-* tokens. Using the light tokens here produced white cards stamped on
// a black rectangle — the exact "accidental" look the dark-inset decision is
// meant to avoid.
function glassPanel(): React.CSSProperties {
  return {
    background: "rgba(12,16,28,0.72)",
    backdropFilter: "blur(10px)",
    WebkitBackdropFilter: "blur(10px)",
    border: "1px solid rgba(148,163,184,0.20)",
    boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
  };
}

// Compact, quiet icon button used only in the mobile control bar.
function mIconStyle(active: boolean): React.CSSProperties {
  return {
    ...glassPanel(),
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: 34, height: 34, minHeight: 34, padding: 0, flexShrink: 0,
    background: active ? "rgba(56,189,248,0.24)" : "rgba(12,16,28,0.72)",
    border: `1px solid ${active ? "rgba(56,189,248,0.55)" : "rgba(148,163,184,0.20)"}`,
    borderRadius: 10,
    color: active ? "#e0f2fe" : "#cbd5e1",
    cursor: "pointer",
  };
}
const ICO = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
function IconSearch() { return <svg {...ICO}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>; }
function IconTree() { return <svg {...ICO}><path d="M3 6h13M3 12h13M3 18h13M20 6h.01M20 12h.01M20 18h.01" /></svg>; }
function IconRecenter() { return <svg {...ICO}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>; }
function IconSliders() { return <svg {...ICO}><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" /></svg>; }

function toggleStyle(active: boolean): React.CSSProperties {
  return {
    ...glassPanel(),
    background: active ? "rgba(56,189,248,0.24)" : "rgba(12,16,28,0.72)",
    border: `1px solid ${active ? "rgba(56,189,248,0.55)" : "rgba(148,163,184,0.20)"}`,
    borderRadius: 10, padding: "6px 12px",
    color: active ? "#e0f2fe" : "#cbd5e1",
    fontSize: 11, fontWeight: 600, cursor: "pointer",
  };
}
