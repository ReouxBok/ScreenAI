import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

const nextConfig: NextConfig = {
  turbopack: { root: process.cwd() },
  serverExternalPackages: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector"],
  allowedDevOrigins: ["127.0.0.1"],
};

export default withWorkflow(async (phase) => {
  // Also applies to direct `next build`, not just the npm script or CI tests.
  if (phase === PHASE_PRODUCTION_BUILD) {
    const { verifyIntakeAuthoritySources } = await import("./scripts/intake-authority.mjs");
    verifyIntakeAuthoritySources();
  }
  return nextConfig;
});
