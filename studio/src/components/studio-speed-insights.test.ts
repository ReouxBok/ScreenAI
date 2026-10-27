import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { sanitizeStudioVital } from "@/lib/speed-insights";

const state = vi.hoisted(() => ({ props: null as null | Record<string, unknown>, denied: false }));
vi.mock("@vercel/speed-insights/next", () => ({ SpeedInsights: (props: Record<string, unknown>) => {
  state.props = props;
  return null;
} }));
vi.mock("@/lib/auth", () => ({ requireStaff: async () => {
  if (state.denied) throw new Error("unauthorized");
  return { role: "member" };
} }));
vi.mock("@/components/studio-shell", () => ({ StudioShell: ({ children }: { children: import("react").ReactNode }) => children }));

import StudioLayout from "@/app/studio/layout";

afterEach(() => { vi.unstubAllEnvs(); state.props = null; state.denied = false; });

it.each([["development", "production"], ["production", "preview"], ["production", "development"]])("does not load telemetry in %s/%s", async (node, vercel) => {
  vi.stubEnv("NODE_ENV", node); vi.stubEnv("VERCEL_ENV", vercel);
  renderToStaticMarkup(await StudioLayout({ children: createElement("p", null, "Studio") }));
  expect(state.props).toBeNull();
});

it("connects the redaction hook to the SDK only on production", async () => {
  vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("VERCEL_ENV", "production");
  expect(renderToStaticMarkup(await StudioLayout({ children: createElement("p", null, "Studio") }))).toContain("Studio");
  expect(state.props).toEqual({ beforeSend: sanitizeStudioVital, debug: false });
});

it("does not mount the SDK if authentication fails", async () => {
  vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("VERCEL_ENV", "production"); state.denied = true;
  await expect(StudioLayout({ children: createElement("p", null, "Private") })).rejects.toThrow("unauthorized");
  expect(state.props).toBeNull();
});
