import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ panel: vi.fn(), run: vi.fn() }));
vi.mock("@/lib/sav/intake/comparison-operator", () => ({ readIntakeComparisonPanel: m.panel, comparisonPhaseCanContinue: () => true, comparisonSentinelsReady: () => false }));
vi.mock("./actions", () => ({ runComparisonAction: m.run }));
import Page from "./page";
beforeEach(() => vi.clearAllMocks());
it("inactive GET has no form and cannot trigger a comparison", async () => {
  m.panel.mockResolvedValue({ configured: false });
  const html = renderToStaticMarkup(await Page());
  expect(html).toContain("Campagne non configurée"); expect(html).not.toContain("<form"); expect(m.run).not.toHaveBeenCalled();
});
it("shows separate phase caps, progress and an explicit semantic review attestation", async () => {
  m.panel.mockResolvedValue({ configured: true, denominators: { done: 0, listed: 60, interrupted: 0 }, spend: { nanoUsd: 123000, maxNanoUsd: 20e9 }, until: "synthetic",
    rows: Array.from({ length: 60 }, (_, i) => ({ messageId: String(i), state: "pending" })) });
  const html = renderToStaticMarkup(await Page());
  for (const text of ["maximum 5 USD", "maximum 20 USD au total", "J’ai vérifié les dix résultats", "Les réservations incertaines restent comptées", "Aucun email ni ticket modifié"]) expect(html).toContain(text);
  expect(html).toContain('name="stage"'); expect(html).toContain('value="sentinels"'); expect(html).toContain('value="remaining"'); expect(m.run).not.toHaveBeenCalled();
});
it("denied operator session cannot expose the report", async () => {
  m.panel.mockRejectedValue(Error("NO_SESSION")); await expect(Page()).rejects.toThrow("NO_SESSION");
});
