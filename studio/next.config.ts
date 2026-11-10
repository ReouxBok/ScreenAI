import type { NextConfig } from "next";
import path from "node:path";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  ...(process.env.NODE_ENV === "development" && process.env.SAV_SYN_PREVIEW === "true" ? { experimental: { webpackMemoryOptimizations: true } } : {}),
  turbopack: { root: process.cwd() },
  serverExternalPackages: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector"],
  // Local-only dependency resolution: use the already installed package; never install or change the shared node_modules link.
  webpack(config) {
    if (process.env.NODE_ENV === "development" && process.env.SAV_SYN_PREVIEW === "true") {
      config.cache = false;
      config.resolve.alias["@vercel/speed-insights/next"] = path.join(process.env.SAV_SYN_EXISTING_DEPS!, "@vercel/speed-insights/dist/next/index.mjs");
    }
    return config;
  },
  allowedDevOrigins: ["127.0.0.1"],
};

export default withWorkflow(nextConfig);
