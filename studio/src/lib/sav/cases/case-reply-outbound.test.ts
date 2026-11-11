import { describe, expect, it } from "vitest";
import { LEGACY_AI_DISCLOSURE, LEGACY_AI_NOTICE, renderSavOutboundReply, SAV_REPLY_NOTICE, savReplyFooter } from "../reply-format";
import { caseReplyPayloadHash, type CaseReplyProposal } from "./case-effects";
import { CASE_REPLY_OUTBOUND_CONTRACT, caseReplyApprovedMode, caseReplyHelpLine, caseReplyFinalTextProblem, finalizeCaseReplyProposal, prepareCaseReplyText, readCaseReplyDisclosure } from "./case-reply-outbound";

// UX (V2 outbound format): preparation of the final text on the shared format. No new wording: every mention below is the shared one.
const BODY = "Bonjour,\n\nVoici la marche à suivre synthétique.";

describe("prepareCaseReplyText: the final V2 text, prepared once before validation", () => {
  it("prepared with AI and validated by the team (FR/EN): the shared footer, exactly once", () => {
    expect(prepareCaseReplyText(BODY, "fr", "manual_reviewed")).toBe(`${BODY}\n\nPour nous aider à vous répondre, précisez ce que vous essayiez de faire, ce qui s’est affiché et ce que vous avez déjà essayé.\n\nL’équipe Limova\nCette réponse a été rédigée avec l’aide de notre agent IA. L’IA peut se tromper. Si quelque chose ne fonctionne pas ou si vous avez une question, n’hésitez pas à répondre à ce message.`);
    expect(prepareCaseReplyText("Hello,\n\nSynthetic steps.", "en", "manual_reviewed")).toBe("Hello,\n\nSynthetic steps.\n\nTo help us answer you, please tell us what you were trying to do, what appeared on screen and what you have already tried.\n\nThe Limova team\nThis reply was written with help from our AI agent. AI can make mistakes. If something doesn’t work or you have a question, feel free to reply to this message.");
  });

  it("automatic (FR/EN): AI named, errors possible, how to continue the request; no delay promised", () => {
    const fr = prepareCaseReplyText(BODY, "fr", "automated"), en = prepareCaseReplyText(BODY, "en", "automated");
    expect(fr.endsWith(`Charly — Agent IA du support Limova\n${SAV_REPLY_NOTICE}`)).toBe(true);
    for (const words of ["automatiquement par une IA", "peut contenir des erreurs", "répondez à ce message"]) expect(fr).toContain(words);
    for (const words of ["automatically by an AI", "may contain errors", "reply with details"]) expect(en).toContain(words);
    for (const text of [fr, en]) expect(text).not.toMatch(/délai|jours|delay|days/i);
  });

  it("is idempotent and never stacks: twice, after a language switch, after a mode switch, or on a draft that carries old boilerplate", () => {
    for (const language of ["fr", "en"] as const) for (const mode of ["manual_reviewed", "automated"] as const) {
      const once = prepareCaseReplyText(BODY, language, mode);
      expect(prepareCaseReplyText(once, language, mode)).toBe(once);
      expect(prepareCaseReplyText(prepareCaseReplyText(BODY, language === "fr" ? "en" : "fr", mode), language, mode)).toBe(once);
      expect(prepareCaseReplyText(prepareCaseReplyText(BODY, language, mode === "automated" ? "manual_reviewed" : "automated"), language, mode)).toBe(once);
      expect(prepareCaseReplyText(`${LEGACY_AI_DISCLOSURE}\n${BODY}\n${LEGACY_AI_NOTICE}`, language, mode)).toBe(once);
      expect(readCaseReplyDisclosure(once)).toEqual({ mode, language });
    }
    expect(prepareCaseReplyText(BODY, "unknown", "manual_reviewed")).toBe(prepareCaseReplyText(BODY, "fr", "manual_reviewed"));
  });

  // 11/11 (real Access test): a reply asked the customer twice at its end. ONE follow-up per reply: a question reply is its own follow-up, every other purpose has the standard line.
  it("a question reply carries its own question and no standard line; an answer keeps the line once; neither stacks", () => {
    const ASK = "Bonjour,\n\nQuel message s’affiche à l’écran après la saisie de votre adresse e-mail ?";
    const line = caseReplyHelpLine("fr");
    for (const mode of ["manual_reviewed", "automated"] as const) {
      const question = prepareCaseReplyText(ASK, "fr", mode, "question");
      expect(question).not.toContain(line);
      expect(question.split("?").length - 1).toBe(1);
      expect(prepareCaseReplyText(question, "fr", mode, "question")).toBe(question);
      expect(readCaseReplyDisclosure(question)).toEqual({ mode, language: "fr" });
      for (const purpose of ["answer", "reminder", undefined] as const) {
        const answer = prepareCaseReplyText(BODY, "fr", mode, purpose);
        expect(answer.split(line).length - 1).toBe(1);
        expect(prepareCaseReplyText(answer, "fr", mode, purpose)).toBe(answer);
      }
      // a draft that already carries the line (an older proposal) is re-prepared as a question without it, never with two
      expect(prepareCaseReplyText(prepareCaseReplyText(ASK, "fr", mode, "answer"), "fr", mode, "question")).toBe(question);
    }
    const proposal = { caseId: "c", caseVersion: 1, triggerEventId: "inbound:g", inboundMessageId: "m", purpose: "question" as const, recipient: "a@example.invalid", subject: "S", text: ASK,
      question: { id: "q1", text: "Quel message ?", factKeys: [] } };
    expect(finalizeCaseReplyProposal(proposal, { language: "fr", validation: "human" }).text).not.toContain(line);
    expect(finalizeCaseReplyProposal({ ...proposal, purpose: "answer", question: undefined }, { language: "fr", validation: "human" }).text).toContain(line);
  });

  it("a draft without content is refused, not turned into a mention alone", () => {
    for (const draft of ["", "   ", savReplyFooter("fr", "manual_reviewed")]) expect(() => prepareCaseReplyText(draft, "fr", "manual_reviewed")).toThrow("SAV_REPLY_EMPTY");
  });
});

