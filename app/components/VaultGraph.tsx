"use client";
// VAULT GRAPH — an immersive 3D galaxy of Jack's business brain.
// - Rendering: real WebGL (three.js + d3-force-3d) via react-force-graph-3d,
//   with UnrealBloom so bright hubs glow and bleed into pure black, an optional
//   BokehPass depth-of-field on desktop, and flowing link particles for the
//   "alive" feel.
// - Layout: warm, roomy force sim (wide charge repulsion + long links) so the
//   galaxy is spaced out, plus a slow auto-orbit camera so it always breathes.
// - Data: cached in localStorage keyed by the API's structural hash, so nodes
//   appear instantly on revisit while the sim warms in the background.
// - Interactions: hover lights the neighborhood and dims the rest (visible dim
//   floor), click eases the camera to frame a node AND opens it through the
//   existing onSelectNode contract. Space-y sounds via the shared sfx engine.
//
// This whole component is only ever loaded client-side (page.tsx imports it via
// next/dynamic { ssr:false }), so the WebGL library and its window/three usage
// never run during SSR.
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import ForceGraph3D from "react-force-graph-3d";
import * as THREE from "three";
import { UnrealBloomPass, BokehPass } from "three-stdlib";
import { sfx } from "../lib/sounds";

interface GNode {
  id: string;
  name: string;
  path: string;
  group: string;
  // populated client-side
  deg?: number;
  fam?: string;
  color?: string;
  val?: number;
  isHub?: boolean;
}
interface GLink {
  source: string | GNode;
  target: string | GNode;
}

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

const HUB_DEG = 8; // degree at which a node reads as a hub (bigger, brighter, octahedron)

// Node size by degree, wide range so hubs are dramatically bigger.
function nodeVal(deg: number): number {
  return 1.6 + Math.sqrt(deg) * 2.2;
}

function lid(x: string | GNode): string {
  return typeof x === "string" ? x : x.id;
}

// Small-screen / low-power detection so we can drop DoF and lower bloom.
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

