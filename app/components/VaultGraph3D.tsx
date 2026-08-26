"use client";
// VAULT GRAPH — 3D WebGL galaxy. THE renderer.
// This is react-force-graph-3d (three.js) with an optional UnrealBloom + Bokeh
// glow, a slow auto-orbit camera and flowing link particles. It used to be an
// opt-in enhancement sitting behind a 2D canvas fallback; that fallback is gone
// and this is now the only view, mounted whenever the browser reports a usable
// WebGL context. If it throws, the parent's error boundary shows an explanatory
// message (there is nothing left to fall back to). All highlight/dim state
// lives in refs owned by the parent.
//
// The scene stays DARK on purpose even though the app is a light theme — the
// bloom, the glowing node cores and the luminous particles are all additive
// light, which only exists against darkness. See the long note at the top of
// VaultGraph.tsx: the panel is framed as an intentional observatory inset.
import { useEffect, useMemo, useRef, useCallback, type MutableRefObject } from "react";
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
  onFramed?: () => void;
}) {
  const {
    graph, size, mobile, flow, glow, restored,
    highlightNodes, highlightLinks, tick, recenterN,
    onNodeHover, onNodeClick, onBackgroundClick, onFramed,
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
    // Galaxy, but a LEGIBLE one. The old tuning (charge -430 out to 2200 units,
    // 155-unit links, almost no centering) blew the layout into a small bright
    // core surrounded by a huge, near-invisible halo — measured, half the nodes
    // sat inside ~530 units while the outermost reached 2400. Any honest
    // fit-to-frame then had to pull the camera so far back that the part worth
    // reading became a speck. Shorter links, softer and shorter-range repulsion
    // and a real centering force pack the same structure into a dense mass that
    // fills the panel.
    fg.d3Force("charge")?.strength(mobile ? -140 : -190).distanceMax(700);
    fg.d3Force("link")?.distance(mobile ? 62 : 88).strength(0.09);
    if (fg.d3Force("center")) fg.d3Force("center").strength(0.06);
    fg.d3ReheatSimulation?.();
  }, [graph, mobile]);

  // ── Node object: bright sphere (or octahedron for hubs) so bloom glows ──
  const geomCache = useRef(new Map<string, THREE.BufferGeometry>());
  const nodeMats = useRef<Map<string, THREE.MeshBasicMaterial>>(new Map());
  const nodeMeshes = useRef<Map<string, THREE.Mesh>>(new Map());
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
    // Keep a handle on every node mesh. The library positions THESE objects
    // each tick; the plain node records we hand it are not reliably written
    // back, so the meshes are the only trustworthy source of live coordinates
    // (frameCore needs them to compute the opening shot).
    nodeMeshes.current.set(node.id, mesh);
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
          mobile ? 0.24 : 0.32, // strength: gentle halo, not a full-screen wash
          0.18,                 // radius: hug each node tightly
          0.90                  // threshold: raised from 0.82 — at 0.82 enough of the mid-tones bloomed to lift the whole ground to a washed-out navy-grey, killing the contrast the dark scene exists for. Only true node cores glow now.
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
  // Jack wants the map to OPEN 25% more zoomed in: the camera is placed at
  // 1/1.25 = 80% of the distance that would exactly frame the graph, which is
  // by definition a 25% closer view. It is expressed as a ratio of the computed
  // fit distance, not a fixed number, so it holds at any viewport size and as
  // the vault grows.
  // NOTE: this is divided into a fit distance that has ALREADY been padded for
  // breathing room, so the two partially cancel. At ZOOM_IN 1.25 against 1.14
  // padding the net was 1.14/1.25 = 0.91 — a 9% closer view, not the 25% asked
  // for. Sized so the NET lands at ~0.78 of the raw fit.
  const ZOOM_IN = 1.46;
  // Debug handle, mirroring window.__vaultGraphDebug in the parent: lets the
  // camera/framing actually be measured from the console instead of eyeballed.
  useEffect(() => {
    const w = window as unknown as { __vg3d?: unknown; __vg3dMeshes?: unknown };
    w.__vg3d = () => fgRef.current;
    w.__vg3dMeshes = () => nodeMeshes.current;
  }, []);

  // True while a programmatic camera move is animating. The auto-orbit below
  // calls cameraPosition() every frame, which CANCELS any in-flight transition
  // — that silently ate every re-frame that happened after the engine settled
  // (the camera kept whatever pre-fit position it had, and the dolly below never
  // survived a single frame). The orbit yields while this is set.
  const framing = useRef(false);
  const holdFraming = useCallback((ms: number) => {
    framing.current = true;
    window.setTimeout(() => { framing.current = false; }, ms + 150);
  }, []);

  // ── The opening shot ──
  // Done by hand rather than with zoomToFit(), for two reasons: zoomToFit has to
  // encompass every last node — and a force layout always flings a few weakly
  // linked notes far out, which drags the camera back until the part worth
  // reading is a speck — and it offers no way to express "…and then 25% closer",
  // which is what Jack asked for. Its nodeFilter argument, which would have
  // solved the first problem, does not actually restrict the fit in this version.
  //
  // Instead: drop the outermost 10% of nodes, then for each remaining one work
  // out how far back the camera would have to sit for it to land just inside the
  // viewport — measured along the camera's own right/up/forward basis, so it is
  // correct for the current fov AND aspect and stays correct as the view orbits.
  // The largest of those is the true fit distance; the camera goes to 1/1.25 =
  // 80% of it, which is by definition a 25% closer view. The trimmed strays stay
  // one scroll out.
  const frameCore = useCallback((ms: number) => {
    const fg = fgRef.current;
    if (!fg) return;
    try {
      const cam = fg.camera?.();
      if (!cam) return;
      const pts = [...nodeMeshes.current.values()]
        .map(m => m.position)
        .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
      if (pts.length < 8) return;
      let cx = 0, cy = 0, cz = 0;
      for (const p of pts) { cx += p.x; cy += p.y; cz += p.z; }
      cx /= pts.length; cy /= pts.length; cz /= pts.length;
      const radii = pts.map(p => Math.hypot(p.x - cx, p.y - cy, p.z - cz)).sort((a, b) => a - b);
      const rCut = radii[Math.floor(radii.length * 0.90)] || Infinity;

      // Keep the current view direction so Recenter re-frames without snapping
      // the camera to an arbitrary axis mid-orbit.
      let dx = cam.position.x - cx, dy = cam.position.y - cy, dz = cam.position.z - cz;
      let len = Math.hypot(dx, dy, dz);
      if (!len || !Number.isFinite(len)) { dx = 0; dy = 0; dz = 1; len = 1; }
      const fx = dx / len, fy = dy / len, fz = dz / len;
      cam.updateMatrixWorld?.();
      const e = cam.matrixWorld?.elements;
      const rx = e ? e[0] : 1, ry = e ? e[1] : 0, rz = e ? e[2] : 0; // right
      const ux = e ? e[4] : 0, uy = e ? e[5] : 1, uz = e ? e[6] : 0; // up
      const tanV = Math.tan((((cam.fov ?? 50) * Math.PI) / 180) / 2);
      const tanH = tanV * (cam.aspect || size.w / Math.max(1, size.h));

      let need = 0;
      for (const p of pts) {
        const vx = p.x - cx, vy = p.y - cy, vz = p.z - cz;
        if (Math.hypot(vx, vy, vz) > rCut) continue;
        const depth = vx * fx + vy * fy + vz * fz;
        const sx = Math.abs(vx * rx + vy * ry + vz * rz);
        const sy = Math.abs(vx * ux + vy * uy + vz * uz);
        need = Math.max(need, depth + Math.max(sy / tanV, sx / tanH));
      }
      // Breathing room. Measured at 1.02 the 95th-percentile node sat a little
      // past the bottom edge; 1.14 pulls the whole retained set inside the panel
      // with a margin, without giving the framing back to the strays.
      // net = padding / ZOOM_IN. Desktop: 1.14/1.46 = 0.78 (22% closer than an
      // exact fit, and closer still than the padded fit a viewer would call
      // "fitted"). Mobile keeps more margin because the panel is narrower.
      const dist = Math.max(80, (need * (mobile ? 1.28 : 1.14)) / ZOOM_IN);
      const k = dist / len;
      holdFraming(ms);
      fg.cameraPosition(
        { x: cx + dx * k, y: cy + dy * k, z: cz + dz * k },
        { x: cx, y: cy, z: cz },
        ms
      );
    } catch { framing.current = false; /* camera not ready */ }
  }, [mobile, size.w, size.h, holdFraming]);

  const fitToView = useCallback((force = false) => {
    const fg = fgRef.current;
    if (!fg || !graph.nodes.length) return;
    if (!force && hasUserInteracted.current) return; // never fight manual nav
    frameCore(600);
    onFramed?.();
  }, [graph.nodes.length, onFramed, frameCore]);
  useEffect(() => {
    if (!graph.nodes.length) return;
    didFit.current = false;
    // Three passes: an early one so something is framed immediately, then two
    // more as the force layout keeps expanding (an early fit alone leaves the
    // camera framing a much smaller, still-collapsing cloud).
    const t1 = window.setTimeout(() => fitToView(), 400);
    const t2 = window.setTimeout(() => fitToView(), 1500);
    const t3 = window.setTimeout(() => fitToView(), 3200);
    return () => { window.clearTimeout(t1); window.clearTimeout(t2); window.clearTimeout(t3); };
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
    // NOTE: this only pauses the orbit. It deliberately does NOT set
    // hasUserInteracted — OrbitControls emits start/end for programmatic camera
    // writes too (including this very orbit and our own re-framing), so using it
    // as the "Jack took the wheel" signal made the map think it had been touched
    // seconds after load and then refused to ever frame itself again. Real input
    // is detected from actual DOM events below.
    const onStart = () => { interacting.current = true; };
    const onEnd = () => { interacting.current = false; lastInteract = performance.now(); started = false; };
    controls?.addEventListener?.("start", onStart);
    controls?.addEventListener?.("end", onEnd);
    // Real user input — the only thing that earns "hands off, stop re-framing".
    const dom: HTMLElement | undefined = fg.renderer?.()?.domElement;
    const onRealInput = () => { hasUserInteracted.current = true; lastInteract = performance.now(); };
    dom?.addEventListener("pointerdown", onRealInput, { passive: true });
    dom?.addEventListener("wheel", onRealInput, { passive: true });
    dom?.addEventListener("touchstart", onRealInput, { passive: true });
    const RPM = 0.32; // slow, gentle spin
    const step = (now: number) => {
      raf = requestAnimationFrame(step);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      // Hold still until the graph has been framed once, while the user is
      // actively interacting or a node is focused, and for a short beat after
      // they let go. Otherwise keep the gentle spin going.
      if (!didFit.current || framing.current || interacting.current || focusId.current || (now - lastInteract < RESUME_MS)) { last = now; started = false; return; }
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
      dom?.removeEventListener("pointerdown", onRealInput);
      dom?.removeEventListener("wheel", onRealInput);
      dom?.removeEventListener("touchstart", onRealInput);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.nodes.length]);

  const anyHi = highlightNodes.current.size > 0;

  // ── Ambient flow set ──
  // Flow is now ON by default, and at rest "flow" used to mean 2 particles on
  // EVERY link — ~1,800 animated sprites across 884 links, which is both a
  // framerate problem and visually indistinguishable from static noise. Instead
  // we pick a bounded, deterministic sample of links to carry the ambient
  // stream: the map reads as alive and circulating, at a fixed cost regardless
  // of how big the vault grows. Hover/search still lights the FULL neighborhood.
  const AMBIENT_MAX = 150;
  const ambientFlow = useMemo(() => {
    const s = new Set<GLink>();
    const n = graph.links.length;
    if (!n) return s;
    const stride = Math.max(1, Math.ceil(n / AMBIENT_MAX));
    for (let i = 0; i < n; i += stride) s.add(graph.links[i]);
    return s;
  }, [graph.links]);

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
      // Matches SCENE_BG in VaultGraph.tsx so there is no pale flash before
      // WebGL paints. A touch bluer/less absolute than the old #04050a: against
      // a light app a pure-black rectangle reads as a hole, a deep navy reads as
      // a panel.
      backgroundColor="#05060d"
      showNavInfo={false}
      nodeLabel={(n: GNode) => n.name}
      nodeThreeObject={nodeThreeObject}
      nodeVal={(n: GNode) => n.val ?? 1.6}
      nodeOpacity={1}
      linkColor={(l: GLink) => {
        // At rest, 884 fully-saturated source-colored threads drown out the
        // nodes. So the resting bed is one quiet steel-blue and only the
        // highlighted neighborhood takes on its source color and pops.
        if (highlightLinks.current.has(l)) {
          const src = typeof l.source === "object" ? (l.source as GNode) : graph.nodes.find(n => n.id === lid(l.source));
          return src?.color ?? "#93c5fd";
        }
        return anyHi ? "rgba(127,168,217,0.08)" : "rgba(148,178,214,0.32)";
      }}
      linkWidth={(l: GLink) => (highlightLinks.current.has(l) ? 1.8 : 0.35)}
      linkOpacity={0.62}
      linkDirectionalParticles={(l: GLink) => {
        if (!flow) return 0;
        // Highlighted: full stream. At rest: only the bounded ambient sample.
        if (anyHi) return highlightLinks.current.has(l) ? 3 : 0;
        return ambientFlow.has(l) ? 1 : 0;
      }}
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
        onFramed?.(); // engine settled = scene is live; keep us in 3D
        if (!restored) sfx.playWhenReady("graph-arrive");
      }}
    />
  );
}
