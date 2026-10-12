import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ auth: vi.fn(), dashboard: vi.fn(), feedback: vi.fn(), sources: vi.fn() }));
vi.mock("@/lib/sav/auth", () => ({ requireSavStaff: deps.auth }));
vi.mock("@/lib/sav/metrics", () => ({ getSavV0Dashboard: deps.dashboard, getSavReviewFeedback: deps.feedback }));
vi.mock("@/lib/sav/reviewed-replay", () => ({ listSavReplaySources: deps.sources }));
vi.mock("../actions", () => ({ approveReplayAction: vi.fn(), recordDeploymentDecisionAction: vi.fn(), runReviewedReplayAction: vi.fn() }));
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => createElement("a", props) }));
import Page from "./page";
beforeEach(() => {
  vi.clearAllMocks(); deps.auth.mockResolvedValue({ email: "ugo@limova.ai" }); deps.sources.mockResolvedValue([]);
  deps.dashboard.mockResolvedValue({ versions: [], ingestion: [], failedSyncs: 0, failedActions: 0, pendingKnowledge: 0, duplicates: 0, pendingResolutions: 0, cutover: null, truncated: false, replayHistory: [], decisions: [] });
  const base = { messageId: "synthetic-message", decisionId: "synthetic-decision", agentRunId: "synthetic-run", threadId: "synthetic-thread", reviewedAt: new Date("2026-10-12T08:00:00Z"), reviewedBy: "ugo@limova.ai", isCurrent: true, model: "synthetic-model", promptRevision: "synthetic-prompt", codeRevision: "a".repeat(40), knowledgeRevision: null };
  deps.feedback.mockResolvedValue({ truncated: false, entries: [{ ...base, id: "synthetic-review", scope: "dossier", status: "approved", verdict: "partial", reasons: ["wrong_category"], text: "Correction humaine conservée", originalCategory: "billing", correctedCategory: "technical" }, { ...base, id: "synthetic-refusal", scope: "draft", status: "rejected", verdict: null, reasons: ["off_topic"], text: "Réponse hors demande", originalCategory: null, correctedCategory: null }] });
});
it("makes both feedback streams retrievable with their versions and dossier link", async () => {
  const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
  for (const expected of ["Dossier · compréhension et catégorisation", "Brouillon · qualité de réponse", "Mauvaise catégorie", "Réponse hors sujet", "synthetic-prompt", "synthetic-run", 'href="/studio/sav/synthetic-thread"', "Correction humaine conservée"]) expect(html).toContain(expected);
});
it("filters persisted evaluation cases by structured reason", async () => {
  const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ reason: "off_topic" }) }));
  expect(html).toContain("Réponse hors demande"); expect(html).not.toContain("Correction humaine conservée");
});
it("authenticates before loading feedback", async () => {
  deps.auth.mockRejectedValue(new Error("SAV_ACCESS_FORBIDDEN"));
  await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow("SAV_ACCESS_FORBIDDEN");
  expect(deps.feedback).not.toHaveBeenCalled();
});