describe("readCaseReplyDisclosure: what the approved text claims", () => {
  it("only an AI mention in the exact shared form; a human signature, nothing, or a non canonical text claims nothing", () => {
    expect(readCaseReplyDisclosure(BODY)).toBeNull();
    expect(readCaseReplyDisclosure(renderSavOutboundReply(BODY, "fr", "manual_authored"))).toBeNull();
    expect(readCaseReplyDisclosure(`${prepareCaseReplyText(BODY, "fr", "manual_reviewed")}\n`)).toBeNull();
    expect(readCaseReplyDisclosure(`${BODY}\n\n${savReplyFooter("fr", "automated")}\n\n${savReplyFooter("fr", "manual_reviewed")}`)).toBeNull();
    expect(readCaseReplyDisclosure(42 as never)).toBeNull();
  });

  it("an approval is a person's validation: it allows 'prepared with AI and validated by the team' only", () => {
    const approval = { payloadHash: "a".repeat(64), caseVersion: 1, recipient: "c@example.invalid", approvedBy: "staff@example.invalid", approvedAt: "2026-10-31T09:00:00.000Z" };
    expect(caseReplyApprovedMode(approval)).toBe("manual_reviewed");
    expect(caseReplyApprovedMode({ ...approval, approvedBy: "" })).toBeNull();
  });
});

describe("the shared format is unchanged for real human replies (V1 manual path)", () => {
  it("a reply a person wrote keeps the team signature only, with no AI mention", () => {
    expect(renderSavOutboundReply("Bonjour, réponse écrite par une personne.", "fr", "manual_authored")).toBe("Bonjour, réponse écrite par une personne.\n\nL’équipe Limova");
    expect(renderSavOutboundReply("Hello, written by a person.", "en", "manual_authored")).toBe("Hello, written by a person.\n\nThe Limova team");
  });
});

