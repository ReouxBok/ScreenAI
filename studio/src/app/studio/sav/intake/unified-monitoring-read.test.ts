import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { readDailyReviewSnapshot, type DailyReviewReadPorts } from "@/lib/sav/daily-review-read";
import { readUnifiedMonitoring } from "./unified-monitoring-read";
import { UnifiedConsoleOverview } from "./unified-console-overview";
const now = new Date("2026-11-10T19:00:00Z");
function ports(overrides: Partial<DailyReviewReadPorts> = {}): DailyReviewReadPorts {
  return { authorize: async () => ({}), now: () => now, dossiers: async () => [], monitor: async () => null, ...overrides };
}
function row(id: string, uncertain = false, paused = false) {
  return { id, requestedAt: "2026-11-10T18:00:00Z", effectAt: null, uncertain, paused };
}
const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222";
const render = (monitoring: Awaited<ReturnType<typeof readUnifiedMonitoring>>) => renderToStaticMarkup(createElement(UnifiedConsoleOverview, { lines: {}, monitoring }));
describe("authenticated reader → unified monitoring → operator view", () => {
  it("keeps an empty bounded sample partial and distinguishes read time from absent worker telemetry", async () => {
    const summary = await readUnifiedMonitoring(() => readDailyReviewSnapshot({}, ports()));
    expect(summary.state).toBe("available"); expect(summary.coverage).toBe("partial");
    const html = render(summary);
    expect(html).toContain("couverture partielle"); expect(html).toContain("Limite : 100 par moteur");
    expect(html).toContain("ne couvre pas tout le backlog"); expect(html).toContain("ne suit pas les filtres");
    expect(html).toContain("Instantané technique global : absent");
    expect(html).toContain("télémétrie non disponible"); expect(html).toContain("ne prouve pas l’absence d’incident");
    expect(html).not.toContain("non branchée"); expect(html).not.toContain("couverture complète");
  });
  it("shows truncation, stale monitor time and uncertain effects without a resend or action control", async () => {
    const summary = await readUnifiedMonitoring(() => readDailyReviewSnapshot({ limit: 1 }, ports({
      dossiers: async engine => engine === "v1" ? [row(a, true, true), row(b)] : [],
      monitor: async () => ({ observedAt: "2026-11-10T17:00:00Z", complete: false, issues: [] }),
    })));
    const html = render(summary);
    expect(html).toContain("relevé tronqué"); expect(html).toContain("ancien ou date incohérente");
    expect(html).toContain("10/11/2026 18:00"); expect(html).toContain("10/11/2026 20:00");
    expect(html).toContain("collecte partielle"); expect(html).toContain("Effet externe incertain (1)");
    expect(html).toContain("jamais de renvoi automatique"); expect(html).not.toContain("<button"); expect(html).not.toContain("<form");
  });
  it("retains missing sources and invalid rows without marking the worker stopped", async () => {
    const summary = await readUnifiedMonitoring(() => readDailyReviewSnapshot({}, ports({
      dossiers: async engine => { if (engine === "v1") throw Error("private-database-error"); return [row(a, false, true), { id: "invalid" }]; },
    })));
    const html = render(summary);
    expect(html).toContain("V1 indisponible ; V2 disponible"); expect(html).toContain("relevé incomplet");
    expect(html).toContain("Attente humaine (1)"); expect(html).not.toContain("private-database-error");
    expect(html).not.toContain("Démarrage non observé");
  });
  it("retains technical scope when both dossier sources are unavailable", async () => {
    const summary = await readUnifiedMonitoring(() => readDailyReviewSnapshot({}, ports({ dossiers: async () => { throw Error("unavailable"); } })));
    expect(summary.state).toBe("unavailable"); expect(summary.coverage).toBe("unknown");
    const html = render(summary); expect(html).toContain("Collecte indisponible"); expect(html).toContain("V1 indisponible ; V2 indisponible");
    expect(html).toContain("aucun rétablissement n’est confirmé");
  });
  it("fails closed before database reads on unauthorized access and redacts reader errors", async () => {
    const dossiers = vi.fn(); const monitor = vi.fn();
    const summary = await readUnifiedMonitoring(() => readDailyReviewSnapshot({}, ports({ authorize: async () => { throw Error("private-auth-detail"); }, dossiers, monitor })));
    expect(dossiers).not.toHaveBeenCalled(); expect(monitor).not.toHaveBeenCalled();
    expect(summary).toEqual({ state: "unavailable", coverage: "unknown", observedAt: null, causes: [] });
    expect(render(summary)).not.toContain("private-auth-detail");
  });
  it("wires the production page to the same authenticated reader without self HTTP or collector", () => {
    const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    expect(page.indexOf("await requireIntakeConsoleStaff()")).toBeLessThan(page.indexOf("readUnifiedMonitoring()"));
    expect(page).toContain("monitoring={unifiedMonitoring}");
    const source = readFileSync(new URL("./unified-monitoring-read.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(|collectSavMonitorSnapshot\(|runSavServerMonitor\(/);
  });
});
