"use client";
// VAULT GRAPH — Jack's business brain, drawn as a living map of notes + threads.
//
// RELIABILITY FIRST. The DEFAULT view is a plain HTML canvas-2D render
// (react-force-graph-2d) that has NO WebGL dependency, so it draws on virtually
// every browser — including ones where WebGL is disabled, blocked by the GPU
// driver, or silently rendering black (the exact reason Jack kept seeing a blank
// void). Nodes are filled glowing circles colored by the 5 folder families,
// sized by degree (hubs bigger), with low-opacity links, flowing particles,
// hover/search highlight and a visible dim floor.
//
// The 3D WebGL galaxy (bloom/glow, auto-orbit) is an OPT-IN "3D" toggle for when
// Jack wants the show. It is code-split (loaded only when toggled) and wrapped
// in an error boundary + an up-front WebGL capability probe: if WebGL is
// unavailable or the scene throws, we fall straight back to the reliable 2D
// canvas. So: 2D is the always-visible default, 3D is the enhancement.
//
// This component is only ever loaded client-side (page.tsx imports it via
// next/dynamic { ssr:false }).
import { useEffect, useMemo, useRef, useState, useCallback, Component } from "react";
import type { ReactNode } from "react";
import dynamic from "next/dynamic";
import ForceGraph2D from "react-force-graph-2d";
import { sfx } from "../lib/sounds";
import type { GNode, GLink } from "./graphTypes";

// The 3D galaxy (and all of three.js) is only pulled in when Jack opts into 3D.
const VaultGraph3D = dynamic(() => import("./VaultGraph3D"), { ssr: false });