describe("contract for the producer and the store: finalize before the proposal exists, refuse before anything is hashed or stored", () => {
  const draft: CaseReplyProposal = { caseId: "10000000-0000-4000-8000-000000000001", caseVersion: 2, triggerEventId: "inbound:gmail-1",
    inboundMessageId: "20000000-0000-4000-8000-000000000002", purpose: "question", recipient: "customer@example.invalid", subject: "Synthetic", text: BODY,
    question: { id: "q1", text: "SYNTHETIC question?", factKeys: [] } };

  it("names its revision", () => { expect(CASE_REPLY_OUTBOUND_CONTRACT).toBe("sav-v2-reply-outbound.v1"); });

  it("finalize changes only the text, FR/EN, with the human-validation mention; finalizing twice is the same proposal and the same hash", () => {
    for (const language of ["fr", "en"] as const) {
      const final = finalizeCaseReplyProposal(draft, { language, validation: "human" });
      expect({ ...final, text: BODY }).toEqual(draft);
      expect(final.text).toBe(prepareCaseReplyText(BODY, language, "manual_reviewed", draft.purpose)); // the draft is a question reply: its question is its follow-up
      expect(finalizeCaseReplyProposal(final, { language, validation: "human" })).toEqual(final);
      expect(caseReplyPayloadHash(finalizeCaseReplyProposal(final, { language, validation: "human" }))).toBe(caseReplyPayloadHash(final));
      expect(caseReplyFinalTextProblem(final.text)).toBeNull();
    }
  });

  it("only the two known formats: anything else is refused", () => {
    for (const validation of ["automatic", "auto", "manual_authored", "", undefined]) expect(() => finalizeCaseReplyProposal(draft, { language: "fr", validation: validation as never })).toThrow("SAV_REPLY_VALIDATION_INVALID");
  });

  it("the store's check: raw, human-only, stacked or non canonical text is ai_notice_missing; the automatic notice is ai_notice_mode; a final text passes", () => {
    for (const text of [BODY, renderSavOutboundReply(BODY, "fr", "manual_authored"), `${prepareCaseReplyText(BODY, "fr", "manual_reviewed")} `,
      `${BODY}\n\n${savReplyFooter("en", "manual_reviewed")}\n\n${savReplyFooter("fr", "manual_reviewed")}`, "", 7 as never]) expect(caseReplyFinalTextProblem(text)).toBe("ai_notice_missing");
    for (const language of ["fr", "en"] as const) expect(caseReplyFinalTextProblem(prepareCaseReplyText(BODY, language, "automated"))).toBe("ai_notice_mode");
    for (const language of ["fr", "en"] as const) expect(caseReplyFinalTextProblem(prepareCaseReplyText(BODY, language, "manual_reviewed"))).toBeNull();
  });

  it("final-body invariant: whatever the draft, a finalized text is accepted by the store check and re-rendering it changes nothing", () => {
    for (const body of [BODY, `${LEGACY_AI_DISCLOSURE}\n${BODY}`, `${BODY}\n\nL’équipe Limova`, prepareCaseReplyText(BODY, "en", "automated"), "  Hello.  "]) for (const language of ["fr", "en", "unknown"] as const) {
      const text = finalizeCaseReplyProposal({ ...draft, text: body }, { language, validation: "human" }).text;
      expect(caseReplyFinalTextProblem(text)).toBeNull();
      expect(prepareCaseReplyText(text, language, "manual_reviewed", draft.purpose)).toBe(text);
      expect(text.split("\n\n").filter(part => part.includes("IA") || part.includes("AI"))).toHaveLength(1);
    }
  });
});

