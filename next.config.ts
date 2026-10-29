import type { NextConfig } from "next";

// Standalone Node runtime. Secrets stay in the environment, not Next's `env`.
const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    authInterrupts: true,
  },
  // Optional override so host checks do not collide with a root-owned `.next`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
