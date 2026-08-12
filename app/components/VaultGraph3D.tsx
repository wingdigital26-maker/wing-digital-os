"use client";
// VAULT GRAPH — 3D WebGL galaxy (OPT-IN enhancement).
// This is the "show" render: react-force-graph-3d (three.js) with an optional
// UnrealBloom + Bokeh glow, a slow auto-orbit camera and flowing link particles.
// It is only ever mounted when Jack turns 3D on AND the browser reports a usable
// WebGL context. If anything in here throws at runtime, the parent's error
// boundary flips back to the reliable 2D canvas so the graph is never a blank
// void. All highlight/dim state lives in refs owned by the parent so the 2D and
// 3D renders stay in lockstep.
import { useEffect, useRef, useCallback, type MutableRefObject } from "react";
import ForceGraph3D from "react-force-graph-3d";
import * as THREE from "three";
import { UnrealBloomPass, BokehPass } from "three-stdlib";
import { sfx } from "../lib/sounds";
import type { GNode, GLink } from "./graphTypes";

function lid(x: string | GNode): string {
  return typeof x === "string" ? x : x.id;
}

// Cheap canvas-texture label sprite (used only for the handful of hub nodes),
// with a dark halo so the text stays legible over nodes and links.
const labelSpriteCache = new Map<string, THREE.Sprite>();
function makeLabelSprite(text: string): THREE.Sprite | null {
  if (typeof document === "undefined") return null;
  const cached = labelSpriteCache.get(text);
  if (cached) return cached.clone();
  const pad = 12, fontPx = 58;
  const c = document.createElement("canvas");
  const g = c.getContext("2d");
  if (!g) return null;
  g.font = `600 ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
  const w = Math.ceil(g.measureText(text).width) + pad * 2;
  const h = fontPx + pad * 2;
  c.width = w; c.height = h;
  g.font = `600 ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
  g.textAlign = "center"; g.textBaseline = "middle";
  g.lineJoin = "round"; g.lineWidth = 9; g.strokeStyle = "rgba(3,4,8,0.95)";
  g.strokeText(text, w / 2, h / 2);
  g.fillStyle = "#ffffff";
  g.fillText(text, w / 2, h / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  const scale = 0.66;
  spr.scale.set((w / h) * fontPx * scale * 0.1 + 4, fontPx * scale * 0.1 + 2, 1);
  labelSpriteCache.set(text, spr);
  return spr.clone();
}

export default function VaultGraph3D(props: {
  graph: { nodes: GNode[]; links: GLink[] };
  size: { w: number; h: number };
  mobile: boolean;
  flow: boolean;
  glow: boolean;
  restored: boolean;
  highlightNodes: MutableRefObject<Set<string>>;
  highlightLinks: MutableRefObject<Set<GLink>>;
  tick: number;
  recenterN: number;
  onNodeHover: (n: GNode | null) => void;
  onNodeClick: (n: GNode) => void;
  onBackgroundClick: () => void;
}) {
  const {
    graph, size, mobile, flow, glow, restored,
    highlightNodes, highlightLinks, tick, recenterN,
    onNodeHover, onNodeClick, onBackgroundClick,
  } = props;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  const focusId = useRef<string | null>(null);
  // Once Jack drags/zooms the camera we stop the auto-orbit and never auto-fit
  // again (the "zips back" bug), until an explicit Recenter.
  const hasUserInteracted = useRef(false);

  // ── Force tuning: wide spacing + warm settling ──
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !graph.nodes.length) return;
    // Spread out like a galaxy: stronger repulsion, longer links, weaker center pull.
    fg.d3Force("charge")?.strength(mobile ? -260 : -430).distanceMax(2200);
    fg.d3Force("link")?.distance(mobile ? 100 : 155).strength(0.07);
    if (fg.d3Force("center")) fg.d3Force("center").strength(0.015);
    fg.d3ReheatSimulation?.();
  }, [graph, mobile]);

  // ── Node object: bright sphere (or octahedron for hubs) so bloom glows ──
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
    const mesh = new THREE.Mesh(geom, mat);
    // Hubs are always labeled (there are only a handful) via a cheap canvas-
    // texture sprite with a dark halo, so the name reads over nodes and links.
    if (node.isHub) {
      const label = makeLabelSprite(node.name);
      if (label) { label.position.set(0, val * 1.9, 0); mesh.add(label); }
    }
    return mesh;
  }, []);

  // Keep material opacity in sync with highlight (visible floor, no blackout).
  const applyDim = useCallback(() => {
    const anyHi = highlightNodes.current.size > 0;
    for (const [id, mat] of nodeMats.current) {
      const on = !anyHi || highlightNodes.current.has(id);
      mat.opacity = on ? 1 : 0.22;
    }
  }, [highlightNodes]);
  useEffect(() => { applyDim(); }, [applyDim, tick]);

  // ── Post-processing: bloom + bokeh DoF, BEST-EFFORT and OPT-IN ──
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !glow || !graph.nodes.length) return;
    let cancelled = false;
    const added: unknown[] = [];
    const id = window.setTimeout(() => {
      if (cancelled) return;
      try {
        const composer = fg.postProcessingComposer?.();
        if (!composer) return;
        const already = composer.passes?.some(
          (p: unknown) => p instanceof UnrealBloomPass || p instanceof BokehPass
        );
        if (already) return;
        if (!mobile) {
          const scene = fg.scene?.();
          const camera = fg.camera?.();
          if (scene && camera) {
            const bokeh = new BokehPass(scene, camera, { focus: 600, aperture: 0.0006, maxblur: 0.01 });
            composer.addPass(bokeh);
            added.push(bokeh);
          }
        }
        // Subtle PER-NODE glow, never a full-screen blue wash.
        //  · strength LOW (~0.6-0.8) so it doesn't flood the scene
        //  · threshold HIGH (0.6) so only bright node cores bloom; the dark
        //    background (#04050a) and dim links stay below the cutoff
        //  · small radius so glow hugs each node instead of smearing across
        const bloom = new UnrealBloomPass(
          new THREE.Vector2(size.w || window.innerWidth, size.h || window.innerHeight),
          mobile ? 0.3 : 0.4, // strength: gentle halo, not a full-screen wash
          0.2,                // radius: hug each node tightly
          0.82                // threshold: only the brightest node cores bloom, background/links stay dark
        );
        composer.addPass(bloom);
        added.push(bloom);
      } catch { /* postprocessing unavailable — graph still renders, just no glow */ }
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
      try {
        const composer = fg.postProcessingComposer?.();
        if (composer?.removePass) for (const p of added) composer.removePass(p);
      } catch { /* noop */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glow, graph.nodes.length, mobile]);

  // ── Frame the whole galaxy in view once it exists ──
  const didFit = useRef(false);
  const fitToView = useCallback((force = false) => {
    const fg = fgRef.current;
    if (!fg || !graph.nodes.length) return;
    if (!force && hasUserInteracted.current) return; // never fight manual nav
    try { fg.zoomToFit(600, mobile ? 18 : 40); } catch { /* pre-layout */ } // tighter padding = opens a touch more zoomed in
  }, [graph.nodes.length, mobile]);
  useEffect(() => {
    if (!graph.nodes.length) return;
    didFit.current = false;
    const t1 = window.setTimeout(() => fitToView(), 400);
    const t2 = window.setTimeout(() => fitToView(), 1500);
    return () => { window.clearTimeout(t1); window.clearTimeout(t2); };
  }, [graph.nodes.length, fitToView]);

  // Explicit Recenter from the parent toolbar: clear the "hands off" flag and
  // re-frame + resume the auto-orbit.
  useEffect(() => {
    if (!recenterN) return;
    hasUserInteracted.current = false;
    didFit.current = true; // treat as framed so orbit may resume immediately
    fitToView(true);
  }, [recenterN, fitToView]);

  // ── Slow auto-orbit camera (~0.4 rpm) so the galaxy always breathes ──
  // CRITICAL: orbit around the controls' look-at TARGET (the graph centroid),
  // not the world origin. The 2D center force is weak so the settled layout can
  // sit far from (0,0,0); orbiting the origin while zoomToFit framed the offset
  // nodes used to shove every node out of view every frame — the "toggle 3D and
  // see nothing" bug. We also wait until the first fit has run before orbiting,
  // so the camera never fights the initial framing.
  const interacting = useRef(false);
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !graph.nodes.length) return;
    let angle = 0;
    let started = false;
    let raf = 0;
    let last = performance.now();
    let lastInteract = 0; // when the user last touched the camera
    const controls = fg.controls?.();
    // The galaxy slowly spins on its own. Manual drag/zoom pauses it; it resumes
    // a few seconds after the user stops, so the view keeps gently rotating.
    const RESUME_MS = 3500;
    const onStart = () => { interacting.current = true; hasUserInteracted.current = true; };
    const onEnd = () => { interacting.current = false; lastInteract = performance.now(); started = false; };
    controls?.addEventListener?.("start", onStart);
    controls?.addEventListener?.("end", onEnd);
    const RPM = 0.32; // slow, gentle spin
    const step = (now: number) => {
      raf = requestAnimationFrame(step);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      // Hold still until the graph has been framed once, while the user is
      // actively interacting or a node is focused, and for a short beat after
      // they let go. Otherwise keep the gentle spin going.
      if (!didFit.current || interacting.current || focusId.current || (now - lastInteract < RESUME_MS)) { last = now; return; }
      const cam = fg.camera?.();
      if (!cam) return;
      // Orbit center = current look-at target (graph centroid), fall back to 0.
      const tgt = controls?.target ?? { x: 0, y: 0, z: 0 };
      const dx = cam.position.x - tgt.x;
      const dz = cam.position.z - tgt.z;
      const r = Math.hypot(dx, dz) || 900;
      if (!started) { angle = Math.atan2(dx, dz); started = true; }
      angle += dt * (RPM * Math.PI * 2 / 60);
      fg.cameraPosition({ x: tgt.x + r * Math.sin(angle), z: tgt.z + r * Math.cos(angle) });
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      controls?.removeEventListener?.("start", onStart);
      controls?.removeEventListener?.("end", onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.nodes.length]);

  const anyHi = highlightNodes.current.size > 0;

  // Wrap click so the camera eases to frame the node, then defer to the parent
  // (highlight + open note + sound) through the shared contract.
  const handleClick = useCallback((node: GNode) => {
    const fg = fgRef.current;
    focusId.current = node.id;
    if (fg) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const n = node as any;
      const dist = 120;
      const hyp = Math.hypot(n.x || 0, n.y || 0, n.z || 0) || 1;
      const ratio = 1 + dist / hyp;
      fg.cameraPosition(
        { x: (n.x || 0) * ratio, y: (n.y || 0) * ratio, z: (n.z || 0) * ratio },
        n, 900
      );
    }
    onNodeClick(node);
  }, [onNodeClick]);

  const handleBg = useCallback(() => { focusId.current = null; onBackgroundClick(); }, [onBackgroundClick]);

  return (
    <ForceGraph3D
      ref={fgRef}
      width={size.w}
      height={size.h}
      graphData={graph as unknown as { nodes: GNode[]; links: GLink[] }}
      backgroundColor="#04050a"
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
        const src = typeof l.source === "object" ? (l.source as GNode) : graph.nodes.find(n => n.id === lid(l.source));
        return src?.color ?? "#7fa8d9";
      }}
      warmupTicks={mobile ? 20 : 40}
      cooldownTicks={mobile ? 90 : 200}
      onNodeHover={onNodeHover}
      onNodeClick={handleClick}
      onBackgroundClick={handleBg}
      onEngineStop={() => {
        if (!didFit.current) { didFit.current = true; fitToView(); }
        if (!restored) sfx.playWhenReady("graph-arrive");
      }}
    />
  );
}
