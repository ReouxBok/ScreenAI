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
  m.panel.mockResolvedValue({ configured: true, campaignId: "synthetic-60", denominators: { done: 0, listed: 60, interrupted: 0 }, spend: { nanoUsd: 123000, maxNanoUsd: 20e9 }, until: "synthetic",
    rows: Array.from({ length: 60 }, (_, i) => ({ messageId: String(i), state: "pending" })) });
  const html = renderToStaticMarkup(await Page());
  for (const text of ["maximum 5 USD", "maximum 20 USD au total", "J’ai vérifié les dix résultats", "Les réservations incertaines restent comptées", "Aucun email ni ticket modifié"]) expect(html).toContain(text);
  expect(html).toContain('name="expectedMessageId"'); expect(html).toContain('name="stage"'); expect(html).toContain('value="sentinels"'); expect(html).toContain('value="remaining"'); expect(m.run).not.toHaveBeenCalled();
});
it("denied operator session cannot expose the report", async () => {
  m.panel.mockRejectedValue(Error("NO_SESSION")); await expect(Page()).rejects.toThrow("NO_SESSION");
});
it("SAV-46 lists each done dossier with a link to its private receipt and says identical is only a projection", async () => {
  m.panel.mockResolvedValue({ configured: true, campaignId: "synthetic-60", denominators: { done: 1, listed: 60, interrupted: 0 }, spend: { nanoUsd: 0, maxNanoUsd: 20e9 }, until: "synthetic",
    rows: Array.from({ length: 60 }, (_, i) => i === 0 ? { messageId: "10000000-0000-4000-8000-000000000001", state: "done", verdict: "identical", qualificationEvidence: "legacy", attestation: null } : { messageId: String(i), state: "pending" }) });
  const html = renderToStaticMarkup(await Page());
  expect(html).toContain('href="/studio/sav/intake/comparison/10000000-0000-4000-8000-000000000001"');
  expect(html).toContain("ce n’est ni un jugement métier ni une qualification");
  expect(html).toContain("preuve legacy"); expect(html).toContain("non attesté");
});
