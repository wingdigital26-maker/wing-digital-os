// Shared graph node/link shapes used by both the reliable 2D canvas renderer
// (VaultGraph.tsx) and the opt-in 3D WebGL galaxy (VaultGraph3D.tsx).
export interface GNode {
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
  // force-sim positions (added by the library at runtime)
  x?: number;
  y?: number;
  z?: number;
}
export interface GLink {
  source: string | GNode;
  target: string | GNode;
}