describe("ROOT contract: automated is format only, the default stays the human validation", () => {
  const draft: CaseReplyProposal = { caseId: "10000000-0000-4000-8000-000000000001", caseVersion: 2, triggerEventId: "inbound:gmail-1",
    inboundMessageId: "20000000-0000-4000-8000-000000000002", purpose: "answer", recipient: "customer@example.invalid", subject: "Synthetic", text: BODY };

  it("the default check is unchanged: an older caller is not widened, an automated text is still refused without an explicit expected mode", () => {
    for (const language of ["fr", "en"] as const) {
      const automated = finalizeCaseReplyProposal(draft, { language, validation: "automated" }).text;
      expect(caseReplyFinalTextProblem(automated)).toBe("ai_notice_mode");
      expect(caseReplyFinalTextProblem(automated, "automated")).toBeNull();
      expect(readCaseReplyDisclosure(automated)).toEqual({ mode: "automated", language });
    }
  });

  it("incompatible signatures are refused in both directions, and a text cannot pick its own mode", () => {
    const human = finalizeCaseReplyProposal(draft, { language: "fr", validation: "human" }).text;
    expect(caseReplyFinalTextProblem(human, "automated")).toBe("ai_notice_mode");
    for (const unknown of ["manual_authored", "auto", ""]) expect(caseReplyFinalTextProblem(human, unknown as never)).toBe("ai_notice_mode");
    expect(caseReplyFinalTextProblem(renderSavOutboundReply(BODY, "fr", "manual_authored"), "automated")).toBe("ai_notice_missing");
    expect(caseReplyFinalTextProblem(BODY, "automated")).toBe("ai_notice_missing");
  });

  it("automated grants nothing: an approval still only allows the human mention, and the format alone changes only the text", () => {
    const automated = finalizeCaseReplyProposal(draft, { language: "fr", validation: "automated" });
    expect({ ...automated, text: BODY }).toEqual(draft);
    expect(finalizeCaseReplyProposal(automated, { language: "fr", validation: "automated" })).toEqual(automated);
    expect(caseReplyPayloadHash(automated)).not.toBe(caseReplyPayloadHash(finalizeCaseReplyProposal(draft, { language: "fr", validation: "human" })));
    expect(caseReplyApprovedMode({ payloadHash: "a".repeat(64), caseVersion: 2, recipient: draft.recipient, approvedBy: "syn", approvedAt: "2026-10-31T09:00:00.000Z" })).toBe("manual_reviewed");
  });
});

describe("help line of a V2 access reply (Ugo, 4/11)", () => {
  const count = (text: string, part: string) => text.split(part).length - 1;

  it("FR/EN, assisted and automatic: exactly once, between the content and the unchanged signature and AI mention", () => {
    for (const language of ["fr", "en"] as const) for (const mode of ["manual_reviewed", "automated"] as const) {
      const text = prepareCaseReplyText(BODY, language, mode);
      expect(text).toBe(`${BODY}\n\n${caseReplyHelpLine(language)}\n\n${savReplyFooter(language, mode)}`);
      expect(count(text, caseReplyHelpLine(language))).toBe(1);
    }
    expect(caseReplyHelpLine("unknown")).toBe(caseReplyHelpLine("fr"));
  });

  it("never stacks: prepared twice, after a language or mode switch, or when the draft already carries it", () => {
    for (const language of ["fr", "en"] as const) {
      const once = prepareCaseReplyText(BODY, language, "manual_reviewed");
      expect(prepareCaseReplyText(once, language, "manual_reviewed")).toBe(once);
      expect(prepareCaseReplyText(prepareCaseReplyText(BODY, language === "fr" ? "en" : "fr", "automated"), language, "manual_reviewed")).toBe(once);
      expect(prepareCaseReplyText(`${BODY}\n\n${caseReplyHelpLine(language)}`, language, "manual_reviewed")).toBe(once);
    }
  });

  it("a draft with only the line or a signature is empty: never a help line alone", () => {
    for (const draft of [caseReplyHelpLine("fr"), caseReplyHelpLine("en"), `${caseReplyHelpLine("fr")}\n\nL’équipe Limova`]) expect(() => prepareCaseReplyText(draft, "fr", "manual_reviewed")).toThrow("SAV_REPLY_EMPTY");
  });

  it("asks for no code, password or secret, promises no delay", () => {
    for (const language of ["fr", "en"] as const) expect(caseReplyHelpLine(language)).not.toMatch(/code|mot de passe|password|secret|token|clé|key|délai|delay/i);
  });

  it("a text stored before this line stays valid as it is: its mention, its hash and a person's own signature are untouched", () => {
    const stored = renderSavOutboundReply(BODY, "fr", "manual_reviewed");
    expect(stored).not.toContain(caseReplyHelpLine("fr"));
    expect(caseReplyFinalTextProblem(stored)).toBeNull();
    expect(renderSavOutboundReply("Réponse écrite par une personne.", "fr", "manual_authored")).toBe("Réponse écrite par une personne.\n\nL’équipe Limova");
    expect(savReplyFooter("fr", "manual_reviewed")).not.toContain(caseReplyHelpLine("fr"));
  });
});
