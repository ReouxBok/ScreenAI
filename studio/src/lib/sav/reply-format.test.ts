import { describe, expect, it } from "vitest";
import { cleanSavModelDraft, isSavAiAuthoredReply, LEGACY_AI_CHOICES, LEGACY_AI_DISCLOSURE, LEGACY_AI_NOTICE, renderSavOutboundReply, savReplyFooter } from "./reply-format";

describe("SAV send-only formatting", () => {
  it.each(["fr", "en"] as const)("renders the %s footer once without changing the draft", language => {
    const draft = language === "en" ? "Hello, which error do you see?" : "Bonjour, quelle erreur voyez-vous ?";
    const sent = renderSavOutboundReply(draft, language);
    expect(sent).toBe(`${draft}\n\n${savReplyFooter(language)}`);
    expect(renderSavOutboundReply(sent, language)).toBe(sent);
    expect(draft).not.toContain("Charly");
    expect(isSavAiAuthoredReply(sent)).toBe(true);
    expect(sent).not.toMatch(/3 jours|instantanée/);
  });
  it("recognizes historical authorship without rewriting historical storage", () => {
    expect(isSavAiAuthoredReply(`${LEGACY_AI_DISCLOSURE}\nAncienne réponse`)).toBe(true);
    expect(isSavAiAuthoredReply("Une réponse humaine." )).toBe(false);
  });
  it("removes only app-owned boilerplate from new model output", () => {
    const body = "Bonjour, quelle erreur obtenez-vous ?";
    expect(cleanSavModelDraft([LEGACY_AI_DISCLOSURE, body, LEGACY_AI_NOTICE, LEGACY_AI_CHOICES, savReplyFooter()].join("\n\n"))).toBe(body);
    expect(cleanSavModelDraft("Disponible jeudi à 14h, sans promesse de rappel." )).toBe("Disponible jeudi à 14h, sans promesse de rappel.");
    expect(() => renderSavOutboundReply(" ")).toThrow("SAV_REPLY_EMPTY");
  });
});
