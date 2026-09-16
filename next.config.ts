import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No source maps in the production bundle (smaller build, faster load).
  productionBrowserSourceMaps: false,
  // NOTE: experimental.optimizePackageImports was tried for reicon-react /
  // motion / three / three-stdlib but it made Turbopack dev emit broken chunks
  // (hundreds of "Unexpected token ':'" runtime errors), so it was removed.
  // Real load-time wins live in cutting hidden-view polling, not here.
};

export default nextConfig;
