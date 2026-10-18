import { describe, expect, it } from "vitest";
import { cleanSavModelDraft, isSavAiAuthoredReply, LEGACY_AI_CHOICES, LEGACY_AI_DISCLOSURE, LEGACY_AI_NOTICE, renderSavOutboundReply, savReplyFooter, SAV_REPLY_SIGNATURE, SAV_REPLY_NOTICE } from "./reply-format";
const previousNotice = "Cette réponse a été préparée avec une IA, qui peut se tromper. Si nécessaire, demandez une vérification à l’équipe Limova.";
describe("mode-specific preview and send formatting", () => {
  it("identifies the automatic agent without claiming human review or a delay", () => {
    const footer = savReplyFooter("fr", "automated");
    expect(footer).toBe(`${SAV_REPLY_SIGNATURE}\n${SAV_REPLY_NOTICE}`);
    expect(footer).toMatch(/automatiquement.*IA/); expect(footer).not.toMatch(/validée|relue|3 jours|rapide|instantanée/);
  });
  it("distinguishes reviewed AI from a human-authored reply", () => {
    expect(savReplyFooter("fr", "manual_reviewed")).toMatch(/L’équipe Limova.*\n.*IA.*validée/);
    expect(savReplyFooter("fr", "manual_authored")).toBe("L’équipe Limova");
    expect(savReplyFooter("en", "manual_authored")).toBe("The Limova team");
  });
  it.each(["fr", "en"] as const)("renders all %s modes once without changing the draft", language => {
    const draft = language === "en" ? "Hello, which error do you see?" : "Bonjour, quelle erreur voyez-vous ?";
    for (const mode of ["manual_reviewed", "manual_authored", "automated"] as const) {
      const sent = renderSavOutboundReply(draft, language, mode);
      expect(sent).toBe(`${draft}\n\n${savReplyFooter(language, mode)}`);
      expect(renderSavOutboundReply(sent, language, mode)).toBe(sent);
      expect(draft).not.toContain("Limova");
      expect(isSavAiAuthoredReply(sent)).toBe(mode !== "manual_authored");
    }
  });
  it("preserves recognition and normalization of historical replies", () => {
    const body = "Bonjour, modèle fictif.";
    for (const signature of ["Charly", "Charly, assistant IA SAV"]) {
      const old = `${body}\n\n${signature}\n${previousNotice}`;
      expect(isSavAiAuthoredReply(old)).toBe(true);
      expect(renderSavOutboundReply(old)).toBe(`${body}\n\n${savReplyFooter()}`);
      expect(old).toContain(previousNotice);
    }
    expect(isSavAiAuthoredReply(`${LEGACY_AI_DISCLOSURE}\nAncienne réponse`)).toBe(true);
    expect(isSavAiAuthoredReply("Une réponse humaine.")).toBe(false);
  });
  it("normalizes mixed languages and modes without duplicating signatures", () => {
    const body = "Bonjour, modèle fictif.";
    const mixed = `${body}\n\n${savReplyFooter("fr", "automated")}\n\n${savReplyFooter("en")}`;
    expect(renderSavOutboundReply(mixed)).toBe(`${body}\n\n${savReplyFooter()}`);
  });
  it("removes owned boilerplate but preserves a team name in actual content", () => {
    const body = "Bonjour, quelle erreur obtenez-vous ?";
    expect(cleanSavModelDraft([LEGACY_AI_DISCLOSURE, body, LEGACY_AI_NOTICE, LEGACY_AI_CHOICES, savReplyFooter()].join("\n\n"))).toBe(body);
    expect(cleanSavModelDraft("L’équipe Limova apparaît dans le message reçu.")).toBe("L’équipe Limova apparaît dans le message reçu.");
    expect(() => renderSavOutboundReply(" ")).toThrow("SAV_REPLY_EMPTY");
  });
});
