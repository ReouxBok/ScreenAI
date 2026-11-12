import { describe, expect, it } from "vitest";
import { intakeBlockedRowLabel, intakeBlockedSubCause, intakeBlockedCauseLabel, intakeSchedulerStopped, intakeSubCauseLabel } from "./console-presentation";

/** Console PR-1: synthetic rows only. `technical_wait` stays the stable code; the sub-cause is a separate field. */
const wait = (status: string, reason: string | null) => ({ blockedCause: "technical_wait", status, reason });
describe("technical wait sub-cause", () => {
  it.each([
    ["followup_pending", "Actions confirmées, premier suivi en attente", "followup_queued", "Premier suivi en file : le rattrapage le traitera au prochain passage"],
    ["followup_pending", "Collecte du suivi incomplète", "followup_incomplete", "Suivi incomplet : une source n’a pas été lue, le rattrapage la relira"],
    ["waiting", "Les sources locales ont changé depuis le résultat confirmé", "sources_changed", "Sources modifiées : nouvelle vérification nécessaire"],
    ["context_changed", "Les sources locales doivent être réinvestiguées", "sources_changed", "Sources modifiées : nouvelle vérification nécessaire"],
    ["waiting", "SAV_INTAKE_CRM_READ_INCOMPLETE", "verification_pending", "Vérification HubSpot/Gmail en attente"],
    ["waiting", null, "verification_pending", "Vérification HubSpot/Gmail en attente"],
    ["human_revalidation", "Choix enregistré, revalidation en cours", "revalidation_running", "Choix enregistré : vérification en cours"],
    ["processing", null, "analysis_queued", "Mail en attente d’analyse : le prochain passage le prendra"],
    ["pending", "Nouvelle entrée en attente d’analyse", "analysis_queued", "Mail en attente d’analyse : le prochain passage le prendra"],
    ["waiting", "SAV_INTAKE_RUNTIME_DAILY_BUDGET_DEFERRED", "budget_deferred", "Plafond IA atteint : reprise automatique quand il se libère"],
    ["observed", "motif inconnu de cette version", "unclassified", "Attente technique : cause non classée, ouvrir le dossier"],
  ])("%s / %s -> %s", (status, reason, sub, label) => {
    const row = wait(status, reason);
    expect(intakeBlockedSubCause(row)).toBe(sub);
    expect(intakeSubCauseLabel(sub as never)).toBe(label);
    expect(intakeBlockedRowLabel(row)).toBe(label);
    expect(intakeBlockedRowLabel(row)).not.toContain("attente technique de plus de 15 minutes");
  });
  it("leaves every other blocked cause, and every unblocked row, untouched", () => {
    for (const cause of ["attempts_exhausted", "private_resource_unavailable", "agent_paused", "input_invalid", null])
      expect(intakeBlockedSubCause({ blockedCause: cause, status: "waiting", reason: null })).toBeNull();
    expect(intakeBlockedRowLabel({ blockedCause: "attempts_exhausted", status: "waiting" })).toBe(intakeBlockedCauseLabel("attempts_exhausted"));
    expect(intakeBlockedCauseLabel("technical_wait")).toContain("attente technique de plus de 15 minutes"); // stable generic label kept for consumers
  });
  it("never shows an amount", () => {
    for (const sub of ["followup_queued", "followup_incomplete", "sources_changed", "verification_pending", "revalidation_running", "analysis_queued", "budget_deferred", "unclassified"] as const)
      expect(intakeSubCauseLabel(sub)).not.toMatch(/\d|€|\$|USD|EUR/);
  });
});
describe("stale reconcile pulse", () => {
  const now = new Date("2026-11-12T10:00:00Z"), ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  it("is a stop only after 30 minutes", () => {
    expect(intakeSchedulerStopped({ startedAt: ago(40), finishedAt: ago(31) }, now)).toBe(true);
    expect(intakeSchedulerStopped({ startedAt: ago(40), finishedAt: ago(30) }, now)).toBe(false);
    expect(intakeSchedulerStopped({ startedAt: ago(5), finishedAt: ago(2) }, now)).toBe(false);
    expect(intakeSchedulerStopped({ startedAt: ago(2880), finishedAt: null }, now)).toBe(true);
  });
  it("never claims a stop without a readable pulse", () => {
    expect(intakeSchedulerStopped(null, now)).toBe(false);
    expect(intakeSchedulerStopped({ startedAt: null, finishedAt: null }, now)).toBe(false);
    expect(intakeSchedulerStopped({ startedAt: "nope", finishedAt: null }, now)).toBe(false);
  });
});

/** SAV-88 (SAV-82 follow-up): a dossier whose ticket really exists is followed, not waiting for an analysis. */
describe("dossier with a ticket", () => {
  it.each([["pending", "Nouvelle entrée en attente d’analyse"], ["processing", null]])("%s / %s with a ticket -> ticket_tracked, never « Mail en attente d’analyse »", (status, reason) => {
    const row = { ...wait(status, reason), ticketId: "449217648841" };
    expect(intakeBlockedSubCause(row)).toBe("ticket_tracked");
    expect(intakeBlockedRowLabel(row)).toBe("Ticket créé, suivi en cours : l’équipe le voit dans HubSpot");
  });
  it.each([["waiting", null], ["waiting", "SAV_INTAKE_CRM_READ_INCOMPLETE"]])("a pending HubSpot/Gmail check stays named even with a ticket (%s / %s)", (status, reason) => {
    expect(intakeBlockedSubCause({ ...wait(status, reason), ticketId: "1" })).toBe("verification_pending");
  });
  it("a sources change stays named even with a ticket", () => {
    expect(intakeBlockedSubCause({ ...wait("context_changed", null), ticketId: "1" })).toBe("sources_changed");
  });
  it("without a ticket the labels are unchanged", () => {
    expect(intakeBlockedRowLabel({ ...wait("pending", null), ticketId: null })).toBe("Mail en attente d’analyse : le prochain passage le prendra");
  });
  it("a failed rescue is terminal and says « à traiter à la main »", () => {
    expect(intakeBlockedRowLabel({ blockedCause: "manual_required", status: "waiting", reason: null })).toBe("À traiter à la main — l’analyse de secours n’a pas abouti, aucun ticket n’a été créé.");
    expect(intakeBlockedSubCause({ blockedCause: "manual_required", status: "waiting", reason: null })).toBeNull();
  });
});
