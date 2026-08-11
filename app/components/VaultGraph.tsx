"use client";
// VAULT GRAPH — canvas constellation of Jack's business brain.
// - Layout persistence: graph JSON + settled node positions live in
//   localStorage, keyed by the API's structural hash. Revisits render
//   instantly from the saved layout; the force sim only runs when the
//   graph actually changed, and even then it is seeded with the old
//   positions so only new/changed nodes settle.
// - Rendering: 2d canvas (starfield parallax, glow sprites, luminous
//   threads), d3-force for layout, d3-zoom for smooth zoom/pan.
// - Interactions: hover lights the neighborhood, click focuses (camera
//   eases in), double-click opens the note, search-to-highlight, legend,
//   gentle idle drift. Space-y sounds via the shared sfx engine.
import { useEffect, useRef, useState, useCallback } from "react";
import * as d3 from "d3";
import { sfx } from "../lib/sounds";

interface GNode {
  id: string;
  name: string;
  path: string;
  group: string;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}
interface GLink {
  source: string | GNode;
  target: string | GNode;
}

const LS_LAYOUT = "wingos-vault-graph-layout-v1";

// ── Warm the graph API as soon as this module loads ──
// Once per session, low priority: by the time Jack opens the vault view the
// serverless function is warm and the JSON is in the HTTP cache.
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