export default function VaultGraph({ onSelectNode }: { onSelectNode: (path: string) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [graph, setGraph] = useState<{ nodes: GNode[]; links: GLink[] }>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);
  const [restored, setRestored] = useState(false);
  const [query, setQuery] = useState("");
  const [flow, setFlow] = useState(true);
  const [is3D, setIs3D] = useState(true);
  const [mobile] = useState<boolean>(detectMobile);
  // WebGL capability: if the browser cannot create a WebGL context at all, the
  // force-graph canvas would paint pure black. Detect it up front so we can show
  // a visible fallback instead of a blank void.
  const [webglOK] = useState<boolean>(() => {
    if (typeof document === "undefined") return true;
    try {
      const c = document.createElement("canvas");
      return !!(c.getContext("webgl2") || c.getContext("webgl") || c.getContext("experimental-webgl"));
    } catch {
      return false;
    }
  });

  const onSelectRef = useRef(onSelectNode);
  onSelectRef.current = onSelectNode;

  // Highlight state kept in refs (read by accessors); a tick forces re-eval.
  const highlightNodes = useRef<Set<string>>(new Set());
  const highlightLinks = useRef<Set<GLink>>(new Set());
  const hoverId = useRef<string | null>(null);
  const focusId = useRef<string | null>(null);
  const [, setTick] = useState(0);
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
  // The 3D canvas needs explicit pixel dimensions. If the wrapper ever measures
  // 0 (a collapsed flex/absolute parent), fall back to the real viewport so the
  // galaxy is NEVER rendered into a zero-height (invisible) canvas.
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
        // If structure is identical to what we already showed, keep it (avoids
        // a needless re-simulation flash).
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
      degMax: Math.max(...degs, 0), mobile, is3D,
    };
  }, [graph, mobile, is3D]);

  // ── Force tuning: wide spacing + warm settling ──
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !graph.nodes.length) return;
    // roomy repulsion so nodes are SPACED OUT (Jack's #1 complaint)
    fg.d3Force("charge")?.strength(mobile ? -140 : -230).distanceMax(1200);
    fg.d3Force("link")?.distance(mobile ? 60 : 90).strength(0.08);
    // gentle centering so the galaxy stays framed but not clustered tight
    if (fg.d3Force("center")) fg.d3Force("center").strength(0.03);
    fg.d3ReheatSimulation?.();
  }, [graph, mobile, is3D]);

  // ── Post-processing: bloom (always) + bokeh DoF (desktop only) ──
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !is3D || !graph.nodes.length) return;
    let cancelled = false;
    const id = window.setTimeout(() => {
      if (cancelled) return;
      try {
        const composer = fg.postProcessingComposer?.();
        if (!composer) return;
        // avoid double-adding on re-runs
        const already = composer.passes?.some(
          (p: unknown) => p instanceof UnrealBloomPass || p instanceof BokehPass
        );
        if (already) return;

        // DEPTH OF FIELD first (desktop only): near nodes soft, far nodes sharp.
        if (!mobile) {
          const scene = fg.scene?.();
          const camera = fg.camera?.();
          if (scene && camera) {
            const bokeh = new BokehPass(scene, camera, {
              focus: 600,      // focus around the galaxy core distance
              aperture: 0.0006, // small aperture = subtle, cinematic
              maxblur: 0.01,
            });
            composer.addPass(bokeh);
          }
        }

        // BLOOM: bright nodes glow and bleed into pure black.
        const bloom = new UnrealBloomPass(
          new THREE.Vector2(size.w || window.innerWidth, size.h || window.innerHeight),
          mobile ? 1.4 : 2.0, // strength (lower on mobile for perf)
          0.75,               // radius
          0                   // threshold: everything blooms a little
        );
        composer.addPass(bloom);
      } catch {
        /* postprocessing unavailable — graph still renders, just no glow */
      }
    }, 120);
    return () => { cancelled = true; window.clearTimeout(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [is3D, graph.nodes.length, mobile]);

  // ── Frame the whole galaxy in view once it exists ──
  // Without this the default camera can sit off to one side of a wide force
  // layout, leaving the viewport looking empty (Jack's "I can't see it"). We fit
  // the camera to the node bounding box shortly after the graph mounts/settles.
  const didFit = useRef(false);
  const fitToView = useCallback(() => {
    const fg = fgRef.current;
    if (!fg || !graph.nodes.length) return;
    try { fg.zoomToFit(600, mobile ? 40 : 80); } catch { /* pre-layout: retry on engine stop */ }
  }, [graph.nodes.length, mobile]);
  useEffect(() => {
    if (!graph.nodes.length) return;
    didFit.current = false;
    // a couple of nudges while the sim warms so the fit lands on real positions
    const t1 = window.setTimeout(fitToView, 400);
    const t2 = window.setTimeout(fitToView, 1500);
    return () => { window.clearTimeout(t1); window.clearTimeout(t2); };
  }, [graph.nodes.length, fitToView]);

  // ── Slow auto-orbit camera (~0.4 rpm) so the galaxy always breathes ──
  const interacting = useRef(false);
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !is3D || !graph.nodes.length) return;
    let angle = 0;
    let raf = 0;
    let last = performance.now();
    // pause orbit while the user is dragging/zooming
    const controls = fg.controls?.();
    const onStart = () => { interacting.current = true; };
    const onEnd = () => { interacting.current = false; };
    controls?.addEventListener?.("start", onStart);
    controls?.addEventListener?.("end", onEnd);

    const RPM = 0.4;
    const step = (now: number) => {
      raf = requestAnimationFrame(step);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (interacting.current || focusId.current) return;
      angle += dt * (RPM * Math.PI * 2 / 60);
      const cam = fg.camera?.();
      if (!cam) return;
      // orbit in the XZ plane around origin, preserving current radius + height
      const r = Math.hypot(cam.position.x, cam.position.z) || 900;
      fg.cameraPosition({
        x: r * Math.sin(angle),
        z: r * Math.cos(angle),
      });
    };
    // seed angle from current camera so the first frame doesn't jump
    const cam0 = fg.camera?.();
    if (cam0) angle = Math.atan2(cam0.position.x, cam0.position.z);
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      controls?.removeEventListener?.("start", onStart);
      controls?.removeEventListener?.("end", onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [is3D, graph.nodes.length]);

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

  // ── Node object: bright sphere (or octahedron for hubs) so bloom glows ──
  // We track each node's material so hover/focus can dim it directly, without
  // reaching into the library's internal object bookkeeping.
  const geomCache = useRef(new Map<string, THREE.BufferGeometry>());
  const nodeMats = useRef<Map<string, THREE.MeshBasicMaterial>>(new Map());
  const nodeThreeObject = useCallback((node: GNode) => {
    const val = node.val ?? 1.6;
    const key = `${node.isHub ? "h" : "s"}:${val.toFixed(1)}`;
    let geom = geomCache.current.get(key);
    if (!geom) {
      geom = node.isHub
        ? new THREE.OctahedronGeometry(val * 1.15, 0)
        : new THREE.SphereGeometry(val, 12, 12);
      geomCache.current.set(key, geom);
    }
    const mat = new THREE.MeshBasicMaterial({ color: node.color ?? "#94a3b8", transparent: true, opacity: 1 });
    nodeMats.current.set(node.id, mat);
    return new THREE.Mesh(geom, mat);
  }, []);

  // Keep material opacity in sync with highlight (visible floor, no blackout).
  const applyDim = useCallback(() => {
    const anyHi = highlightNodes.current.size > 0;
    for (const [id, mat] of nodeMats.current) {
      const on = !anyHi || highlightNodes.current.has(id);
      mat.opacity = on ? 1 : 0.22; // dim floor: dimmed stay visible
    }
  }, []);
  useEffect(() => { applyDim(); });

  // ── Handlers ──
  const onNodeHover = useCallback((node: GNode | null) => {
    if (mobile) return; // no hover on touch
    const id = node?.id ?? null;
    if (id === hoverId.current) return;
    hoverId.current = id;
    if (!focusId.current) setNeighborhood(id);
    if (id) sfx.play("graph-hover");
  }, [mobile, setNeighborhood]);

  const onNodeClick = useCallback((node: GNode) => {
    const fg = fgRef.current;
    focusId.current = node.id;
    setNeighborhood(node.id);
    sfx.play("graph-focus");
    // ease the camera to frame the node
    if (fg && is3D) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const n = node as any;
      const dist = 120;
      const hyp = Math.hypot(n.x || 0, n.y || 0, n.z || 0) || 1;
      const ratio = 1 + dist / hyp;
      fg.cameraPosition(
        { x: (n.x || 0) * ratio, y: (n.y || 0) * ratio, z: (n.z || 0) * ratio },
        n,
        900
      );
    }
    // open the note through the existing contract
    onSelectRef.current(node.path);
  }, [is3D, setNeighborhood]);

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
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([g]) => [g, colorOf(g)] as [string, string]),
    }));
  }, [graph]);

  const anyHi = highlightNodes.current.size > 0;

  return (
    <div ref={wrapRef} className="vault-graph" style={{ position: "relative", width: "100%", height: "100%", minHeight: "60vh", borderRadius: 16, overflow: "hidden", border: "1px solid rgba(255,255,255,0.07)", background: "#04050a" }}>
      {!webglOK && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, textAlign: "center", padding: 24, zIndex: 4, color: "var(--text-muted)" }}>
          <p style={{ fontSize: 14, fontWeight: 700, color: "var(--text-secondary)" }}>Graph needs WebGL</p>
          <p style={{ fontSize: 12 }}>This browser has WebGL disabled, so the galaxy cannot draw. Open the vault tree from the button on the left to browse notes.</p>
          <p style={{ fontSize: 11 }}>{stats.nodes} notes, {stats.links} threads</p>
        </div>
      )}
      {loading && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 14, zIndex: 2 }}>
          Charting the galaxy...
        </div>
      )}

      {webglOK && graph.nodes.length > 0 && (
        <ForceGraph3D
          ref={fgRef}
          width={size.w}
          height={size.h}
          graphData={graph as unknown as { nodes: GNode[]; links: GLink[] }}
          backgroundColor="#04050a"
          numDimensions={is3D ? 3 : 2}
          showNavInfo={false}
          nodeLabel={(n: GNode) => n.name}
          nodeThreeObject={nodeThreeObject}
          nodeVal={(n: GNode) => n.val ?? 1.6}
          nodeOpacity={1}
          linkColor={(l: GLink) => {
            const on = !anyHi || highlightLinks.current.has(l);
            const src = typeof l.source === "object" ? (l.source as GNode) : graph.nodes.find(n => n.id === l.source);
            const base = src?.color ?? "#7fa8d9";
            return on ? base : "rgba(127,168,217,0.10)";
          }}
          linkWidth={(l: GLink) => (highlightLinks.current.has(l) ? 1.6 : 0.4)}
          linkOpacity={0.5}
          linkDirectionalParticles={(l: GLink) =>
            flow ? (anyHi ? (highlightLinks.current.has(l) ? 3 : 0) : 2) : 0
          }
          linkDirectionalParticleSpeed={0.004}
          linkDirectionalParticleWidth={1.5}
          linkDirectionalParticleColor={(l: GLink) => {
            const src = typeof l.source === "object" ? (l.source as GNode) : graph.nodes.find(n => n.id === l.source);
            return src?.color ?? "#7fa8d9";
          }}
          warmupTicks={mobile ? 20 : 40}
          cooldownTicks={mobile ? 90 : 200}
          onNodeHover={onNodeHover}
          onNodeClick={onNodeClick}
          onBackgroundClick={onBgClick}
          onEngineStop={() => {
            // Frame the settled layout so the galaxy is centered and visible.
            if (!didFit.current) { didFit.current = true; fitToView(); }
            if (!restored) sfx.playWhenReady("graph-arrive");
          }}
        />
      )}

      {/* Search-to-highlight */}
      <input
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Search notes..."
        aria-label="Search graph nodes"
        style={{
          position: "absolute", top: 12, right: 12, zIndex: 3, width: 180,
          background: "rgba(8,9,15,0.72)", backdropFilter: "blur(6px)",
          border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10,
          padding: "7px 12px", color: "var(--text-primary)", fontSize: 12, outline: "none",
        }}
      />

      {/* Stats chip */}
      <div style={{
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
      <div style={{ position: "absolute", top: 54, right: 12, zIndex: 3, display: "flex", gap: 6 }}>
        <button
          onClick={() => setFlow(f => !f)}
          aria-pressed={flow}
          style={toggleStyle(flow)}
        >Flow</button>
        <button
          onClick={() => setIs3D(v => !v)}
          aria-pressed={is3D}
          style={toggleStyle(is3D)}
        >{is3D ? "3D" : "2D"}</button>
      </div>

      {/* Legend */}
      <div style={{
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
        {mobile ? "tap to open · drag to orbit" : "hover to light · click to open"}
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
