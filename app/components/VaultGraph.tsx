"use client";
import { useEffect, useRef, useState } from "react";
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

const GROUP_COLORS: Record<string, string> = {
  wiki: "#7c6af5",
  "03-Resources": "#4ade80",
  raw: "#60a5fa",
  default: "#fb923c",
};

export default function VaultGraph({ onSelectNode }: { onSelectNode: (path: string) => void }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [loading, setLoading] = useState(true);
  const [nodeCount, setNodeCount] = useState(0);
  const [linkCount, setLinkCount] = useState(0);

  useEffect(() => {
    fetch("/api/vault/graph")
      .then(r => r.json())
      .then(({ nodes, links }) => {
        setLoading(false);
        setNodeCount(nodes.length);
        setLinkCount(links.length);
        buildGraph(nodes, links);
      });
  }, []);

  function buildGraph(nodes: Node[], links: Link[]) {
    const svgEl = svgRef.current!;
    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();

    const W = svgEl.clientWidth || 800;
    const H = svgEl.clientHeight || 600;

    const g = svg.append("g");

    // Zoom behavior -- scroll wheel zooms, middle-click drag pans
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 8])
      .filter(event => {
        // Allow scroll wheel zoom, left-click drag, AND middle-click drag
        if (event.type === "wheel") return true;
        if (event.type === "mousedown" && event.button === 1) return true; // middle click
        if (event.type === "mousedown" && event.button === 0) return true; // left click drag to pan
        return false;
      })
      .on("zoom", (e) => {
        g.attr("transform", e.transform);
        // Update label visibility based on zoom level
        const scale = e.transform.k;
        g.selectAll<SVGTextElement, Node>("text.node-label")
          .attr("opacity", d => {
            const r = getRadius(d, links);
            // Hub nodes always visible; small nodes appear as you zoom in
            if (r > 10) return 1;
            if (r > 7) return Math.min(1, (scale - 0.4) / 0.6);
            return Math.min(1, (scale - 0.8) / 0.8);
          })
          .attr("font-size", d => `${Math.max(9, 10 / e.transform.k)}px`);
      });

    svg.call(zoom);

    // Prevent middle-click scroll default
    svgEl.addEventListener("mousedown", e => { if (e.button === 1) e.preventDefault(); });

    const degreeMap = new Map<string, number>();
    for (const n of nodes) degreeMap.set(n.id, 0);
    for (const l of links) {
      const s = typeof l.source === "string" ? l.source : (l.source as Node).id;
      const t = typeof l.target === "string" ? l.target : (l.target as Node).id;
      degreeMap.set(s, (degreeMap.get(s) ?? 0) + 1);
      degreeMap.set(t, (degreeMap.get(t) ?? 0) + 1);
    }

    const simulation = d3.forceSimulation<Node>(nodes)
      .force("link", d3.forceLink<Node, Link>(links).id(d => d.id).distance(90).strength(0.4))
      .force("charge", d3.forceManyBody().strength(-250))
      .force("center", d3.forceCenter(W / 2, H / 2))
      .force("collision", d3.forceCollide<Node>(d => getRadius(d, links) + 6));

    // Links
    const link = g.append("g")
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("stroke", "#2a2f5a")
      .attr("stroke-width", 1.2)
      .attr("stroke-opacity", 0.5);

    // Node groups
    const node = g.append("g")
      .selectAll("g")
      .data(nodes)
      .join("g")
      .attr("cursor", "pointer")
      .call(
        d3.drag<SVGGElement, Node>()
          .on("start", (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
          .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
          .on("end", (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })
      )
      .on("click", (e, d) => { e.stopPropagation(); onSelectNode(d.path); });

    // Glow ring
    node.append("circle")
      .attr("r", d => getRadius(d, links) + 5)
      .attr("fill", d => GROUP_COLORS[d.group] ?? GROUP_COLORS.default)
      .attr("opacity", 0.12);

    // Main circle
    node.append("circle")
      .attr("r", d => getRadius(d, links))
      .attr("fill", d => GROUP_COLORS[d.group] ?? GROUP_COLORS.default)
      .attr("stroke", "#0d0e1a")
      .attr("stroke-width", 1.5)
      .on("mouseover", function () { d3.select(this).attr("opacity", 0.7); })
      .on("mouseout", function () { d3.select(this).attr("opacity", 1); });

    // Labels -- ALL nodes get one, visibility controlled by zoom
    node.append("text")
      .attr("class", "node-label")
      .text(d => d.name)
      .attr("x", 0)
      .attr("y", d => getRadius(d, links) + 13)
      .attr("text-anchor", "middle")
      .attr("font-size", "10px")
      .attr("fill", "#8b90c4")
      .attr("pointer-events", "none")
      // Big nodes always visible, small ones start hidden until zoomed in
      .attr("opacity", d => getRadius(d, links) > 10 ? 1 : 0);

    simulation.on("tick", () => {
      link
        .attr("x1", d => (d.source as Node).x!)
        .attr("y1", d => (d.source as Node).y!)
        .attr("x2", d => (d.target as Node).x!)
        .attr("y2", d => (d.target as Node).y!);
      node.attr("transform", d => `translate(${d.x},${d.y})`);
    });
  }

  function getRadius(node: Node, links: Link[]): number {
    const degree = links.filter(l =>
      (l.source as Node).id === node.id || (l.target as Node).id === node.id
    ).length;
    return Math.max(5, Math.min(20, 5 + degree * 2.5));
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {loading && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 14 }}>
          Building graph...
        </div>
      )}
      {!loading && (
        <div style={{ position: "absolute", top: 12, right: 12, fontSize: 11, color: "var(--text-muted)", background: "var(--bg-card)", padding: "6px 12px", borderRadius: 6, border: "1px solid var(--border)" }}>
          {nodeCount} notes · {linkCount} connections
        </div>
      )}
      <div style={{ position: "absolute", bottom: 12, left: 12, fontSize: 11, color: "var(--text-muted)" }}>
        Scroll to zoom · Middle-click drag to pan · Click node to open
      </div>
      <svg ref={svgRef} style={{ width: "100%", height: "100%", background: "var(--bg-primary)" }} />
    </div>
  );
}