// Folder palette — strongly differentiated, Obsidian-style. Keys match the
// API's classified buckets (wiki/clients/x.md classifies as "clients").
const GROUP_COLORS: Record<string, string> = {
  wiki: "#38bdf8",        // sky blue
  clients: "#22c55e",     // green
  campaigns: "#f59e0b",   // amber
  automations: "#a855f7", // purple
  agents: "#ec4899",      // pink
  state: "#f97316",       // orange
  syntheses: "#eab308",   // yellow
  inbox: "#ef4444",       // red
  root: "#94a3b8",        // slate
};
// Deterministic distinct color for any unmapped folder, so new buckets never
// all collapse into one grey.
const fallbackCache = new Map<string, string>();
function colorOf(g: string): string {
  const known = GROUP_COLORS[g];
  if (known) return known;
  let c = fallbackCache.get(g);
  if (!c) {
    let h = 0;
    for (let i = 0; i < g.length; i++) h = (h * 31 + g.charCodeAt(i)) >>> 0;
    // Must be 6-digit hex: sprite rendering appends hex alpha ("cc" etc).
    c = hslToHex(h % 360, 75, 62);
    fallbackCache.set(g, c);
  }
  return c;
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

// Obsidian-style dramatic sizing: tiny leaves, unmistakably big hubs.
function nodeRadius(deg: number): number {
  return Math.min(18, 2.5 + Math.sqrt(deg) * 2.6);
}
const HUB_DEG = 8; // degree at which a node reads as a hub (halo + label)

function lid(x: string | GNode): string {
  return typeof x === "string" ? x : x.id;
}

interface SavedLayout {
  hash: string;
  nodes: { id: string; name: string; path: string; group: string; x: number; y: number }[];
  links: { source: string; target: string }[];
  savedAt: number;
}

function loadLayout(): SavedLayout | null {
  try {
    const raw = window.localStorage.getItem(LS_LAYOUT);
    if (!raw) return null;
    const v = JSON.parse(raw) as SavedLayout;
    if (!v || !Array.isArray(v.nodes) || !Array.isArray(v.links)) return null;
    return v;
  } catch {
    return null;
  }
}

// Pre-rendered glow sprite per color: a soft radial gradient we drawImage,
// which is far cheaper than per-frame shadowBlur.
function makeGlowSprite(color: string): HTMLCanvasElement {
  const size = 64;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d")!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, color + "cc");
  grad.addColorStop(0.25, color + "66");
  grad.addColorStop(0.6, color + "1a");
  grad.addColorStop(1, color + "00");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return c;
}

export default function VaultGraph({ onSelectNode }: { onSelectNode: (path: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [restored, setRestored] = useState(false);
  const [stats, setStats] = useState({ nodes: 0, links: 0 });
  const [legend, setLegend] = useState<[string, string][]>([]);
  const [query, setQuery] = useState("");
  const queryRef = useRef("");
  queryRef.current = query.trim().toLowerCase();
  const onSelectRef = useRef(onSelectNode);
  onSelectRef.current = onSelectNode;

  // All mutable graph state lives here so the render loop never re-binds.
  const stateRef = useRef<{
    nodes: GNode[];
    links: { source: GNode; target: GNode }[];
    degree: Map<string, number>;
    hood: Map<string, Set<string>>;
    sim: d3.Simulation<GNode, GLink> | null;
    transform: d3.ZoomTransform;
    hoverId: string | null;
    focusId: string | null;
    hash: string;
    raf: number;
    driftT0: number;
    readyAt: number; // when layout became stable (for drift ease-in)
    stars: { x: number; y: number; r: number; a: number; layer: number }[];
    sprites: Map<string, HTMLCanvasElement>;
    arrived: boolean;
  }>({
    nodes: [],
    links: [],
    degree: new Map(),
    hood: new Map(),
    sim: null,
    transform: d3.zoomIdentity,
    hoverId: null,
    focusId: null,
    hash: "",
    raf: 0,
    driftT0: 0,
    readyAt: 0,
    stars: [],
    sprites: new Map(),
    arrived: false,
  });

  const saveLayout = useCallback(() => {
    const s = stateRef.current;
    if (!s.nodes.length || !s.hash) return;
    try {
      const payload: SavedLayout = {
        hash: s.hash,
        nodes: s.nodes.map(n => ({
          id: n.id, name: n.name, path: n.path, group: n.group,
          x: Math.round((n.x ?? 0) * 10) / 10,
          y: Math.round((n.y ?? 0) * 10) / 10,
        })),
        links: s.links.map(l => ({ source: l.source.id, target: l.target.id })),
        savedAt: Date.now(),
      };
      window.localStorage.setItem(LS_LAYOUT, JSON.stringify(payload));
    } catch {
      /* storage full/unavailable: graph still works, just no instant restore */
    }
  }, []);

  // Install a graph (from cache or API) into state; optionally run physics.
  const installGraph = useCallback((
    rawNodes: { id: string; name: string; path: string; group: string; x?: number; y?: number }[],
    rawLinks: { source: string; target: string }[],
    hash: string,
    opts: { settled: boolean; seed?: Map<string, [number, number]> }
  ) => {
    const s = stateRef.current;
    const W = wrapRef.current?.clientWidth || 800;
    const H = wrapRef.current?.clientHeight || 600;

    const degree = new Map<string, number>();
    for (const n of rawNodes) degree.set(n.id, 0);
    for (const l of rawLinks) {
      degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
      degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
    }

    // Group centroids of seeded nodes, so brand-new notes are born near
    // their folder's territory instead of at the origin.
    const centroids = new Map<string, { x: number; y: number; n: number }>();
    if (opts.seed) {
      for (const n of rawNodes) {
        const p = opts.seed.get(n.id);
        if (!p) continue;
        const c = centroids.get(n.group) ?? { x: 0, y: 0, n: 0 };
        c.x += p[0]; c.y += p[1]; c.n++;
        centroids.set(n.group, c);
      }
    }

    const nodes: GNode[] = rawNodes.map((n, i) => {
      const seeded = opts.seed?.get(n.id);
      if (seeded) return { ...n, x: seeded[0], y: seeded[1] };
      if (n.x != null && n.y != null) return { ...n };
      const c = centroids.get(n.group);
      const a = (i * 2.399963) % (Math.PI * 2);
      if (c && c.n > 0) {
        return { ...n, x: c.x / c.n + Math.cos(a) * 60, y: c.y / c.n + Math.sin(a) * 60 };
      }
      return { ...n, x: W / 2 + Math.cos(a) * 220, y: H / 2 + Math.sin(a) * 220 };
    });
    const byId = new Map(nodes.map(n => [n.id, n]));
    const links = rawLinks
      .filter(l => byId.has(l.source) && byId.has(l.target))
      .map(l => ({ source: byId.get(l.source)!, target: byId.get(l.target)! }));

    const hood = new Map<string, Set<string>>();
    for (const n of nodes) hood.set(n.id, new Set([n.id]));
    for (const l of links) {
      hood.get(l.source.id)!.add(l.target.id);
      hood.get(l.target.id)!.add(l.source.id);
    }

    s.sim?.stop();
    s.nodes = nodes;
    s.links = links;
    s.degree = degree;
    s.hood = hood;
    s.hash = hash;
    setStats({ nodes: nodes.length, links: links.length });

    // Dynamic legend: buckets actually present, biggest first.
    const groupCounts = new Map<string, number>();
    for (const n of nodes) groupCounts.set(n.group, (groupCounts.get(n.group) ?? 0) + 1);
    setLegend(
      [...groupCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([g]) => [g, colorOf(g)] as [string, string])
    );
    // Debug/verification hook: bucket distribution + radius range.
    const degs = nodes.map(n => degree.get(n.id) ?? 0);
    (window as unknown as { __vaultGraphDebug?: unknown }).__vaultGraphDebug = {
      buckets: Object.fromEntries(groupCounts),
      radiusMin: nodeRadius(Math.min(...degs, 0)),
      radiusMax: nodeRadius(Math.max(...degs, 0)),
    };

    // Sprites for any new colors
    for (const n of nodes) {
      const c = colorOf(n.group);
      if (!s.sprites.has(c)) s.sprites.set(c, makeGlowSprite(c));
    }

    const sim = d3.forceSimulation<GNode>(nodes)
      .force("link", d3.forceLink<GNode, GLink>(links as unknown as GLink[]).id(d => d.id).distance(85).strength(0.12))
      .force("charge", d3.forceManyBody().strength(-220).distanceMin(8).distanceMax(800))
      .force("x", d3.forceX(W / 2).strength(0.02))
      .force("y", d3.forceY(H / 2).strength(0.02))
      .force("collision", d3.forceCollide<GNode>(d => radiusOf(d.id) + 10))
      .alphaDecay(0.03)
      .velocityDecay(0.4);
    s.sim = sim;

    if (opts.settled) {
      // Fully restored layout: no visible re-simulation at all.
      sim.alpha(0).stop();
      s.readyAt = performance.now();
      settleDone(true);
    } else {
      // Partial reheat: seeded nodes barely move, new nodes find their spot.
      sim.alpha(opts.seed && opts.seed.size > 0 ? 0.25 : 1).restart();
      sim.on("end", () => {
        s.readyAt = performance.now();
        saveLayout();
        settleDone(false);
      });
    }

    function radiusOf(id: string): number {
      return nodeRadius(degree.get(id) ?? 0);
    }

    function settleDone(fromCache: boolean) {
      setLoading(false);
      setRestored(fromCache);
      if (!s.arrived) {
        s.arrived = true;
        // Plays now if audio is already unlocked by a prior gesture, otherwise
        // queues for the first interaction instead of being dropped.
        sfx.playWhenReady("graph-arrive");
      }
      if (!fromCache) fitView();
    }

    function fitView() {
      const canvas = canvasRef.current;
      if (!canvas || !nodes.length) return;
      const xs = nodes.map(n => n.x!), ys = nodes.map(n => n.y!);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
      const k = Math.min(1.6, 0.82 * Math.min(W / bw, H / bh));
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      const zb = zoomRef.current;
      if (!zb) return;
      d3.select(canvas).transition().duration(1200).ease(d3.easeCubicInOut).call(
        zb.transform as never,
        d3.zoomIdentity.translate(W / 2 - k * cx, H / 2 - k * cy).scale(k)
      );
    }
  }, [saveLayout]);

  const zoomRef = useRef<d3.ZoomBehavior<HTMLCanvasElement, unknown> | null>(null);

  // ── Mount: restore cache instantly, then reconcile with the API ──
  useEffect(() => {
    const s = stateRef.current;
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;

    // Starfield (two parallax layers), generated once.
    const rand = d3.randomLcg(7);
    s.stars = [];
    for (let i = 0; i < 220; i++) {
      const layer = i % 3 === 0 ? 1 : 0; // 0 = far, 1 = near
      s.stars.push({
        x: rand(), y: rand(),
        r: layer ? rand() * 1.4 + 0.4 : rand() * 0.8 + 0.2,
        a: layer ? rand() * 0.25 + 0.06 : rand() * 0.14 + 0.02,
        layer,
      });
    }

    const saved = loadLayout();
    if (saved && saved.nodes.length) {
      installGraph(saved.nodes, saved.links, saved.hash, { settled: true });
    }

    fetch("/api/vault/graph")
      .then(r => r.json())
      .then((g: { nodes: GNode[]; links: { source: string; target: string }[]; hash?: string }) => {
        const hash = g.hash ?? "";
        if (saved && saved.hash && hash && saved.hash === hash) {
          // Structure unchanged: keep the saved positions, but refresh
          // node groups/names from the API. Groups are not part of the
          // hash, so a stale layout must never pin old colors forever.
          const pos = new Map(saved.nodes.map(n => [n.id, n]));
          const groupsChanged = g.nodes.some(n => pos.get(n.id)?.group !== n.group);
          if (groupsChanged) {
            installGraph(
              g.nodes.map(n => {
                const p = pos.get(n.id);
                return { id: n.id, name: n.name, path: n.path, group: n.group, x: p?.x, y: p?.y };
              }),
              g.links,
              hash,
              { settled: true }
            );
            saveLayout();
          }
          return;
        }
        // Changed (or no cache): seed with whatever positions we have.
        const seed = new Map<string, [number, number]>();
        if (saved) for (const n of saved.nodes) seed.set(n.id, [n.x, n.y]);
        installGraph(
          g.nodes.map(n => ({ id: n.id, name: n.name, path: n.path, group: n.group })),
          g.links,
          hash,
          { settled: false, seed: seed.size ? seed : undefined }
        );
      })
      .catch(() => setLoading(false));

    // ── Canvas sizing ──
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = wrap.clientWidth * dpr;
      canvas.height = wrap.clientHeight * dpr;
      canvas.style.width = wrap.clientWidth + "px";
      canvas.style.height = wrap.clientHeight + "px";
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    // ── Zoom/pan ──
    let lastK = 1;
    const zoom = d3.zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.06, 8])
      .on("zoom", (e) => {
        s.transform = e.transform;
        if (Math.abs(Math.log(e.transform.k / lastK)) > 0.3) {
          lastK = e.transform.k;
          if (e.sourceEvent) sfx.play("graph-zoom");
        }
      });
    zoomRef.current = zoom;
    const sel = d3.select(canvas);
    sel.call(zoom).on("dblclick.zoom", null);
    sel.call(zoom.transform as never, d3.zoomIdentity.translate(wrap.clientWidth * 0.1, wrap.clientHeight * 0.1).scale(0.8));

    // ── Picking ──
    const pick = (mx: number, my: number): GNode | null => {
      const t = s.transform;
      const x = (mx - t.x) / t.k;
      const y = (my - t.y) / t.k;
      let best: GNode | null = null;
      let bestD = (14 / t.k + 6) ** 2;
      for (const n of s.nodes) {
        const dx = (n.x ?? 0) - x, dy = (n.y ?? 0) - y;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = n; }
      }
      return best;
    };

    const onMove = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      const hit = pick(e.clientX - r.left, e.clientY - r.top);
      const id = hit?.id ?? null;
      if (id !== s.hoverId) {
        s.hoverId = id;
        canvas.style.cursor = id ? "pointer" : "grab";
        if (id) sfx.play("graph-hover");
      }
    };
    const onLeave = () => { s.hoverId = null; };

    let lastClick = 0;
    let lastClickId: string | null = null;
    const onClick = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      const hit = pick(e.clientX - r.left, e.clientY - r.top);
      const now = Date.now();
      if (hit) {
        if (lastClickId === hit.id && now - lastClick < 350) {
          // double-click: open the note in the existing viewer
          onSelectRef.current(hit.path);
        } else if (s.focusId !== hit.id) {
          // focus mode: ease the camera into the node's neighborhood
          s.focusId = hit.id;
          sfx.play("graph-focus");
          const W2 = wrap.clientWidth, H2 = wrap.clientHeight;
          const k = Math.max(s.transform.k, 1.6);
          sel.transition().duration(900).ease(d3.easeCubicInOut).call(
            zoom.transform as never,
            d3.zoomIdentity.translate(W2 / 2 - k * (hit.x ?? 0), H2 / 2 - k * (hit.y ?? 0)).scale(k)
          );
        }
      } else if (s.focusId) {
        s.focusId = null;
      }
      lastClick = now;
      lastClickId = hit?.id ?? null;
    };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("click", onClick);

    // ── Drag nodes ──
    const drag = d3.drag<HTMLCanvasElement, unknown, GNode>()
      .subject((e) => {
        const r = canvas.getBoundingClientRect();
        return pick(e.sourceEvent.clientX - r.left, e.sourceEvent.clientY - r.top) as never;
      })
      .on("start", (e) => {
        const d = e.subject as GNode | null;
        if (!d) return;
        s.sim?.alphaTarget(0.15).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on("drag", (e) => {
        const d = e.subject as GNode | null;
        if (!d) return;
        const t = s.transform;
        const r = canvas.getBoundingClientRect();
        d.fx = (e.sourceEvent.clientX - r.left - t.x) / t.k;
        d.fy = (e.sourceEvent.clientY - r.top - t.y) / t.k;
      })
      .on("end", (e) => {
        const d = e.subject as GNode | null;
        if (!d) return;
        s.sim?.alphaTarget(0);
        d.fx = null; d.fy = null;
        saveLayout();
      })
      .filter((e) => {
        const r = canvas.getBoundingClientRect();
        return !!pick(e.clientX - r.left, e.clientY - r.top);
      });
    sel.call(drag as never);

    // ── Render loop ──
    s.driftT0 = performance.now();
    const draw = (now: number) => {
      s.raf = requestAnimationFrame(draw);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = canvas.width / dpr, H = canvas.height / dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // deep space background with a faint nebula glow
      ctx.fillStyle = "#04050a";
      ctx.fillRect(0, 0, W, H);
      const neb = ctx.createRadialGradient(W * 0.35, H * 0.3, 0, W * 0.35, H * 0.3, Math.max(W, H) * 0.8);
      neb.addColorStop(0, "rgba(34,60,110,0.12)");
      neb.addColorStop(0.5, "rgba(60,30,90,0.06)");
      neb.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = neb;
      ctx.fillRect(0, 0, W, H);

      const t = s.transform;

      // parallax starfield
      for (const st of s.stars) {
        const par = st.layer ? 0.13 : 0.05;
        const sx = (((st.x * W * 2 + t.x * par) % (W * 1.2)) + W * 1.2) % (W * 1.2) - W * 0.1;
        const sy = (((st.y * H * 2 + t.y * par) % (H * 1.2)) + H * 1.2) % (H * 1.2) - H * 0.1;
        ctx.globalAlpha = st.a;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(sx, sy, st.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (!s.nodes.length) return;

      // idle drift: purely visual offset, eased in after settle,
      // never touches the physics or the saved positions
      const settled = s.readyAt > 0 && (!s.sim || s.sim.alpha() < 0.02);
      const ease = settled ? Math.min(1, (now - s.readyAt) / 3000) : 0;
      const dt = (now - s.driftT0) / 1000;
      const driftX = (n: GNode, i: number) =>
        (n.x ?? 0) + (ease ? Math.cos(dt * (0.12 + (i % 7) * 0.02) + i) * 3.5 * ease : 0);
      const driftY = (n: GNode, i: number) =>
        (n.y ?? 0) + (ease ? Math.sin(dt * (0.1 + (i % 5) * 0.025) + i * 1.7) * 3.5 * ease : 0);
      const idx = new Map<string, number>();
      s.nodes.forEach((n, i) => idx.set(n.id, i));

      // active set: hover neighborhood, focus neighborhood, or search matches
      const q = queryRef.current;
      let active: Set<string> | null = null;
      if (s.focusId) active = s.hood.get(s.focusId) ?? null;
      else if (s.hoverId) active = s.hood.get(s.hoverId) ?? null;
      else if (q) {
        active = new Set();
        for (const n of s.nodes) if (n.name.toLowerCase().includes(q)) active.add(n.id);
      }

      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.scale(t.k, t.k);

      // links: faint luminous threads
      for (const l of s.links) {
        const si = idx.get(l.source.id)!, ti = idx.get(l.target.id)!;
        const x1 = driftX(l.source, si), y1 = driftY(l.source, si);
        const x2 = driftX(l.target, ti), y2 = driftY(l.target, ti);
        const hot = active
          ? (active.has(l.source.id) && active.has(l.target.id)) ||
            (s.hoverId != null && (l.source.id === s.hoverId || l.target.id === s.hoverId)) ||
            (s.focusId != null && (l.source.id === s.focusId || l.target.id === s.focusId))
          : false;
        ctx.strokeStyle = hot ? colorOf(l.source.group) : "#7fa8d9";
        ctx.globalAlpha = active ? (hot ? 0.55 : 0.03) : 0.1;
        ctx.lineWidth = (hot ? 1.4 : 0.6) / t.k;
        ctx.beginPath();
        const mx = (x1 + x2) / 2 - (y2 - y1) * 0.12;
        const my = (y1 + y2) / 2 + (x2 - x1) * 0.12;
        ctx.moveTo(x1, y1);
        ctx.quadraticCurveTo(mx, my, x2, y2);
        ctx.stroke();
      }

      // nodes: glow sprite + core, sized by connections
      for (let i = 0; i < s.nodes.length; i++) {
        const n = s.nodes[i];
        const x = driftX(n, i), y = driftY(n, i);
        const deg = s.degree.get(n.id) ?? 0;
        const r = nodeRadius(deg);
        const color = colorOf(n.group);
        const isHot = !active || active.has(n.id);
        const isFocal = n.id === s.hoverId || n.id === s.focusId;
        const isHub = deg >= HUB_DEG;
        ctx.globalAlpha = isHot ? 1 : 0.13;
        const sprite = s.sprites.get(color);
        if (sprite) {
          // Hubs get a clearly wider, brighter halo than leaves.
          const gs = r * (isFocal ? 7 : isHub ? 5.8 : 4);
          ctx.globalAlpha = (isHot ? (isFocal ? 0.95 : isHub ? 0.75 : 0.45) : 0.06);
          ctx.drawImage(sprite, x - gs / 2, y - gs / 2, gs, gs);
        }
        ctx.globalAlpha = isHot ? (isHub ? 1 : 0.92) : 0.18;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        if (isFocal || isHub) {
          ctx.globalAlpha = isHot ? 0.9 : 0.2;
          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.arc(x, y, Math.max(1.2, r * 0.35), 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // labels: fade in by zoom level; hovered/focused/hub always
      const labelAlpha = Math.max(0, Math.min(0.9, (t.k - 1.0) / 0.8));
      ctx.textAlign = "center";
      ctx.font = `${Math.max(9, 11 / t.k)}px system-ui, sans-serif`;
      for (let i = 0; i < s.nodes.length; i++) {
        const n = s.nodes[i];
        const deg = s.degree.get(n.id) ?? 0;
        const isFocal = n.id === s.hoverId || n.id === s.focusId;
        const inHood = active?.has(n.id) ?? false;
        let a = labelAlpha;
        if (isFocal) a = 1;
        else if (active) a = inHood ? Math.max(labelAlpha, 0.85) : 0;
        else if (deg >= HUB_DEG) a = Math.max(labelAlpha, 0.6);
        if (a <= 0.02) continue;
        const x = driftX(n, i), y = driftY(n, i);
        const r = nodeRadius(deg);
        ctx.globalAlpha = a;
        ctx.fillStyle = isFocal ? "#eaf6ff" : "#9db4cc";
        ctx.fillText(n.name, x, y + r + 12 / t.k);
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    };
    s.raf = requestAnimationFrame(draw);

    const onUnload = () => saveLayout();
    window.addEventListener("beforeunload", onUnload);

    return () => {
      cancelAnimationFrame(s.raf);
      s.sim?.stop();
      saveLayout();
      ro.disconnect();
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("click", onClick);
      window.removeEventListener("beforeunload", onUnload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%", height: "100%", borderRadius: 16, overflow: "hidden", border: "1px solid rgba(255,255,255,0.07)", background: "#04050a" }}>
      {loading && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 14, zIndex: 2 }}>
          Charting the constellation...
        </div>
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
          Jack&apos;s AI Brain
        </p>
        <p style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
          {stats.nodes} notes · {stats.links} threads{restored ? " · restored" : ""}
        </p>
      </div>

      {/* Legend */}
      <div style={{
        position: "absolute", bottom: 12, left: 12, zIndex: 3,
        background: "rgba(8,9,15,0.7)", backdropFilter: "blur(6px)",
        border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: "8px 12px",
        display: "flex", flexDirection: "column", gap: 4,
      }}>
        {legend.map(([name, color]) => (
          <div key={name} style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, boxShadow: `0 0 6px ${color}` }} />
            <span style={{ fontSize: 10, color: "var(--text-secondary)", textTransform: "capitalize" }}>{name}</span>
          </div>
        ))}
      </div>

      {/* Hint */}
      <div style={{ position: "absolute", bottom: 12, right: 12, zIndex: 3, fontSize: 9.5, color: "rgba(157,180,204,0.5)" }}>
        click to focus · double-click to open
      </div>

      <canvas ref={canvasRef} style={{ display: "block", cursor: "grab" }} />
    </div>
  );
}
