import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  turbopack: { root: process.cwd() },
  serverExternalPackages: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector"],
  allowedDevOrigins: ["127.0.0.1"],
};

export default withWorkflow(nextConfig);
