import { describe, expect, it } from "vitest";
import { caseReplySummaryInteractionId, caseReplySummaryText, caseReplySummaryWithStage, isCaseReplySummary } from "./case-reply-summary-note";

describe("reply summary note text (pure, deterministic)", () => {
  it("Accès: problem, action, then only the stage really planned", () => {
    const text = caseReplySummaryText({ families: ["access"], purpose: "answer" });
    expect(text).toBe("Le client signale un problème d'accès. J'ai répondu avec la procédure de connexion.");
    expect(caseReplySummaryWithStage(text, "waiting_customer")).toBe(`${text} Ticket passé en attente du client.`);
    expect(caseReplySummaryWithStage(text, "closed")).toBe(`${text} Ticket fermé.`);
    expect(caseReplySummaryWithStage(text, null)).toBe(text);
  });
  it("other purposes and families; sensitive, other or unknown families get a safe generic label, never their name", () => {
    expect(caseReplySummaryText({ families: ["usage"], purpose: "answer" })).toBe("Le client signale une question d'utilisation. J'ai répondu avec les explications adaptées.");
    expect(caseReplySummaryText({ families: ["access", "technical"], purpose: "question" })).toBe("Le client signale un problème d'accès et un problème technique. J'ai demandé au client les informations manquantes.");
    expect(caseReplySummaryText({ families: ["access"], purpose: "reminder" })).toBe("Le client signale un problème d'accès. J'ai relancé le client.");
    for (const family of ["finance", "cancellation", "identity", "other", "unknown"]) {
      const text = caseReplySummaryText({ families: [family], purpose: "answer" });
      expect(text).toBe("Le client signale une demande. J'ai répondu avec les explications adaptées.");
      expect(text).not.toContain(family);
    }
    expect(caseReplySummaryText({ families: [], purpose: "answer" })).toBe("Le client signale une demande. J'ai répondu avec les explications adaptées.");
    expect(caseReplySummaryText({ families: ["access", "usage", "technical"], purpose: "answer" })).toBe("Le client signale plusieurs demandes. J'ai répondu avec les explications adaptées.");
  });
  it("one interaction id per reply trigger", () => {
    expect(caseReplySummaryInteractionId("inbound:gm-1")).toBe("reply-summary.inbound:gm-1");
    expect(isCaseReplySummary("reply-summary.inbound:gm-1")).toBe(true);
    expect(isCaseReplySummary("inbound:gm-1")).toBe(false);
  });
});
