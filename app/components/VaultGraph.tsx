"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import * as d3 from "d3";

interface Node {
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

interface Link {
  source: string | Node;
  target: string | Node;
}

// firefly palette — warm amber golds with subtle variation per compartment,
// plus one teal accent reserved for the single most important note
const CLUSTER_COLORS = [
  "#f6b93b", "#ffd67e", "#e89b3c", "#f8c15a", "#f0a830",
  "#ffcb52", "#e2892b", "#f7c873", "#ffbf45", "#eda93e",
];
const GOD_COLOR = "#4ee6a8";
const DUST_COLOR = "#8a7a55";

function linkId(x: string | Node): string {
  return typeof x === "string" ? x : x.id;
}

export default function VaultGraph({ onSelectNode }: { onSelectNode: (path: string) => void }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<d3.Simulation<Node, Link> | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const nodePosRef = useRef<Map<string, Node>>(new Map());
  const dataRef = useRef<{ nodes: Node[]; links: Link[] } | null>(null);

  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ nodes: 0, links: 0, clusters: 0 });
  const [showChip, setShowChip] = useState(false);
  const driftRef = useRef<{ raf: number; paused: boolean; t0?: number }>({ raf: 0, paused: false });

  useEffect(() => {
    fetch("/api/vault/graph")
      .then(r => r.json())
      .then(({ nodes, links }) => {
        dataRef.current = { nodes, links };
        setLoading(false);
        buildGraph(nodes, links);
      });
    return () => cancelAnimationFrame(driftRef.current.raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function buildGraph(allNodes: Node[], allLinks: Link[]) {
    const svgEl = svgRef.current!;
    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();
    simRef.current?.stop();
    cancelAnimationFrame(driftRef.current.raf);

    // degree over the full graph
    const degreeMap = new Map<string, number>();
    for (const n of allNodes) degreeMap.set(n.id, 0);
    for (const l of allLinks) {
      degreeMap.set(linkId(l.source), (degreeMap.get(linkId(l.source)) ?? 0) + 1);
      degreeMap.set(linkId(l.target), (degreeMap.get(linkId(l.target)) ?? 0) + 1);
    }

    const nodes = allNodes.map(n => ({ ...n }));
    const links = allLinks.map(l => ({ source: linkId(l.source), target: linkId(l.target) }));

    const W = svgEl.clientWidth || 800;
    const H = svgEl.clientHeight || 600;

    // ---- compartments: partition the graph around its major hubs.
    // Each big note (index, proof-assets, onboarding SOP...) anchors its own
    // colored neighborhood via BFS — so the map splits into topic territories. ----
    const adj = new Map<string, string[]>();
    for (const n of nodes) adj.set(n.id, []);
    for (const l of links) {
      adj.get(linkId(l.source))!.push(linkId(l.target));
      adj.get(linkId(l.target))!.push(linkId(l.source));
    }
    const hubTarget = Math.max(4, Math.min(10, Math.round(nodes.length / 14)));
    const hubList = [...nodes]
      .filter(n => (degreeMap.get(n.id) ?? 0) >= 3)
      .sort((a, b) => (degreeMap.get(b.id) ?? 0) - (degreeMap.get(a.id) ?? 0))
      .slice(0, hubTarget);
    const clusterOf = new Map<string, number>();
    let clusterCount = 0;
    const bfsQueue: string[] = [];
    for (const h of hubList) {
      if (!clusterOf.has(h.id)) {
        clusterOf.set(h.id, clusterCount++);
        bfsQueue.push(h.id);
      }
    }
    while (bfsQueue.length) {
      const cur = bfsQueue.shift()!;
      const c = clusterOf.get(cur)!;
      for (const nb of adj.get(cur) ?? []) {
        if (!clusterOf.has(nb)) { clusterOf.set(nb, c); bfsQueue.push(nb); }
      }
    }
    // small disconnected islands get their own compartments too
    for (const n of nodes) {
      if (clusterOf.has(n.id) || (adj.get(n.id) ?? []).length === 0) continue;
      const q = [n.id];
      clusterOf.set(n.id, clusterCount);
      while (q.length) {
        const cur = q.shift()!;
        for (const nb of adj.get(cur) ?? []) {
          if (!clusterOf.has(nb)) { clusterOf.set(nb, clusterCount); q.push(nb); }
        }
      }
      clusterCount++;
    }
    // the single most connected note is THE star of the map — teal centerpiece.
    // compartment hubs are bright amber suns; everything else is firefly dust.
    const godId = hubList[0]?.id ?? "";
    const isGod = (id: string) => id === godId;
    const hubSet = new Set(hubList.map(h => h.id));
    const isHub = (id: string) => hubSet.has(id) && !isGod(id);

    const colorOf = (id: string) => {
      if (isGod(id)) return GOD_COLOR;
      return clusterOf.has(id) ? CLUSTER_COLORS[clusterOf.get(id)! % CLUSTER_COLORS.length] : DUST_COLOR;
    };

    setStats({ nodes: nodes.length, links: links.length, clusters: clusterCount });

    // ---- defs: everything glows like fireflies — small bloom for dust,
    // big bloom for the suns ----
    const defs = svg.append("defs");
    const mkBloom = (id: string, dev: number) => {
      const f = defs.append("filter").attr("id", id)
        .attr("x", "-250%").attr("y", "-250%").attr("width", "600%").attr("height", "600%");
      f.append("feGaussianBlur").attr("stdDeviation", dev).attr("result", "blur");
      const m = f.append("feMerge");
      m.append("feMergeNode").attr("in", "blur");
      m.append("feMergeNode").attr("in", "SourceGraphic");
    };
    mkBloom("bloomSm", 2.6);
    mkBloom("bloomMd", 6);
    mkBloom("bloom", 11);

    // ---- parallax starfield ----
    const rand = d3.randomLcg(42);
    const starFar = svg.append("g").attr("pointer-events", "none");
    const starNear = svg.append("g").attr("pointer-events", "none");
    for (let i = 0; i < 150; i++) {
      const far = i % 3 !== 0;
      (far ? starFar : starNear).append("circle")
        .attr("cx", rand() * W * 2 - W / 2).attr("cy", rand() * H * 2 - H / 2)
        .attr("r", far ? rand() * 0.8 + 0.2 : rand() * 1.3 + 0.4)
        .attr("fill", "#ffffff")
        .attr("opacity", far ? rand() * 0.13 + 0.02 : rand() * 0.22 + 0.05);
    }

    const g = svg.append("g");

    // sizes like the reference: nearly everything is a small dot
    const radius = (id: string) => {
      if (isGod(id)) return 17;
      if (isHub(id)) return 10;
      const deg = degreeMap.get(id) ?? 0;
      return Math.min(7.5, 2.4 + Math.sqrt(deg) * 1.35);
    };

    // ---- layout: each compartment drifts to its own region of space —
    // index to one side, proof assets to another, SOPs below — with wide
    // open void between territories. Pull is gentle so regions stay airy. ----
    const spread = Math.max(W, H) * 1.9;
    const territory = new Map<number, { x: number; y: number }>();
    const GOLDEN = Math.PI * (3 - Math.sqrt(5));
    for (let c = 0; c < clusterCount; c++) {
      const r = spread * 0.22 + spread * 0.5 * Math.sqrt(c / Math.max(1, clusterCount - 1));
      const a = c * GOLDEN;
      territory.set(c, { x: W / 2 + Math.cos(a) * r, y: H / 2 + Math.sin(a) * r * 0.72 });
    }
    const territoryOf = (id: string) =>
      clusterOf.has(id) ? territory.get(clusterOf.get(id)!)! : { x: W / 2, y: H / 2 };

    const simulation = d3.forceSimulation<Node>(nodes)
      .alphaDecay(0.015)
      .velocityDecay(0.38)
      .force("link", d3.forceLink<Node, Link>(links).id(d => d.id).distance(95).strength(0.1))
      .force("charge", d3.forceManyBody().strength(-260).distanceMin(8).distanceMax(900))
      .force("territoryX", d3.forceX<Node>(d => territoryOf(d.id).x).strength(0.05))
      .force("territoryY", d3.forceY<Node>(d => territoryOf(d.id).y).strength(0.05))
      .force("collision", d3.forceCollide<Node>(d => radius(d.id) + 14));
    simRef.current = simulation;
    nodePosRef.current = new Map(nodes.map(n => [n.id, n]));

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.08, 8])
      .on("zoom", (e) => {
        g.attr("transform", e.transform);
        const t = e.transform;
        starFar.attr("transform", `translate(${t.x * 0.05},${t.y * 0.05})`);
        starNear.attr("transform", `translate(${t.x * 0.14},${t.y * 0.14})`);
        const scale = t.k;
        g.selectAll<SVGTextElement, Node>("text.node-label")
          .attr("opacity", d => {
            if (isGod(d.id) || isHub(d.id)) return 0.85;
            return Math.max(0, Math.min(0.85, (scale - 1.1) / 0.9));
          })
          .attr("font-size", `${Math.max(9, 10 / scale)}px`);
      });
    zoomRef.current = zoom;
    svg.call(zoom);

    // slow drift in from the void — the screen then stays put; the orbs move.
    svg.call(zoom.transform as any, d3.zoomIdentity.translate(W * 0.42, H * 0.42).scale(0.18));
    svg.transition().duration(2600).ease(d3.easeCubicOut)
      .call(zoom.transform as any, d3.zoomIdentity.translate(W * 0.31, H * 0.31).scale(0.38));

    // ---- per-orb orbital motion: each note slowly circles its own home spot.
    // Small notes drift in wide lazy circles, big suns barely stir. ----
    type Orb = Node & { hx?: number; hy?: number; oR?: number; oSpd?: number; oPh?: number; oEcc?: number };
    const orbSpeed = (id: string) => (isGod(id) ? 0.05 : isHub(id) ? 0.08 : 0.16);
    const orbRadius = (id: string) => {
      if (isGod(id)) return 6;
      if (isHub(id)) return 10;
      const deg = degreeMap.get(id) ?? 0;
      return 26 - Math.min(16, deg * 1.6);     // lightly-linked dust wanders widest
    };
    (nodes as Orb[]).forEach((n, i) => {
      n.oR = orbRadius(n.id);
      n.oSpd = orbSpeed(n.id) * (0.7 + ((i * 37) % 60) / 100);   // vary so they don't sync
      n.oPh = ((i * 97) % 628) / 100;                            // random phase 0..2π
      n.oEcc = 0.65 + ((i * 53) % 40) / 100;                     // squash circles into ellipses
    });

    // fit + center the whole galaxy in the viewport, once, when it settles
    let didFit = false;
    function fitView() {
      if (didFit) return;
      didFit = true;
      const xs = nodes.map(n => n.x!).filter(v => v != null);
      const ys = nodes.map(n => n.y!).filter(v => v != null);
      if (!xs.length) return;
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
      const k = Math.min(2, 0.86 * Math.min(W / bw, H / bh));
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      svg.transition().duration(1400).ease(d3.easeCubicInOut).call(
        zoom.transform as any,
        d3.zoomIdentity.translate(W / 2 - k * cx, H / 2 - k * cy).scale(k)
      );
    }

    // one persistent orbital clock — never resets, so motion NEVER jumps.
    // After any physics run (initial settle, drags), orbits ease back in from
    // zero amplitude over 3s instead of snapping.
    function startOrbit() {
      cancelAnimationFrame(driftRef.current.raf);
      const orbs = nodes as Orb[];
      for (const n of orbs) { n.hx = n.x; n.hy = n.y; }          // re-anchor homes
      if (!driftRef.current.t0) driftRef.current.t0 = performance.now();
      const rampStart = performance.now();
      const loop = (now: number) => {
        driftRef.current.raf = requestAnimationFrame(loop);
        const s = (now - driftRef.current.t0!) / 1000;
        const ramp = Math.min(1, (now - rampStart) / 3000);
        const ease = ramp * ramp * (3 - 2 * ramp);               // smoothstep ease-in
        for (const n of orbs) {
          if (n.fx != null) { n.hx = n.x; n.hy = n.y; continue; } // being dragged: track it
          const a = s * n.oSpd! + n.oPh!;
          n.x = n.hx! + Math.cos(a) * n.oR! * ease;
          n.y = n.hy! + Math.sin(a) * n.oR! * n.oEcc! * ease;
        }
        node.attr("transform", d => `translate(${d.x},${d.y})`);
        link.attr("d", linkCurve as any);
      };
      driftRef.current.raf = requestAnimationFrame(loop);
    }

    // ---- links: thin curved threads of light — amber, teal when they
    // flow out of the star ----
    const touchesGod = (l: any) => linkId(l.source) === godId || linkId(l.target) === godId;
    const linkCurve = (l: any) => {
      const s = l.source as Node, t = l.target as Node;
      if (s.x == null || t.x == null) return "";
      const dx = t.x! - s.x!, dy = t.y! - s.y!;
      const mx = (s.x! + t.x!) / 2 - dy * 0.16;
      const my = (s.y! + t.y!) / 2 + dx * 0.16;
      return `M${s.x},${s.y} Q${mx},${my} ${t.x},${t.y}`;
    };
    const link = g.append("g")
      .selectAll("path")
      .data(links)
      .join("path")
      .attr("fill", "none")
      .attr("stroke", (l: any) => touchesGod(l) ? GOD_COLOR : "#d9a13c")
      .attr("stroke-width", (l: any) => touchesGod(l) ? 1.1 : 0.6)
      .attr("stroke-opacity", (l: any) => touchesGod(l) ? 0.35 : 0.14);

    // ---- nodes ----
    const node = g.append("g")
      .selectAll("g")
      .data(nodes)
      .join("g")
      .attr("cursor", "pointer")
      .call((d3.drag<SVGGElement, Node>()
        .on("start", (e, d) => { cancelAnimationFrame(driftRef.current.raf); if (!e.active) simulation.alphaTarget(0.2).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
        .on("end", (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })) as any)
      .on("click", (e, d) => { e.stopPropagation(); onSelectNode(d.path); });

    // THE star: big teal orb, layered bloom, white-hot heart
    const gods = node.filter(d => isGod(d.id));
    gods.append("circle").attr("r", 38).attr("fill", GOD_COLOR).attr("opacity", 0.1).attr("filter", "url(#bloom)");
    gods.append("circle").attr("r", 24).attr("fill", GOD_COLOR).attr("opacity", 0.28).attr("filter", "url(#bloom)");
    gods.append("circle").attr("r", 17).attr("fill", GOD_COLOR).attr("opacity", 0.95).attr("filter", "url(#bloomMd)");
    gods.append("circle").attr("r", 9).attr("fill", "#eafff4").attr("opacity", 0.95);

    // compartment suns: bright amber, strong glow
    const suns = node.filter(d => isHub(d.id));
    suns.append("circle")
      .attr("r", 18)
      .attr("fill", d => colorOf(d.id))
      .attr("opacity", 0.16)
      .attr("filter", "url(#bloom)");
    suns.append("circle")
      .attr("r", 10)
      .attr("fill", d => colorOf(d.id))
      .attr("opacity", 0.95)
      .attr("filter", "url(#bloomMd)");
    suns.append("circle")
      .attr("r", 4)
      .attr("fill", "#fff3d6")
      .attr("opacity", 0.85);

    // fireflies: every small note still glows softly
    const plain = node.filter(d => !isGod(d.id) && !isHub(d.id));
    plain.append("circle")
      .attr("class", "node-core")
      .attr("r", d => radius(d.id))
      .attr("fill", d => (degreeMap.get(d.id) ?? 0) === 0 ? DUST_COLOR : colorOf(d.id))
      .attr("opacity", d => (degreeMap.get(d.id) ?? 0) === 0 ? 0.4 : 0.9)
      .attr("filter", "url(#bloomSm)");

    // labels: god nodes always (small, dim); others only when zoomed in
    node.append("text")
      .attr("class", "node-label")
      .text(d => d.name)
      .attr("y", d => radius(d.id) + 14)
      .attr("text-anchor", "middle")
      .attr("font-size", "10px")
      .attr("fill", "#b9a06a")
      .attr("pointer-events", "none")
      .attr("opacity", d => isGod(d.id) || isHub(d.id) ? 0.85 : 0);

    // ---- hover: light the neighborhood, dim the rest ----
    const hood = new Map<string, Set<string>>();
    for (const n of nodes) hood.set(n.id, new Set([n.id]));
    for (const l of links) {
      hood.get(linkId(l.source))!.add(linkId(l.target));
      hood.get(linkId(l.target))!.add(linkId(l.source));
    }
    node
      .on("mouseover", function (_e, d) {
        const h = hood.get(d.id)!;
        node.transition().duration(140).attr("opacity", (n: any) => h.has(n.id) ? 1 : 0.15);
        node.selectAll<SVGTextElement, Node>("text.node-label").transition().duration(140)
          .attr("opacity", (n: any) => h.has(n.id) ? 0.95 : 0);
        link.transition().duration(140)
          .attr("stroke-opacity", (l: any) =>
            (linkId(l.source) === d.id || linkId(l.target) === d.id) ? 0.8 : 0.04)
          .attr("stroke-width", (l: any) =>
            (linkId(l.source) === d.id || linkId(l.target) === d.id) ? 1.5 : 0.6);
      })
      .on("mouseout", function () {
        node.transition().duration(200).attr("opacity", 1);
        node.selectAll<SVGTextElement, Node>("text.node-label").transition().duration(200)
          .attr("opacity", (d: any) => isGod(d.id) || isHub(d.id) ? 0.85 : 0);
        link.transition().duration(200)
          .attr("stroke-opacity", (l: any) => touchesGod(l) ? 0.35 : 0.14)
          .attr("stroke-width", (l: any) => touchesGod(l) ? 1.1 : 0.6);
      });

    simulation.on("tick", () => {
      link.attr("d", linkCurve as any);
      node.attr("transform", d => `translate(${d.x},${d.y})`);
    });
    // when the physics settles: center the galaxy once, then hand rendering
    // to the orbital loop (which eases in, so no jump)
    simulation.on("end", () => { fitView(); startOrbit(); });
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", borderRadius: 16, overflow: "hidden", border: "1px solid rgba(255,255,255,0.07)" }}>
        {loading && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 14, zIndex: 2 }}>
            Building graph...
          </div>
        )}

        {showChip ? (
          <div style={{
            position: "absolute", top: 12, left: 12, zIndex: 3,
            background: "rgba(8,9,15,0.7)", backdropFilter: "blur(6px)",
            border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: "10px 14px",
          }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
              <p style={{ fontSize: 9.5, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Project</p>
              <button onClick={() => setShowChip(false)} aria-label="collapse project panel" title="Collapse panel"
                style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0 }}>‹</button>
            </div>
            <p style={{ fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#3ddc84", boxShadow: "0 0 8px #3ddc84" }} />
              Jack&apos;s AI Brain
            </p>
            <p style={{ fontSize: 10.5, color: "var(--text-muted)", marginTop: 3 }}>{stats.nodes} notes · {stats.clusters} clusters</p>
          </div>
        ) : (
          <button onClick={() => setShowChip(true)} aria-label="expand project panel" title="Show project panel" style={{
            position: "absolute", top: 12, left: 12, zIndex: 3, width: 26, height: 34,
            borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(8,9,15,0.7)", backdropFilter: "blur(6px)", color: "var(--text-secondary)", fontSize: 15, lineHeight: 1,
          }}>›</button>
        )}

        <svg ref={svgRef} style={{ width: "100%", height: "100%", display: "block", background: "#050609" }} />
    </div>
  );
}
