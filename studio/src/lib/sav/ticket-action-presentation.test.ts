import { describe, expect, it } from "vitest";
import { savTicketActionPresentation } from "./ticket-action-presentation";
import { savTicketReturnPlan } from "./ticket-lifecycle";
import { SAV_HUBSPOT_SUPPORT } from "./hubspot-mapping";

describe("human ticket action names", () => {
  it.each([
    ["closed", "reactivate", "Réouvrir le ticket"],
    ["open", "reactivate", "Repasser en Nouveau"],
    ["open", "keep", "Rattacher le ticket"],
    ["closed", "create", "Ouvrir un nouveau ticket"],
    ["closed", "review", "Vérifier le ticket"],
  ] as const)("names %s/%s without altering the target", (status, operation, label) => {
    expect(savTicketActionPresentation({ status, subject: "Demande d’aide téléphonie" }, operation)).toMatchObject({ label, title: "Demande d’aide téléphonie" });
  });
  it("names the proposed successor and preserves its predecessor in the explanation", () => {
    expect(savTicketActionPresentation({ status: "closed", subject: "Ancien dossier" }, "create", "Nouvelle demande")).toMatchObject({ title: "Nouvelle demande", explanation: expect.stringContaining("Ancien dossier") });
  });
  it("follows the existing 15 day boundary and actual CRM stages", () => {
    const closed = { id: "12", subject: "Téléphonie", status: "closed" as const, closedAt: "2026-10-01T12:00:00Z" };
    expect(savTicketActionPresentation(closed, savTicketReturnPlan(closed, "2026-10-16T12:00:00Z").operation).label).toBe("Réouvrir le ticket");
    expect(savTicketActionPresentation(closed, savTicketReturnPlan(closed, "2026-10-16T12:00:01Z").operation).label).toBe("Ouvrir un nouveau ticket");
    for (const stageId of [SAV_HUBSPOT_SUPPORT.stages.awaitingContact, SAV_HUBSPOT_SUPPORT.stages.awaitingTeam]) {
      const open = { ...closed, status: "open" as const, stageId };
      expect(savTicketActionPresentation(open, savTicketReturnPlan(open, "2026-10-13T12:00:00Z").operation).label).toBe("Repasser en Nouveau");
    }
  });
});