const LS_DATA = "wingos-vault-graph-3d-v1"; // cached graph JSON for instant paint

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
const GROUP_COLORS: Record<string, string> = {
  campaigns: "#f59e0b", seo: "#fbbf24", outreach: "#d97706", business: "#fcd34d",
  clients: "#34d399", partners: "#2dd4bf",
  automations: "#a78bfa", agents: "#8b5cf6", state: "#c4b5fd",
  wiki: "#38bdf8", concepts: "#7dd3fc", syntheses: "#22d3ee", personas: "#60a5fa", inbox: "#93c5fd",
  root: "#94a3b8",
};
const FAMILY_COLOR: Record<string, string> = {
  business: "#f59e0b", clients: "#34d399", automation: "#a78bfa", knowledge: "#38bdf8", other: "#94a3b8",
};
const fallbackCache = new Map<string, string>();
function colorOf(g: string): string {
  const known = GROUP_COLORS[g];
  if (known) return known;
  let c = fallbackCache.get(g);
  if (!c) {
    let h = 0;
    for (let i = 0; i < g.length; i++) h = (h * 31 + g.charCodeAt(i)) >>> 0;
    c = hslToHex(210 + (h % 20), 22, 60 + (h % 4) * 6);
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
// If the opt-in 3D WebGL scene throws (a bad postprocessing pass, a shader
// compile failure, a library/version mismatch), we catch it here and tell the
// parent to drop back to the reliable 2D canvas render instead of a blank void.
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

export default function VaultGraph({ onSelectNode }: { onSelectNode: (path: string) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fg2dRef = useRef<any>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [graph, setGraph] = useState<{ nodes: GNode[]; links: GLink[] }>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);
  const [restored, setRestored] = useState(false);
  const [query, setQuery] = useState("");
  const [flow, setFlow] = useState(true);
  // 2D canvas is the reliable DEFAULT. 3D is an opt-in enhancement.
  const [is3D, setIs3D] = useState(false);
  // Glow (bloom / depth-of-field) is a 3D-only, opt-in flourish.
  const [glow, setGlow] = useState(false);
  // Set by the error boundary / WebGL probe: forces the reliable 2D render.
  const [safeMode, setSafeMode] = useState(false);
  const [mobile] = useState<boolean>(detectMobile);
  // WebGL capability probe. If the browser cannot create a WebGL context, 3D is
  // disabled entirely and we never leave the always-visible 2D canvas.
  const [webglOK] = useState<boolean>(() => {
    if (typeof document === "undefined") return true;
    try {
      const c = document.createElement("canvas");
      return !!(c.getContext("webgl2") || c.getContext("webgl") || c.getContext("experimental-webgl"));
    } catch {
      return false;
    }
  });
  const effectiveIs3D = is3D && webglOK && !safeMode;
  const effectiveGlow = glow && effectiveIs3D;

  const onSelectRef = useRef(onSelectNode);
  onSelectRef.current = onSelectNode;

  // Highlight state kept in refs (read by the canvas painter); a tick forces
  // React re-renders so the canvas repaints even when the sim is cooled.
  const highlightNodes = useRef<Set<string>>(new Set());
  const highlightLinks = useRef<Set<GLink>>(new Set());
  const hoverId = useRef<string | null>(null);
  const focusId = useRef<string | null>(null);
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick(t => (t + 1) % 1e9), []);

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
  // The canvas needs explicit pixel dimensions. If the wrapper ever measures 0
  // (a collapsed flex/absolute parent), fall back to the real viewport so the
  // graph is NEVER rendered into a zero-height (invisible) canvas.
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
    const cached = loadCache();
    if (cached && cached.nodes.length) {
      setGraph(buildGraph(cached));
      setLoading(false);
      setRestored(true);
    }
    fetch("/api/vault/graph")
      .then(r => r.json())
      .then((g: RawGraph) => {
        try {
          window.localStorage.setItem(LS_DATA, JSON.stringify({ nodes: g.nodes, links: g.links, hash: g.hash }));
        } catch { /* storage full */ }
        if (cached && cached.hash && g.hash && cached.hash === g.hash) {
          setLoading(false);
          return;
        }
        setGraph(buildGraph(g));
        setLoading(false);
        setRestored(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Debug hook
  useEffect(() => {
    if (!graph.nodes.length) return;
    const degs = graph.nodes.map(n => n.deg ?? 0);
    (window as unknown as { __vaultGraphDebug?: unknown }).__vaultGraphDebug = {
      nodes: graph.nodes.length, links: graph.links.length,
      degMax: Math.max(...degs, 0), mobile, is3D: effectiveIs3D, webglOK,
    };
  }, [graph, mobile, effectiveIs3D, webglOK]);

  // ── 2D force tuning: wide spacing + warm settling ──
  useEffect(() => {
    if (effectiveIs3D) return; // 3D tunes its own forces
    const fg = fg2dRef.current;
    if (!fg || !graph.nodes.length) return;
    fg.d3Force("charge")?.strength(mobile ? -120 : -200).distanceMax(1000);
    fg.d3Force("link")?.distance(mobile ? 50 : 80).strength(0.08);
    if (fg.d3Force("center")) fg.d3Force("center").strength(0.04);
    fg.d3ReheatSimulation?.();
  }, [graph, mobile, effectiveIs3D]);

  // ── Frame the whole layout in view (2D) ──
  const didFit = useRef(false);
  const fitToView2D = useCallback(() => {
    const fg = fg2dRef.current;
    if (!fg || !graph.nodes.length) return;
    try { fg.zoomToFit(600, mobile ? 30 : 60); } catch { /* pre-layout: retry on engine stop */ }
  }, [graph.nodes.length, mobile]);
  useEffect(() => {
    if (effectiveIs3D || !graph.nodes.length) return;
    didFit.current = false;
    const t1 = window.setTimeout(fitToView2D, 400);
    const t2 = window.setTimeout(fitToView2D, 1500);
    return () => { window.clearTimeout(t1); window.clearTimeout(t2); };
  }, [graph.nodes.length, fitToView2D, effectiveIs3D]);

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

  // ── Shared handlers (used by both 2D and 3D) ──
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

  // ── 2D canvas painters ──
  // Node: a filled glowing circle, hubs bigger + brighter, dimmed nodes kept
  // visible (0.22 floor). Labels fade in once zoomed in enough to read them.
  const anyHi = highlightNodes.current.size > 0;
  const paintNode = useCallback((node: GNode, ctx: CanvasRenderingContext2D, scale: number) => {
    const x = node.x ?? 0, y = node.y ?? 0;
    const on = !anyHi || highlightNodes.current.has(node.id);
    const r = Math.max(1.5, (node.val ?? 1.6));
    const color = node.color ?? "#94a3b8";
    ctx.save();
    ctx.globalAlpha = on ? 1 : 0.22;
    // glow halo
    ctx.shadowColor = color;
    ctx.shadowBlur = (node.isHub ? 16 : 8) * (on ? 1 : 0.4);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
    if (node.isHub) {
      // bright ring so hubs read as hubs even before you zoom in
      ctx.shadowBlur = 0;
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    // labels once zoomed in (or always for hubs when zoomed a little)
    const showLabel = on && (scale > 2.4 || (node.isHub && scale > 1.3));
    if (showLabel) {
      const fontSize = Math.min(5, 11 / scale);
      ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = "rgba(226,232,240,0.92)";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(node.name, x, y + r + 1);
    }
    ctx.restore();
  }, [anyHi]);

  // Pointer hitbox so hover/click land on the visible circle.
  const paintPointer = useCallback((node: GNode, color: string, ctx: CanvasRenderingContext2D) => {
    const x = node.x ?? 0, y = node.y ?? 0;
    const r = Math.max(2.5, (node.val ?? 1.6) + 1.5);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
  }, []);

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
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([g]) => [g, colorOf(g)] as [string, string]),
    }));
  }, [graph]);

  return (
    <div ref={wrapRef} className="vault-graph" style={{ position: "relative", width: "100%", height: "100%", minHeight: "60vh", maxWidth: "100%", borderRadius: 16, overflow: "hidden", border: "1px solid rgba(255,255,255,0.07)", background: "#04050a" }}>
      {loading && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 14, zIndex: 2 }}>
          Charting the galaxy...
        </div>
      )}

      {/* Reliable 2D canvas — the DEFAULT, always drawn unless 3D is active. */}
      {!effectiveIs3D && graph.nodes.length > 0 && (
        <ForceGraph2D
          ref={fg2dRef}
          width={size.w}
          height={size.h}
          graphData={graph as unknown as { nodes: GNode[]; links: GLink[] }}
          backgroundColor="#04050a"
          nodeRelSize={1}
          nodeLabel={(n: GNode) => n.name}
          nodeCanvasObject={paintNode}
          nodePointerAreaPaint={paintPointer}
          linkColor={(l: GLink) => {
            const on = !anyHi || highlightLinks.current.has(l);
            const src = typeof l.source === "object" ? (l.source as GNode) : graph.nodes.find(n => n.id === l.source);
            const base = src?.color ?? "#7fa8d9";
            return on ? base : "rgba(127,168,217,0.08)";
          }}
          linkWidth={(l: GLink) => (highlightLinks.current.has(l) ? 1.6 : 0.35)}
          linkCurvature={0.12}
          linkDirectionalParticles={(l: GLink) =>
            flow ? (anyHi ? (highlightLinks.current.has(l) ? 3 : 0) : 2) : 0
          }
          linkDirectionalParticleSpeed={0.004}
          linkDirectionalParticleWidth={1.4}
          linkDirectionalParticleColor={(l: GLink) => {
            const src = typeof l.source === "object" ? (l.source as GNode) : graph.nodes.find(n => n.id === lid(l.source));
            return src?.color ?? "#7fa8d9";
          }}
          warmupTicks={mobile ? 30 : 60}
          cooldownTicks={mobile ? 120 : 240}
          onNodeHover={onNodeHover}
          onNodeClick={onNodeClick}
          onBackgroundClick={onBgClick}
          onEngineStop={() => {
            if (!didFit.current) { didFit.current = true; fitToView2D(); }
            if (!restored) sfx.playWhenReady("graph-arrive");
          }}
        />
      )}

      {/* Opt-in 3D WebGL galaxy — code-split; error boundary falls back to 2D. */}
      {effectiveIs3D && graph.nodes.length > 0 && (
        <GraphErrorBoundary onError={() => { setSafeMode(true); setGlow(false); }}>
          <VaultGraph3D
            graph={graph}
            size={size}
            mobile={mobile}
            flow={flow}
            glow={effectiveGlow}
            restored={restored}
            highlightNodes={highlightNodes}
            highlightLinks={highlightLinks}
            tick={tick}
            onNodeHover={onNodeHover}
            onNodeClick={onNodeClick}
            onBackgroundClick={onBgClick}
          />
        </GraphErrorBoundary>
      )}

      {/* Search-to-highlight */}
      <input
        className="vg-search"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Search notes..."
        aria-label="Search graph nodes"
        style={{
          position: "absolute", top: 12, right: 12, zIndex: 3, width: 180, maxWidth: "40vw",
          background: "rgba(8,9,15,0.72)", backdropFilter: "blur(6px)",
          border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10,
          padding: "7px 12px", color: "var(--text-primary)", fontSize: 12, outline: "none",
        }}
      />

      {/* Stats chip */}
      <div className="vg-stats" style={{
        position: "absolute", top: 12, left: 12, zIndex: 3,
        background: "rgba(8,9,15,0.7)", backdropFilter: "blur(6px)",
        border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: "8px 12px",
      }}>
        <p style={{ fontSize: 9.5, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 3 }}>
          Vault Map
        </p>
        <p style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
          {stats.nodes} notes · {stats.links} threads{restored ? " · restored" : ""}
        </p>
      </div>

      {/* Toggles */}
      <div className="vg-toggles" style={{ position: "absolute", top: 54, right: 12, zIndex: 3, display: "flex", gap: 6 }}>
        <button
          onClick={() => setFlow(f => !f)}
          aria-pressed={flow}
          style={toggleStyle(flow)}
        >Flow</button>
        {/* Glow is a 3D-only flourish; disabled in the reliable 2D view. */}
        <button
          onClick={() => setGlow(g => !g)}
          aria-pressed={effectiveGlow}
          disabled={!effectiveIs3D}
          title={effectiveIs3D ? "Bloom / depth-of-field glow" : "Glow is available in 3D"}
          style={{ ...toggleStyle(effectiveGlow), opacity: effectiveIs3D ? 1 : 0.4, cursor: effectiveIs3D ? "pointer" : "not-allowed" }}
        >Glow</button>
        <button
          onClick={() => { setSafeMode(false); setIs3D(v => !v); }}
          aria-pressed={effectiveIs3D}
          disabled={!webglOK}
          title={webglOK ? "Toggle the 3D galaxy" : "3D needs WebGL, which this browser has disabled"}
          style={{ ...toggleStyle(effectiveIs3D), opacity: webglOK ? 1 : 0.4, cursor: webglOK ? "pointer" : "not-allowed" }}
        >{effectiveIs3D ? "3D" : "2D"}</button>
      </div>

      {/* Legend */}
      <div className="vg-legend" style={{
        position: "absolute", bottom: 12, left: 12, zIndex: 3,
        background: "rgba(8,9,15,0.7)", backdropFilter: "blur(6px)",
        border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: "8px 12px",
        display: "flex", flexDirection: "column", gap: 4, maxWidth: 220,
      }}>
        {legend.map(({ family, color, groups }) => (
          <div key={family}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, boxShadow: `0 0 8px ${color}` }} />
              <p style={{ fontSize: 8.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{family}</p>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingLeft: 14 }}>
              {groups.map(([name, c]) => (
                <div key={name} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: c }} />
                  <span style={{ fontSize: 9.5, color: "var(--text-secondary)", textTransform: "capitalize" }}>{name}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Hint */}
      <div style={{ position: "absolute", bottom: 12, right: 12, zIndex: 3, fontSize: 9.5, color: "rgba(157,180,204,0.5)" }}>
        {mobile ? "tap to open · drag to pan" : "hover to light · click to open · scroll to zoom"}
      </div>
    </div>
  );
}

function toggleStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? "rgba(96,165,250,0.22)" : "rgba(8,9,15,0.72)",
    backdropFilter: "blur(6px)",
    border: `1px solid ${active ? "rgba(96,165,250,0.55)" : "rgba(255,255,255,0.1)"}`,
    borderRadius: 10, padding: "6px 12px",
    color: active ? "#dbeafe" : "var(--text-muted)",
    fontSize: 11, fontWeight: 600, cursor: "pointer",
  };
}
