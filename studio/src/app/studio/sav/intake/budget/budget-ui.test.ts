import { renderToStaticMarkup } from "react-dom/server";
import { it, expect, vi, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({ panel: vi.fn(), set: vi.fn() }));
vi.mock("@/lib/sav/intake/budget-admin", () => ({ readIntakeBudgetPanel: mocks.panel }));
vi.mock("./actions", () => ({ setBudgetAction: mocks.set }));
import Page from "./page";
const panel = { configuredNanoUsd: 3_000_000_000, effectiveNanoUsd: 5_000_000_000, override: { maxNanoUsd: 5_000_000_000 }, overrideInvalid: false, operational: true, configurationError: null, ceilingNanoUsd: 20_000_000_000,
  usage: { chargedNanoUsd: 3_268_608_000, remainingNanoUsd: 1_731_392_000, callCount: 4, maxCalls: 300, rollingChargedNanoUsd: 3_268_608_000, maxRollingNanoUsd: 90_000_000_000, uncertain: true, maxNanoUsd: 5_000_000_000 },
  history: [{ at: "2026-10-26T23:00:00.000Z", actor: "ugo@limova.ai", previousNanoUsd: null, nextNanoUsd: 5_000_000_000, reason: "Blocage" }] };
beforeEach(() => { vi.clearAllMocks(); mocks.panel.mockResolvedValue(panel); });
it("shows effective cap, today's usage, the form and history, inert on GET", async () => {
  const html = renderToStaticMarkup(await Page());
  for (const text of ["Budget quotidien de l’analyse IA", "5,00 USD (réglage Studio)", "3,00 USD", "3,27 USD — dont des réservations au coût encore inconnu", "1,73 USD", "4 / 300", "3,27 USD / 90,00 USD",
    "Maximum 20,00 USD par jour", "Enregistrer ce plafond", "Revenir à la configuration", "configuration → 5,00 USD · Blocage"]) expect(html).toContain(text);
  expect(mocks.set).not.toHaveBeenCalled();
});
it("warns when the stored cap is unreadable and hides reset when there is no override", async () => {
  mocks.panel.mockResolvedValue({ ...panel, override: null, overrideInvalid: true, usage: null, effectiveNanoUsd: null });
  const html = renderToStaticMarkup(await Page());
  expect(html).toContain("Le réglage enregistré est illisible");expect(html).not.toContain("Revenir à la configuration");
});
it("anyone but the budget owner is refused", async () => {
  mocks.panel.mockRejectedValue(Error("SAV_INTAKE_BUDGET_UNAUTHORIZED"));
  await expect(Page()).rejects.toThrow("SAV_INTAKE_BUDGET_UNAUTHORIZED");
});
