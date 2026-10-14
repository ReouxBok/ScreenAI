import { describe, expect, it } from "vitest";
import { classifySavDossier, savDashboardReturnHref, savDashboardNextAction } from "./dashboard-state";

describe("SAV-55 disjoint dossier states", () => {
  const completed = { opening: "opened", reviewStatus: "approved", ticket: "confirmed", learning: "none" } as const;
  it("returns a newly received unread message to À traiter even on a completed or learning dossier", () => {
    expect(classifySavDossier({ ...completed, opening: "unopened", learning: "collecting" })).toBe("to_process");
  });
  it("does not fabricate new work from unknown historical reading", () => {
    expect(classifySavDossier({ ...completed, opening: "unknown" })).toBe("completed");
    expect(classifySavDossier({ ...completed, opening: "unknown", reviewStatus: null })).toBe("to_validate");
  });
  it.each(["required", "pending", "failed", "uncertain"] as const)("keeps a %s ticket action in À valider", ticket => {
    expect(classifySavDossier({ ...completed, ticket, learning: "collecting" })).toBe("to_validate");
  });
  it("finishes approved no-ticket cases without artificial creation", () => {
    expect(classifySavDossier({ ...completed, ticket: "not_required" })).toBe("completed");
    expect(classifySavDossier({ ...completed, ticket: "not_required", learning: "qualification" })).toBe("learning");
  });
  it.each([null, "rejected"])("requires current human dossier approval (%s)", reviewStatus => {
    expect(classifySavDossier({ ...completed, reviewStatus })).toBe("to_validate");
  });
  it("keeps drafts separate from dossier and ticket state", () => {
    expect(classifySavDossier(completed)).toBe("completed");
    expect(savDashboardNextAction({ ...completed, state: "completed", analysisFailed: false })).toBe("Traitement Studio terminé");
  });
  it("keeps only local inbox filters and dossier anchor in return links", () => {
    expect(savDashboardReturnHref("https://example.invalid")).toBe("/studio/sav");
    expect(savDashboardReturnHref("//example.invalid/studio/sav?q=a")).toBe("/studio/sav");
    expect(savDashboardReturnHref("/studio/sav?view=completed&q=Test&page=2&sort=oldest&unsafe=true#dossier-10000000-0000-4000-8000-000000000001")).toBe("/studio/sav?view=completed&q=Test&page=2&sort=oldest#dossier-10000000-0000-4000-8000-000000000001");
  });
});
