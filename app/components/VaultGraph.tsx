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

// ── Pre-rendered glow sprites ──
// shadowBlur is one of the most expensive canvas ops; running it per-node
// per-frame across 150+ nodes destroys pan/drag framerate. Instead we bake a
// soft radial-gradient glow ONCE per color into a tiny offscreen canvas and
// drawImage() it — effectively free in the hot path. Cached by color.
const glowSpriteCache = new Map<string, HTMLCanvasElement>();
function glowSprite(color: string): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  let c = glowSpriteCache.get(color);
  if (!c) {
    const S = 64; // sprite is drawn scaled to the node, so a small base is fine
    c = document.createElement("canvas");
    c.width = S; c.height = S;
    const g = c.getContext("2d");
    if (!g) return null;
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0, color);
    grad.addColorStop(0.35, color);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    glowSpriteCache.set(color, c);
  }
  return c;
}

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

export default function VaultGraph({ onSelectNode, onToggleTree }: { onSelectNode: (path: string) => void; onToggleTree?: () => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fg2dRef = useRef<any>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [graph, setGraph] = useState<{ nodes: GNode[]; links: GLink[] }>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);
  const [restored, setRestored] = useState(false);
  const [query, setQuery] = useState("");
  const [flow, setFlow] = useState(false); // off by default: particles force constant redraw
  // 2D canvas is the reliable DEFAULT. 3D is an opt-in enhancement.
  const [is3D, setIs3D] = useState(true); // open in 3D; effectiveIs3D still gates on webglOK so it falls back to 2D safely
  // Glow (bloom / depth-of-field) is a 3D-only, opt-in flourish.
  const [glow, setGlow] = useState(false);
  // Set by the error boundary / WebGL probe: forces the reliable 2D render.
  const [safeMode, setSafeMode] = useState(false);
  const [mobile] = useState<boolean>(detectMobile);
  // Mobile-only: the cluttered control row collapses into one compact bar.
  // Search expands inline, and Flow/Glow/legend/stats live in a tap-to-open
  // popover so they stay out of the way until Jack wants them.
  const [mSearchOpen, setMSearchOpen] = useState(false);
  const [mMenuOpen, setMMenuOpen] = useState(false);
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

  // ── 3D "did it actually paint?" watchdog ──
  // Even with WebGL available, the 3D scene can occasionally mount but never
  // frame the layout (a slow three.js init, a lost context, a fit that fired
  // pre-layout) — leaving a black void. VaultGraph3D calls onFramed() the moment
  // it successfully frames. If that has NOT happened ~1.5s after 3D mounts with
  // real data, we fall back to the always-reliable 2D canvas so SOMETHING is
  // always visible on every load.
  const threeFramed = useRef(false);
  const markThreeFramed = useCallback(() => { threeFramed.current = true; }, []);
  useEffect(() => {
    if (!effectiveIs3D || !graph.nodes.length) return;
    threeFramed.current = false;
    const t = window.setTimeout(() => {
      if (!threeFramed.current) setSafeMode(true); // 3D produced nothing → 2D
    }, 1800); // just past VaultGraph3D's own 1500ms reframe so real 3D isn't downgraded
    return () => window.clearTimeout(t);
  }, [effectiveIs3D, graph.nodes.length]);

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
  // Bumped by the explicit Recenter button; the ONLY sanctioned way to re-fit
  // after Jack has taken control of the view.
  const [recenterN, setRecenterN] = useState(0);

  // ── Interaction flag ──
  // While panning / zooming / dragging (or while the sim is still hot) we draw
  // simplified nodes (plain discs, no glow sprite, no labels) and drop link
  // particles, then restore the pretty render when idle. Kept in a ref so the
  // canvas painter reads it without forcing a React re-render every frame.
  const interacting = useRef(false);
  const interactTimer = useRef<number | null>(null);
  // Once Jack pans/zooms/drags, we NEVER auto-fit/auto-center again (that was the
  // "zips back" bug: the fit-to-view kept re-firing and fought his navigation).
  // Only an explicit mode-switch or Recenter button clears this.
  const hasUserInteracted = useRef(false);
  // zoomToFit() itself emits onZoom/onZoomEnd; while this is set we treat those
  // as OUR framing, not a user pan, so auto-fit doesn't mark itself "interacted".
  const suppressZoom = useRef(false);
  const markInteracting = useCallback(() => {
    if (suppressZoom.current) return; // ignore our own programmatic zoomToFit
    interacting.current = true;
    hasUserInteracted.current = true;
    if (interactTimer.current) window.clearTimeout(interactTimer.current);
    // settle back to the pretty render shortly after the last interaction event
    interactTimer.current = window.setTimeout(() => {
      interacting.current = false;
      bump(); // repaint pretty once idle
    }, 220);
  }, [bump]);

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
  // The blank-graph bug was partly an empty first paint: a cache miss plus a slow
  // or momentarily-empty /api/vault/graph response left graph.nodes at [] and
  // neither the 2D nor 3D branch (both gated on nodes.length > 0) ever mounted.
  // We now keep the cache-first paint AND retry the fetch until it returns a
  // non-empty graph, so nodes are reliably populated on every load.
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
            // with backoff before giving up (never leaves a blank void if the
            // API is briefly warming up).
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
          // Network error: retry with backoff; fall back to cache paint if any.
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
      degMax: Math.max(...degs, 0), mobile, is3D: effectiveIs3D, webglOK,
    };
  }, [graph, mobile, effectiveIs3D, webglOK]);

  // ── 2D force tuning: wide spacing, then settle FAST and stay static ──
  // A faster alpha decay means the layout converges in far fewer ticks and then
  // freezes, so panning/zooming after settle are cheap redraws (no re-sim). We
  // only reheat once, when new graph data actually arrives — never on pan/zoom.
  const lastHeatedFor = useRef<number>(-1);
  useEffect(() => {
    if (effectiveIs3D) return; // 3D tunes its own forces
    const fg = fg2dRef.current;
    if (!fg || !graph.nodes.length) return;
    fg.d3Force("charge")?.strength(mobile ? -120 : -200).distanceMax(1000);
    fg.d3Force("link")?.distance(mobile ? 50 : 80).strength(0.08);
    if (fg.d3Force("center")) fg.d3Force("center").strength(0.04);
    // Settle fast and freeze: higher decay = fewer ticks to cool, cheaper idle.
    fg.d3AlphaDecay?.(0.045);
    fg.d3VelocityDecay?.(0.4);
    // Reheat ONCE per distinct dataset (restored cache is already settled), so a
    // re-render from a pan/hover never re-runs the whole simulation.
    if (lastHeatedFor.current !== graph.nodes.length && !restored) {
      lastHeatedFor.current = graph.nodes.length;
      fg.d3ReheatSimulation?.();
    }
  }, [graph, mobile, effectiveIs3D, restored]);

  // ── Frame the whole layout in view (2D) ──
  // Auto-fit runs ONLY before Jack has interacted. After any pan/zoom/drag the
  // view stays exactly where he left it (see hasUserInteracted). A mode switch
  // clears the flag so the fresh render gets framed once.
  const didFit = useRef(false);
  const fitToView2D = useCallback((force = false) => {
    const fg = fg2dRef.current;
    if (!fg || !graph.nodes.length) return;
    if (!force && hasUserInteracted.current) return; // never fight manual nav
    suppressZoom.current = true;
    try { fg.zoomToFit(600, mobile ? 30 : 60); } catch { /* pre-layout: retry on engine stop */ }
    // Release after the zoom animation (600ms) plus a margin so the trailing
    // onZoomEnd from our own framing doesn't count as a user interaction.
    window.setTimeout(() => { suppressZoom.current = false; }, 750);
  }, [graph.nodes.length, mobile]);
  useEffect(() => {
    if (effectiveIs3D || !graph.nodes.length) return;
    // Entering (or re-entering) 2D is a fresh view; allow one framing pass.
    hasUserInteracted.current = false;
    didFit.current = false;
    const t1 = window.setTimeout(() => fitToView2D(), 400);
    const t2 = window.setTimeout(() => fitToView2D(), 1500);
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
  // NOTE: no shadowBlur anywhere in this painter (the hot path). The glow look
  // comes from a pre-baked radial-gradient sprite drawn with drawImage, and it
  // is skipped entirely while interacting so pan/drag stay buttery.
  const paintNode = useCallback((node: GNode, ctx: CanvasRenderingContext2D, scale: number) => {
    const x = node.x ?? 0, y = node.y ?? 0;
    const on = !anyHi || highlightNodes.current.has(node.id);
    const r = Math.max(1.5, (node.val ?? 1.6));
    const color = node.color ?? "#94a3b8";
    const busy = interacting.current;
    ctx.save();
    ctx.globalAlpha = on ? 1 : 0.22;

    // Soft glow via a pre-rendered sprite (cheap drawImage) — pretty render only.
    if (!busy) {
      const sprite = glowSprite(color);
      if (sprite) {
        const gr = r * (node.isHub ? 3.4 : 2.6);
        ctx.globalAlpha = (on ? 1 : 0.22) * (node.isHub ? 0.5 : 0.35);
        ctx.drawImage(sprite, x - gr, y - gr, gr * 2, gr * 2);
        ctx.globalAlpha = on ? 1 : 0.22;
      }
    }

    // Solid disc (always).
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();

    if (node.isHub) {
      // bright ring so hubs read as hubs even before you zoom in
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.stroke();
    }

    // Labels.
    //  · HUBS: always labeled at any zoom, and kept even during pan/drag (there
    //    are only a handful, so it stays cheap). A dark halo keeps text legible
    //    over nodes and links.
    //  · Leaves: fade in only when zoomed in enough, and hidden while busy.
    const hubLabel = on && node.isHub;
    const leafLabel = !busy && on && !node.isHub && scale > 2.4;
    if (hubLabel || leafLabel) {
      const fontSize = node.isHub
        ? Math.min(10, Math.max(4.5, 17 / scale)) // hubs bigger, readable when zoomed out
        : Math.min(5, 11 / scale);
      ctx.font = `${node.isHub ? "700 " : ""}${fontSize}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      // dark halo/background so the label stays legible over nodes and links
      ctx.lineWidth = fontSize * (node.isHub ? 0.6 : 0.4);
      ctx.strokeStyle = "rgba(3,4,8,0.92)";
      ctx.lineJoin = "round";
      ctx.strokeText(node.name, x, y + r + 1);
      ctx.fillStyle = node.isHub ? "#ffffff" : "rgba(226,232,240,0.92)";
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
          linkWidth={(l: GLink) => (highlightLinks.current.has(l) ? 1.4 : 0.3)}
          linkCurvature={0.12}
          linkDirectionalParticles={(l: GLink) => {
            // Particles animate every frame, forcing a full-canvas redraw for as
            // long as ANY exist. So: NONE at idle (graph stays static and cheap),
            // and only on the few highlighted links while hovering/searching.
            if (!flow || interacting.current || !anyHi) return 0;
            return highlightLinks.current.has(l) ? 2 : 0;
          }}
          linkDirectionalParticleSpeed={0.004}
          linkDirectionalParticleWidth={1.4}
          linkDirectionalParticleColor={(l: GLink) => {
            const src = typeof l.source === "object" ? (l.source as GNode) : graph.nodes.find(n => n.id === lid(l.source));
            return src?.color ?? "#7fa8d9";
          }}
          warmupTicks={restored ? 0 : (mobile ? 12 : 20)}
          cooldownTicks={mobile ? 60 : 80}
          cooldownTime={8000}
          onNodeHover={onNodeHover}
          onNodeClick={onNodeClick}
          onNodeDrag={markInteracting}
          onNodeDragEnd={markInteracting}
          onZoom={markInteracting}
          onZoomEnd={markInteracting}
          onBackgroundClick={onBgClick}
          onEngineStop={() => {
            // Frame once when the layout first settles, but never after Jack has
            // already moved the view (that re-fit was the "zips back" bug).
            if (!didFit.current && !hasUserInteracted.current) {
              didFit.current = true;
              fitToView2D();
            }
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
            recenterN={recenterN}
            onNodeHover={onNodeHover}
            onNodeClick={onNodeClick}
            onBackgroundClick={onBgClick}
            onFramed={markThreeFramed}
          />
        </GraphErrorBoundary>
      )}

      {/* ═══════════ MOBILE: one compact, unobtrusive control bar ═══════════ */}
      {/* The graph is the hero. All chrome collapses into a single quiet row of
          icon buttons floating over the graph: contents (tree) · search ·
          recenter · 3D · more. Search expands inline; Flow/Glow/legend/stats
          live in the "more" popover so they never take standing space. */}
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
            <button
              onClick={() => {
                hasUserInteracted.current = false;
                if (effectiveIs3D) setRecenterN(n => n + 1);
                else fitToView2D(true);
              }}
              aria-label="Recenter map" title="Recenter" style={mIconStyle(false)}
            ><IconRecenter /></button>
            <button
              onClick={() => { setSafeMode(false); setIs3D(v => !v); }}
              aria-pressed={effectiveIs3D}
              disabled={!webglOK}
              aria-label="Toggle 3D" title={webglOK ? "Toggle 3D" : "3D needs WebGL"}
              style={{ ...mIconStyle(effectiveIs3D), opacity: webglOK ? 1 : 0.4 }}
            ><span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.02em" }}>{effectiveIs3D ? "3D" : "2D"}</span></button>
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
              style={{
                position: "absolute", top: 52, left: 10, right: 10, zIndex: 4,
                background: "rgba(8,9,15,0.92)", backdropFilter: "blur(8px)",
                border: "1px solid rgba(96,165,250,0.4)", borderRadius: 10,
                padding: "9px 12px", color: "var(--text-primary)", fontSize: 13, outline: "none",
              }}
            />
          )}

          {/* "More" popover — secondary toggles + legend + stats, tucked away */}
          {mMenuOpen && (
            <div className="vg-mpop" style={{
              position: "absolute", top: 52, right: 10, zIndex: 5, width: "min(72vw, 260px)",
              background: "rgba(8,9,15,0.94)", backdropFilter: "blur(10px)",
              border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14, padding: 12,
              boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
              display: "flex", flexDirection: "column", gap: 12,
            }}>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setFlow(f => !f)} aria-pressed={flow} style={{ ...toggleStyle(flow), flex: 1, textAlign: "center" }}>Flow</button>
                <button
                  onClick={() => setGlow(g => !g)}
                  aria-pressed={effectiveGlow}
                  disabled={!effectiveIs3D}
                  title={effectiveIs3D ? "Bloom / depth-of-field glow" : "Glow is available in 3D"}
                  style={{ ...toggleStyle(effectiveGlow), flex: 1, textAlign: "center", opacity: effectiveIs3D ? 1 : 0.4 }}
                >Glow</button>
              </div>
              <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 6, maxHeight: "34vh", overflow: "auto" }}>
                <p style={{ fontSize: 9, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                  {stats.nodes} notes · {stats.links} threads
                </p>
                {legend.map(({ family, color }) => (
                  <div key={family} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, boxShadow: `0 0 8px ${color}`, flexShrink: 0 }} />
                    <span style={{ fontSize: 10.5, color: "var(--text-secondary)", textTransform: "capitalize" }}>{family}</span>
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
          onClick={() => {
            // Explicit re-frame. Clears the "hands off" flag and fits once.
            hasUserInteracted.current = false;
            if (effectiveIs3D) setRecenterN(n => n + 1);
            else fitToView2D(true);
          }}
          title="Re-frame the whole map"
          style={toggleStyle(false)}
        >Recenter</button>
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
        hover to light · click to open · scroll to zoom
      </div>
      </>)}
    </div>
  );
}

// Compact, quiet icon button used only in the mobile control bar.
function mIconStyle(active: boolean): React.CSSProperties {
  return {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: 34, height: 34, minHeight: 34, padding: 0, flexShrink: 0,
    background: active ? "rgba(96,165,250,0.22)" : "rgba(8,9,15,0.72)",
    backdropFilter: "blur(6px)",
    border: `1px solid ${active ? "rgba(96,165,250,0.55)" : "rgba(255,255,255,0.12)"}`,
    borderRadius: 10,
    color: active ? "#dbeafe" : "var(--text-muted)",
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
    background: active ? "rgba(96,165,250,0.22)" : "rgba(8,9,15,0.72)",
    backdropFilter: "blur(6px)",
    border: `1px solid ${active ? "rgba(96,165,250,0.55)" : "rgba(255,255,255,0.1)"}`,
    borderRadius: 10, padding: "6px 12px",
    color: active ? "#dbeafe" : "var(--text-muted)",
    fontSize: 11, fontWeight: 600, cursor: "pointer",
  };
}
