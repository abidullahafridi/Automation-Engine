import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  reactStrictMode: true,
  typedRoutes: true,
  distDir: process.env["NEXT_DIST_DIR"] ?? ".next"
};

export default nextConfig;
