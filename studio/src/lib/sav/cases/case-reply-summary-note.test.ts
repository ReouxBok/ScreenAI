import { describe, expect, it } from "vitest";
import {
  caseClosureNoteInteractionId, caseClosureNoteText, caseReplySummaryInteractionId, caseReplySummaryText, caseReplySummaryWithStage, isCaseClosureNote, isCaseReplySummary,
} from "./case-reply-summary-note";
import { buildCaseNoteIntent } from "./case-effect-intents";
import { hiddenMarkerNoteKey } from "../intake/execution-adapters";

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
  it("closure note (SAV-92 16/11): exact text from the proof's families; sensitive, other, unknown or unrecorded families get the generic label, never their name", () => {
    expect(caseClosureNoteText(["access"])).toBe("Le client a confirmé que son problème d'accès est résolu. Ticket fermé.");
    expect(caseClosureNoteText(["access", "access"])).toBe("Le client a confirmé que son problème d'accès est résolu. Ticket fermé.");
    expect(caseClosureNoteText(["usage"])).toBe("Le client a confirmé que sa question d'utilisation est résolue. Ticket fermé.");
    expect(caseClosureNoteText(["access", "technical"])).toBe("Le client a confirmé que ses demandes sont résolues. Ticket fermé.");
    for (const family of ["finance", "cancellation", "identity", "other", "unknown"]) {
      const text = caseClosureNoteText([family]);
      expect(text).toBe("Le client a confirmé que sa demande est résolue. Ticket fermé.");
      expect(text).not.toContain(family);
    }
    expect(caseClosureNoteText([])).toBe("Le client a confirmé que sa demande est résolue. Ticket fermé.");
    expect(caseClosureNoteInteractionId(3)).toBe("closed-summary.cycle-3");
    expect(isCaseClosureNote("closed-summary.cycle-3")).toBe(true);
    expect(isCaseReplySummary("closed-summary.cycle-3")).toBe(false);
  });
  it("only the two V2 summary notes hide their marker; a closure note's body carries no visible id", () => {
    expect(hiddenMarkerNoteKey("note:c1:closed-summary.cycle-1")).toBe(true);
    expect(hiddenMarkerNoteKey("note:c1:reply-summary.inbound:gm-1")).toBe(true);
    expect(hiddenMarkerNoteKey("note:c1:handoff:abc")).toBe(false);
    const intent = buildCaseNoteIntent({ caseId: "6f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f", interactionId: caseClosureNoteInteractionId(1), ticketId: "123", sourceMessageId: "x",
      text: caseClosureNoteText(["access"]), at: "2026-11-16T10:00:00.000Z" });
    expect(intent.key).toBe("note:6f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f:closed-summary.cycle-1");
    expect(intent.properties.hs_note_body).toBe(`<p>Le client a confirmé que son problème d&#39;accès est résolu. Ticket fermé.</p><!-- sav-intake:${intent.marker} -->`);
    expect(intent.properties.hs_note_body).not.toContain("[Studio intake");
  });
  it("one interaction id per reply trigger", () => {
    expect(caseReplySummaryInteractionId("inbound:gm-1")).toBe("reply-summary.inbound:gm-1");
    expect(isCaseReplySummary("reply-summary.inbound:gm-1")).toBe(true);
    expect(isCaseReplySummary("inbound:gm-1")).toBe(false);
  });
});
