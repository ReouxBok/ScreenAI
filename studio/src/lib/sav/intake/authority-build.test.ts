import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("../../../../scripts/intake-authority.mjs", () => ({ verifyIntakeAuthoritySources: state.verify }));
vi.mock("workflow/next", () => ({ withWorkflow: (config: unknown) => config }));
import configuration from "../../../../next.config";
beforeEach(() => { state.verify.mockReset(); });
it("checks authority before a direct Next production build", async () => {
  await configuration("phase-production-build", { defaultConfig: {} });
  expect(state.verify).toHaveBeenCalledTimes(1);
});
it("rejects a production build if sources no longer match", async () => {
  state.verify.mockImplementation(() => { throw Error("SAV_INTAKE_AUTHORITY_CHANGED"); });
  await expect(configuration("phase-production-build", { defaultConfig: {} })).rejects.toThrow("AUTHORITY_CHANGED");
});
it("does not require source files on the production server phase", async () => {
  await configuration("phase-production-server", { defaultConfig: {} });
  expect(state.verify).not.toHaveBeenCalled();
});
