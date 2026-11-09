import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SavRetrievalCandidate } from "../request-retrieval";
import type { CaseDecisionValidation, CaseDecisionValidationContext } from "./decision-contract";
import { classifyCaseDecisionRefusal } from "./decision-recovery";
import { validateCaseDecision } from "./decision-validator";
import { SAV_CASE_ACCESS_SCOPE_REVISION } from "./investigation-access-scope";

// B (4/11, SYN): the login-code reply says what the AUTHORIZED card version says, and never asks again what the customer already did.
// Synthetic cards only; the current version paraphrases the published one without its id (official link, no spam folder advice),
// the « future » version is the private local amendment (spam folder step added), never published.
const now = new Date("2026-11-04T12:00:00Z");
const CURRENT = { content: "Pour vous connecter, ouvrez new.limova.ai, saisissez l’adresse e-mail de votre inscription puis le code reçu par e-mail.",
  steps: ["Ouvrir new.limova.ai.", "Saisir l’adresse e-mail utilisée à l’inscription.", "Saisir le code reçu par e-mail."] };
const FUTURE = { content: CURRENT.content, steps: [...CURRENT.steps.slice(0, 2), "Si le code n’arrive pas dans votre boîte de réception, vérifiez le dossier « Spams » ou « Courriers indésirables » de cette même adresse.", CURRENT.steps[2]!] };
function login(version: { content: string; steps: string[] }): SavRetrievalCandidate {
  return { id: "k-login", contentVersionId: "k-login-v1", title: "Se connecter par code à usage unique", content: version.content, source: "test",
    verifiedAt: "2026-11-01T00:00:00Z", semanticScore: null, resolution: { steps: version.steps, symptoms: ["Expliquer la connexion à l’espace avec le code reçu par e-mail."] },
    availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } };
}
const scope = { schema: SAV_CASE_ACCESS_SCOPE_REVISION as typeof SAV_CASE_ACCESS_SCOPE_REVISION, policyRevision: "policy-syn", revision: "scope-syn", family: "access" as const,
  sources: [{ knowledgeId: "k-login", contentVersionId: "k-login-v1", use: "answer" as const, firstReply: "login_code_steps" as const }] };
function context(card: SavRetrievalCandidate, customerText: string): CaseDecisionValidationContext {
  return { caseId: "case-1", caseVersion: 3, owner: "agent", admission: { admitted: true }, locale: "fr-FR", audience: "support", sensitiveCategories: [],
    requests: [{ id: "r1", family: "access", status: "open" }], customerTexts: { "email:m1": customerText }, facts: [], questions: [], trials: [],
    knowledge: [card], sources: [{ ref: { type: "email", id: "m1" }, direction: "customer_inbound", at: "2026-11-04T09:00:00Z", order: 1 }], handoffs: [], accessScope: scope };
}
const ref = { knowledgeId: "k-login", contentVersionId: "k-login-v1" };
const proposal = () => ({ caseVersion: 3, understanding: { requests: [{ id: "r1", summary: "Connexion au compte", family: "access", status: "open" }], newFacts: [] },
  nextAction: { kind: "answer", requestIds: ["r1"], steps: [{ text: "Suivre la fiche.", knowledge: ref, newFactIds: [] }], expectedResult: "Le client accède à son espace." },
  reply: { text: "Appliquer la procédure : https://new.limova.ai", citations: [ref], impossibilityClaims: [], accountAdvice: "none" } });
const textOf = (result: CaseDecisionValidation) => {
  expect(result.outcome === "needs_review" ? result.rejections.map(row => row.code) : []).toEqual([]);
  return result.outcome === "accepted" ? result.decision.reply!.text : "";
};
const FIRST = "Bonjour, je n’arrive pas à me connecter à mon compte Limova.";
const A06 = "J’ai déjà essayé le bon lien et la bonne adresse e-mail, mais je ne reçois aucun code de connexion.";
const A08 = `${A06} J’ai aussi déjà vérifié les spams et les courriers indésirables, il n’y a rien.`;

describe("login-code reply: the authorized version speaks, the customer's checks are kept", () => {
  it("current version (official link, no spam step): first reply gives the link and never the spam folder", () => {
    const text = textOf(validateCaseDecision(proposal(), context(login(CURRENT), FIRST), now));
    expect(text).toContain("Voici le lien de connexion : https://new.limova.ai.");
    expect(text).not.toMatch(/spam|indésirable/i);
  });
  it("future SYN version with the spam step: the same first reply adds the spam folder advice", () => {
    const text = textOf(validateCaseDecision(proposal(), context(login(FUTURE), FIRST), now));
    expect(text).toContain("pensez à vérifier le dossier « Spams » ou « Courriers indésirables »");
  });
  it("A06 on the current version: acknowledges link and address, asks only what is displayed, no spam advice", () => {
    const result = validateCaseDecision(proposal(), context(login(CURRENT), A06), now), text = textOf(result);
    expect(text).toContain("Vous avez déjà utilisé le bon lien (https://new.limova.ai) avec votre adresse d’inscription.");
    expect(text).not.toMatch(/spam|indésirable/i);
    expect(result.outcome === "accepted" && result.decision.nextAction.kind).toBe("ask");
  });
  it("A06 on the future version: the spam folder is advised once, before the question", () => {
    const text = textOf(validateCaseDecision(proposal(), context(login(FUTURE), A06), now));
    expect(text).toContain(FUTURE.steps[2]);
  });
  it("A08: spams already checked are acknowledged, never asked again, even when the version advises them", () => {
    for (const version of [CURRENT, FUTURE]) {
      const text = textOf(validateCaseDecision(proposal(), context(login(version), A08), now));
      expect(text).toContain("Vous avez aussi déjà vérifié vos spams et courriers indésirables.");
      expect(text).not.toMatch(/vérifiez le dossier|pensez à vérifier|dans les spams non plus/);
      expect(text).toContain("Quel message s’affiche à l’écran après la saisie de votre adresse e-mail ?");
    }
  });
  it("a doubt about the spam folder is no check: the advice stays", () => {
    const text = textOf(validateCaseDecision(proposal(), context(login(FUTURE), `${A06} Je ne sais pas si j’ai regardé les spams, peut-être pas.`), now));
    expect(text).toContain(FUTURE.steps[2]);
  });
  it("a version without the exact official host (.io, or a longer host) gets no login template, and the .io link is rejected", () => {
    for (const host of ["new.limova.io", "new.limova.ai.example"]) {
      const card = login({ content: CURRENT.content.replace("new.limova.ai", host), steps: CURRENT.steps.map(step => step.replace("new.limova.ai", host)) });
      const result = validateCaseDecision(proposal(), context(card, FIRST), now);
      const text = result.outcome === "accepted" ? result.decision.reply!.text : "";
      expect(text).not.toContain("Voici le lien de connexion");
    }
    const io = login({ content: CURRENT.content.replace("new.limova.ai", "new.limova.io"), steps: CURRENT.steps.map(step => step.replace("new.limova.ai", "new.limova.io")) });
    const result = validateCaseDecision(proposal(), context(io, FIRST), now);
    expect(result.outcome).toBe("needs_review");
    expect(result.outcome === "needs_review" && result.rejections.map(row => row.code)).toContain("access_link_invalid");
  });
  it("no card or version id is written in the validator: the right is the approved scope's, the content the version's", () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "decision-validator.ts"), "utf8");
    expect(source).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});

// Review A09 (B, 4/11, SYN): link, address and spams done and the screen's words told. The procedure does not restart; the card's own relay follows, with no cause invented.
describe("login blockage once the card's checks are done (A09)", () => {
  const A09 = "J’ai déjà essayé le bon lien et la bonne adresse e-mail, mais je ne reçois aucun code. J’ai déjà vérifié les spams. L’écran affiche l’erreur « identifiant introuvable ».";
  const RELAY = "Si le client signale un blocage, demander au besoin le message affiché, puis transmettre à l’équipe.";
  const relayed = (version = CURRENT, escalation: string | undefined = RELAY) => { const card = login(version); return { ...card, resolution: { ...card.resolution, ...(escalation ? { escalation } : {}) } } as SavRetrievalCandidate; };
  const email = (id: string, order: number) => ({ ref: { type: "email" as const, id }, direction: "customer_inbound" as const, at: `2026-11-04T0${order}:00:00Z`, order });
  /** Several mails, oldest first: the case's history as the validator reads it. */
  const thread = (card: SavRetrievalCandidate, mails: string[], over: Partial<CaseDecisionValidationContext> = {}): CaseDecisionValidationContext => ({ ...context(card, mails[0]!),
    customerTexts: Object.fromEntries(mails.map((text, i) => [`email:m${i + 1}`, text])), sources: mails.map((_, i) => email(`m${i + 1}`, i + 1)), ...over });
  const accepted = (result: CaseDecisionValidation) => {
    if (result.outcome !== "accepted") throw Error(`REFUSED:${result.rejections.map(row => row.code).join(",")}`);
    return result;
  };
  const handedOff = (result: CaseDecisionValidation) => {
    const { decision, signals } = accepted(result);
    if (decision.nextAction.kind !== "handoff") throw Error(`NOT_HANDOFF:${decision.nextAction.kind}`);
    return { report: decision.nextAction.report, reason: decision.nextAction.reason, reply: decision.reply, signals };
  };
  const kind = (result: CaseDecisionValidation) => accepted(result).decision.nextAction.kind;
  const askQuestion = (text: string, seekKind = "error_message") => ({ ...proposal(), nextAction: { kind: "ask", questions: [{ requestId: "r1", text, reducesUncertainty: "Préciser.", seeks: [{ kind: seekKind }] }] } });

  it("A09: the redundant procedure is refused, the case follows the card's relay, nothing is said to the customer from it", () => {
    const { report, reason, reply, signals } = handedOff(validateCaseDecision(proposal(), context(relayed(), A09), now));
    expect(reason).toBe("diagnosis_out_of_tools");
    expect(reply).toBeUndefined();
    expect(signals).toContain("login_procedure_refused_routed");
    expect(report.observed).toContain("identifiant introuvable");
    expect(report.need).toContain("bon lien, bonne adresse, spams");
    expect(report.knowledge).toEqual([ref]);
  });
  it("no diagnosis is invented: no hypothesis, no cause, only the customer's words attributed to them", () => {
    const { report } = handedOff(validateCaseDecision(proposal(), context(relayed(), A09), now));
    expect(report.hypotheses).toEqual([]);
    expect(report.missingInformation).toEqual([]);
    expect(report.observed).toMatch(/selon le client/);
    expect(report.expectedIntervention).toContain("aucune cause");
    expect(JSON.stringify(report)).not.toMatch(/n’existe pas|inexistant|supprimé|pas de compte|mauvaise adresse|abonnement/i);
  });
  it("asking again what is known is refused the same way, a question on something else is left alone, the model's own handoff is kept", () => {
    expect(handedOff(validateCaseDecision(askQuestion("Quel message s’affiche à l’écran ? https://new.limova.ai"), context(relayed(), A09), now)).signals).toContain("login_procedure_refused_routed");
    expect(handedOff(validateCaseDecision(askQuestion("Avez-vous regardé les spams ?", "other"), context(relayed(), A09), now)).signals).toContain("login_procedure_refused_routed");
    expect(kind(validateCaseDecision({ ...askQuestion("Quel navigateur utilisez-vous ?", "environment"), reply: { text: "Quel navigateur utilisez-vous ? https://new.limova.ai", citations: [], impossibilityClaims: [], accountAdvice: "none" } }, context(relayed(), A09), now))).toBe("ask");
    const own = { ...proposal(), reply: undefined, nextAction: { kind: "handoff", reason: "explicit_human_request", requestIds: ["r1"], report: { need: "Besoin.", expected: null, observed: null, trialIds: [], hypotheses: [], missingInformation: [], expectedIntervention: "Reprendre.", knowledge: [] } } };
    const kept = handedOff(validateCaseDecision(own, context(relayed(), A09), now));
    expect(kept.reason).toBe("explicit_human_request");
    expect(kept.signals).not.toContain("login_procedure_refused_routed");
  });
  it("a procedure from another card the model picked (orient only here) is routed the same way, the login card stays the report's source", () => {
    const other = { knowledgeId: "k-other", contentVersionId: "k-other-v1" }, base = context(relayed(), A09);
    const answer = { ...proposal(), nextAction: { kind: "answer", requestIds: ["r1"], steps: [{ text: "Suivre l’autre fiche.", knowledge: other, newFactIds: [] }], expectedResult: "Accès." }, reply: { text: "Procédure : https://new.limova.ai", citations: [other], impossibilityClaims: [], accountAdvice: "none" } };
    const { report } = handedOff(validateCaseDecision(answer, { ...base, knowledge: [{ ...relayed(), id: "k-other", contentVersionId: "k-other-v1" }, ...base.knowledge], accessScope: { ...scope, sources: [...scope.sources, { ...other, use: "orient_only" as const }] } }, now));
    expect(report.knowledge).toEqual([ref]);
  });
  it("a version that states no relay: refused with its own code, correctable, never a relay the card does not say", () => {
    const result = validateCaseDecision(proposal(), context(relayed(CURRENT, "Lire le message disponible."), A09), now);
    expect(result.outcome).toBe("needs_review");
    expect(result.outcome === "needs_review" && result.rejections.map(row => row.code)).toEqual(["login_procedure_redundant"]);
    expect(classifyCaseDecisionRefusal(result.outcome === "needs_review" ? result.rejections : [])?.correctable).toBe(true);
  });
  it("several open requests: the other one is not handed off behind the customer's back, refused for correction", () => {
    const result = validateCaseDecision({ ...proposal(), understanding: { requests: [{ id: "r1", summary: "Connexion", family: "access", status: "open" }, { id: "r2", summary: "Espace", family: "access", status: "open" }], newFacts: [] } },
      { ...context(relayed(), A09), requests: [{ id: "r1", family: "access", status: "open" }, { id: "r2", family: "access", status: "open" }] }, now);
    expect(result.outcome === "needs_review" && result.rejections.map(row => row.code)).toContain("login_procedure_redundant");
  });
  it("outside the pilot scope nothing is routed: no scope, no reading of the card's relay", () => {
    expect(kind(validateCaseDecision(proposal(), { ...context(relayed(), A09), accessScope: undefined }, now))).toBe("answer");
  });

  describe("history: what was said in earlier mails counts", () => {
    const ASKED = { questions: [{ id: "q1", factKeys: ["login_error_message"], askedAt: "2026-11-04T01:30:00Z", answeredBy: null }] };
    it("the checks in the first mail, the screen's words in the answer to our question", () => {
      const { report } = handedOff(validateCaseDecision(proposal(), thread(relayed(), [A08, "L’écran affiche « identifiant introuvable »."], ASKED), now));
      expect(report.observed).toContain("identifiant introuvable");
      expect(report.need).toContain("spams");
    });
    it("our one question got no wording: asked once, not twice, the card's next step is the relay", () => {
      const { report } = handedOff(validateCaseDecision(askQuestion("Quel message s’affiche ?"), thread(relayed(), [A08, "Je ne vois pas, désolé."], ASKED), now));
      expect(report.observed).toContain("n’a pas précisé");
    });
    it("a bare reminder after the full account changes nothing", () => {
      expect(handedOff(validateCaseDecision(proposal(), thread(relayed(), [A09, "Toujours pas de code."]), now)).signals).toContain("login_procedure_refused_routed");
    });
    it("a mail on another subject, with no question of ours pending, stops the reading", () => {
      expect(kind(validateCaseDecision(proposal(), thread(relayed(), [A09, "Comment ajouter un agent à mon équipe ?"]), now))).toBe("answer");
    });
    it("a person who wrote after the last mail keeps the lead: no routing on older words", () => {
      const base = thread(relayed(), [A09]);
      expect(kind(validateCaseDecision(proposal(), { ...base, sources: [...base.sources, { ref: { type: "email", id: "h1" }, direction: "human_outbound", at: "2026-11-04T05:00:00Z", order: 5 }] }, now))).toBe("answer");
    });
    it("an unreadable mail in the thread proves nothing", () => {
      const base = thread(relayed(), [A09, "Toujours pas de code."]);
      expect(kind(validateCaseDecision(proposal(), { ...base, customerTexts: { "email:m1": A09 } }, now))).toBe("answer");
    });
  });

  describe("contradiction: a corrected or doubtful statement is never a check done", () => {
    it.each([
      ["a later correction of the address", [A09, "En fait je me suis trompé d’adresse."]],
      ["a doubt on the address in the same mail", [`${A09} Je ne suis pas sûr de l’adresse.`]],
      ["the code came after all and is refused", [A09, "J’ai bien reçu le code mais il est refusé."]],
      ["the connection works now", [A09, "C’est bon, ça marche."]],
    ])("%s: not relayed", (_name, mails) => {
      expect(kind(validateCaseDecision(proposal(), thread(relayed(), mails), now))).not.toBe("handoff");
    });
    it("a later mail correcting the spam check, on a version that advises it, brings the advice back", () => {
      const result = validateCaseDecision(proposal(), thread(relayed(FUTURE), [A09, "Je n’ai pas vérifié les spams finalement, le code est toujours absent."]), now);
      expect(kind(result)).not.toBe("handoff");
    });
    it("words and « no message » in the same mail: what the screen says is still unknown, so it is asked", () => {
      const text = textOf(validateCaseDecision(proposal(), context(relayed(), `${A08} L’écran affiche « identifiant introuvable ». Aucun message ne s’affiche.`), now));
      expect(text).toContain("Quel message s’affiche");
    });
  });

  describe("nominal: what was useful stays", () => {
    it("a plain first mail still gets the procedure, with the invitation to say what is displayed", () => {
      const text = textOf(validateCaseDecision(proposal(), context(relayed(), FIRST), now));
      expect(text).toContain("Voici le lien de connexion");
      expect(text).toContain("à quelle étape et ce qui s’affiche à l’écran");
    });
    it("the screen's words without any check told: the procedure, never asking what is displayed again", () => {
      const text = textOf(validateCaseDecision(proposal(), context(relayed(), "Bonjour, je n’arrive pas à me connecter. L’écran affiche l’erreur « identifiant introuvable »."), now));
      expect(text).toContain("Voici le lien de connexion");
      expect(text).toContain("à quelle étape.");
      expect(text).not.toContain("ce qui s’affiche");
    });
    it("A06 and A08 still ask the one question; « an error » with no words is no answer to it", () => {
      for (const mail of [A06, A08, `${A08} J’ai une erreur.`]) expect(textOf(validateCaseDecision(proposal(), context(relayed(), mail), now))).toContain("Quel message s’affiche");
    });
    it("the customer says nothing is displayed: answered, relayed", () => {
      expect(handedOff(validateCaseDecision(proposal(), context(relayed(), `${A08} Aucun message ne s’affiche.`), now)).report.observed).toContain("aucun message");
    });
    it("spams unchecked: on the current version (no such step) relayed, on a version that advises them only that step is left", () => {
      const noSpam = A09.replace(" J’ai déjà vérifié les spams.", "");
      expect(handedOff(validateCaseDecision(proposal(), context(relayed(), noSpam), now)).report.need).not.toContain("spams");
      const text = textOf(validateCaseDecision(proposal(), context(relayed(FUTURE), noSpam), now));
      expect(text).toContain(FUTURE.steps[2]);
      expect(text).toContain("Le code se trouve-t-il dans ce dossier ?");
      expect(text).not.toContain("Quel message s’affiche");
      expect(handedOff(validateCaseDecision(proposal(), context(relayed(FUTURE), A09), now)).report.need).toContain("spams");
    });
    it("what looks like a code is never copied into the report", () => {
      const { report } = handedOff(validateCaseDecision(proposal(), context(relayed(), A09.replace("identifiant introuvable", "code 482913 refusé")), now));
      expect(JSON.stringify(report)).not.toContain("482913");
    });
  });

  // 5/11 (SYN): every exchange counts. What the customer confirmed (their own words, latest first) and what we advised (the case's trials and questions) are two ledgers;
  // the short reminder, the reply after our own send, the correction, the quotation and the change of subject are read on them, whatever the model proposes.
  describe("exchanges: confirmed by the customer, advised by us", () => {
    const FIXED = "Bonjour, ouvrez https://new.limova.ai et saisissez votre adresse e-mail d’inscription, puis le code.";
    const restart = () => ({ ...proposal(), reply: { ...proposal().reply, text: FIXED } });
    /** Our first reply really left: the procedure of this exact version is a pending trial, the mail is an agent outbound, the customer answered after it. */
    const afterOurProcedure = (card: SavRetrievalCandidate, mails: string[], over: Partial<CaseDecisionValidationContext> = {}) => {
      const base = thread(card, mails, over);
      return { ...base, sources: [base.sources[0]!, { ref: { type: "email" as const, id: "out1" }, direction: "agent_outbound" as const, at: "2026-11-04T01:30:00Z", order: 90 }, ...base.sources.slice(1).map((row, i) => ({ ...row, order: 100 + i }))],
        trials: [{ id: "t1", requestId: "r1", knowledge: ref, askedAt: "2026-11-04T01:30:00Z", outcome: "pending" as const, resultAt: null }], ...over };
    };
    const asked = (factKeys: string[], at = "2026-11-04T01:30:00Z") => ({ questions: [{ id: "q1", factKeys, askedAt: at, answeredBy: null }] });
    const repeats = (text: string) => /\b(?:ouvrez|voici le lien|saisissez votre adresse|renseignez l.adresse|entrez l.adresse)\b/i.test(text.replace(/saisissez-le uniquement/g, ""));
    const SUPPORT = relayed(FUTURE);

    it.each([["procedure", proposal], ["model that starts over", restart]])("short reminder after the account in an earlier mail (%s): the history stays, nothing is asked again", (_name, model) => {
      const result = validateCaseDecision(model(), thread(SUPPORT, [A06, "Toujours rien."]), now), text = textOf(result);
      expect(kind(result)).toBe("ask");
      expect(text).toContain("Vous avez déjà utilisé le bon lien (https://new.limova.ai) avec votre adresse d’inscription.");
      expect(text).toContain(FUTURE.steps[2]);
      expect(repeats(text)).toBe(false);
      expect(text).toContain("Merci pour votre retour.");
    });
    it("« Toujours rien. » confirms nothing: the spam check we advised is never said to be done, and is asked once", () => {
      const text = textOf(validateCaseDecision(proposal(), afterOurProcedure(SUPPORT, [A06, "Toujours rien."]), now));
      expect(text).not.toContain("déjà vérifié vos spams");
      expect(text).toContain("Avez-vous pu regarder dans le dossier « Spams »");
      expect(text).not.toContain(FUTURE.steps[2]);
    });
    it("nothing confirmed at all, procedure sent, reminder: the steps are not given again, the customer is asked what they did", () => {
      const result = validateCaseDecision(restart(), afterOurProcedure(SUPPORT, [FIRST, "Toujours rien."]), now), text = textOf(result);
      expect(text).not.toContain("Vous avez déjà");
      expect(text).toContain("Pouvez-vous me confirmer que vous avez bien utilisé https://new.limova.ai avec l’adresse e-mail de votre inscription ?");
      expect(repeats(text)).toBe(false);
      expect(result.outcome === "accepted" && result.decision.nextAction.kind === "ask" && result.decision.nextAction.questions[0]!.seeks.map(seek => seek.factKey)).toEqual(["login_path_checked", "login_spam_checked", "login_error_message"]);
    });
    it.each([["procedure", proposal], ["model that starts over", restart]])("after our own reply, the customer confirms link and address (%s): acknowledged, not restarted", (_name, model) => {
      const text = textOf(validateCaseDecision(model(), afterOurProcedure(SUPPORT, [FIRST, A06]), now));
      expect(text).toContain("Vous avez déjà utilisé le bon lien");
      expect(text).toContain("Avez-vous pu regarder dans le dossier « Spams »");
      expect(repeats(text)).toBe(false);
    });
    it("what we already asked is not asked a third time: a reminder after our question follows the card's relay, and says what stays unconfirmed", () => {
      const { report } = handedOff(validateCaseDecision(proposal(), thread(SUPPORT, [A06, "Toujours rien."], asked(["login_spam_checked", "login_error_message"])), now));
      expect(report.need).toContain("Déjà fait selon le client : bon lien, bonne adresse.");
      expect(report.need).toContain("Conseillé sans confirmation du client : spams.");
      expect(report.observed).toContain("n’a pas précisé");
    });
    it("a model question that only re-asks a confirmed check is treated as a restart, whatever its declared kind", () => {
      const reAsk = { ...askQuestion("Quel navigateur utilisez-vous ?", "environment"), reply: { text: "Avez-vous bien utilisé le bon lien ? Vérifiez votre adresse d’inscription. https://new.limova.ai", citations: [ref], impossibilityClaims: [], accountAdvice: "none" } };
      const text = textOf(validateCaseDecision(reAsk, thread(SUPPORT, [A06, "Toujours rien."]), now));
      expect(text).toContain("Vous avez déjà utilisé le bon lien");
      expect(text).not.toContain("Vérifiez votre adresse");
    });
    it("the confirmed checks are recorded as the customer's statements, sourced on their own mail", () => {
      const result = validateCaseDecision(proposal(), thread(SUPPORT, [A06, "Toujours rien."]), now);
      expect(result.outcome === "accepted" && result.decision.understanding.newFacts.map(fact => [fact.key, fact.kind, fact.source.id])).toEqual([["login_link_confirmed", "customer_statement", "m1"], ["login_address_confirmed", "customer_statement", "m1"]]);
    });

    describe("corrections", () => {
      const LINK_ONLY = "Vous avez déjà utilisé le bon lien (https://new.limova.ai).", BOTH = "avec votre adresse d’inscription.";
      const addressFact = (result: CaseDecisionValidation) => result.outcome === "accepted" && result.decision.understanding.newFacts.some(fact => fact.key === "login_address_confirmed");
      it.each([
        ["someone else's address", ["J’ai utilisé le bon lien avec l’adresse d’inscription de mon collègue. Je n’ai reçu aucun code."]],
        ["the same, said another way", ["J’ai utilisé le bon lien et l’adresse e-mail, celle de ma collègue. Je n’ai reçu aucun code."]],
        ["a denial in the sentence", ["J’ai utilisé le bon lien mais pas mon adresse d’inscription. Je n’ai reçu aucun code."]],
        ["a later withdrawal", [A06, "En fait ce n’était pas mon adresse d’inscription. Toujours aucun code."]],
      ])("%s: the address is never recorded nor acknowledged as confirmed, its step is given, the link stands", (_name, mails) => {
        const result = validateCaseDecision(proposal(), thread(SUPPORT, mails), now), text = textOf(result);
        expect(addressFact(result)).toBe(false);
        expect(text).toContain(LINK_ONLY);
        expect(text).not.toContain(BOTH);
        expect(text).toContain(FUTURE.steps[1]);
      });
      it.each([
        ["no code on it", "J’ai utilisé le bon lien et mon adresse d’inscription. Je n’ai pas reçu de code sur mon adresse."],
        ["the address of their account", "J’ai utilisé le bon lien et l’adresse d’inscription de mon compte. Je n’ai reçu aucun code."],
      ])("not a withdrawal: %s", (_name, mail) => {
        const result = validateCaseDecision(proposal(), thread(SUPPORT, [mail]), now);
        expect(addressFact(result)).toBe(true);
        expect(textOf(result)).toContain(BOTH);
      });
      it("confirmed again after a withdrawal: the latest word wins", () => {
        const result = validateCaseDecision(proposal(), thread(SUPPORT, ["J’ai utilisé le bon lien mais pas mon adresse d’inscription.", "J’ai utilisé le bon lien et la bonne adresse e-mail, toujours aucun code."]), now);
        expect(addressFact(result)).toBe(true);
      });
      it("a corrected address comes back as the one step to do, the link stays acknowledged", () => {
        const text = textOf(validateCaseDecision(proposal(), thread(SUPPORT, [A06, "En fait je me suis trompé d’adresse."]), now));
        expect(text).toContain("Vous avez déjà utilisé le bon lien (https://new.limova.ai).");
        expect(text).toContain(FUTURE.steps[1]);
        expect(text).not.toContain("avec votre adresse d’inscription.");
      });
      it("the same correction after our own reply: told again, even though it was advised", () => {
        expect(textOf(validateCaseDecision(proposal(), afterOurProcedure(SUPPORT, [A06, "En fait je me suis trompé d’adresse."]), now))).toContain(FUTURE.steps[1]);
      });
      it("a spam check withdrawn later is not acknowledged", () => {
        const text = textOf(validateCaseDecision(proposal(), thread(SUPPORT, [A08, "Je n’ai pas vérifié les spams finalement."]), now));
        expect(text).not.toContain("déjà vérifié vos spams");
        expect(text).toContain(FUTURE.steps[2]);
      });
    });
    describe("quotations", () => {
      it("our own words quoted back, by `>` or after a reply header, confirm nothing", () => {
        for (const mail of ["Toujours rien.\n> Vous avez déjà utilisé le bon lien. J’ai déjà essayé le bon lien et la bonne adresse. J’ai déjà vérifié les spams.",
          "Toujours rien.\n\nLe 4 nov. 2026, Limova a écrit :\nJ’ai déjà essayé le bon lien et la bonne adresse e-mail. J’ai déjà vérifié les spams."]) {
          const text = textOf(validateCaseDecision(proposal(), afterOurProcedure(SUPPORT, [FIRST, mail]), now));
          expect(text).not.toContain("Vous avez déjà");
        }
      });
      it("an inline quotation is not a statement either", () => {
        const text = textOf(validateCaseDecision(proposal(), afterOurProcedure(SUPPORT, [FIRST, "Vous me dites « j’ai déjà vérifié les spams » mais ce n’est pas moi, toujours aucun code."]), now));
        expect(text).not.toContain("déjà vérifié vos spams");
      });
    });
    describe("change of subject", () => {
      it("the latest mail is about connecting another service: the login's history is not carried over", () => {
        expect(kind(validateCaseDecision(proposal(), thread(SUPPORT, [A09, "Je suis toujours bloqué pour connecter Gmail à mon agent."]), now))).toBe("answer");
      });
      it("a reminder after another subject speaks of that subject: nothing is carried over", () => {
        expect(kind(validateCaseDecision(proposal(), thread(SUPPORT, [A09, "Comment ajouter un agent à mon équipe ?", "Toujours rien."]), now))).toBe("answer");
      });
      it("back on the login after another subject: the older checks still stand", () => {
        const text = textOf(validateCaseDecision(proposal(), thread(SUPPORT, [A06, "Comment ajouter un agent à mon équipe ?", "Toujours aucun code de connexion."]), now));
        expect(text).toContain("Vous avez déjà utilisé le bon lien");
      });
      it("a problem that was solved ends its scope: what we advised for it does not count for the new one", () => {
        const base = thread(SUPPORT, [A08, "C’est bon, ça marche.", "Je n’arrive de nouveau plus à me connecter."], asked(["login_spam_checked", "login_error_message"]));
        const text = textOf(validateCaseDecision(proposal(), base, now));
        expect(text).not.toContain("Vous avez déjà");
        expect(text).toContain(FUTURE.steps[1]);
        expect(text).toContain(FUTURE.steps[2]);
      });
      it("« ça ne marche pas » is not « ça marche »", () => {
        expect(textOf(validateCaseDecision(proposal(), thread(SUPPORT, [A06, "Ça ne marche toujours pas."]), now))).toContain("Vous avez déjà utilisé le bon lien");
      });
      it("a mail that does not concern this card is never answered with it, on a second subject of the same family", () => {
        const invite = { knowledgeId: "k-invite", contentVersionId: "k-invite-v1" };
        const other = { ...relayed(), id: "k-invite", contentVersionId: "k-invite-v1", title: "Accepter une invitation", content: "Ouvrez l’email d’invitation.", resolution: { steps: ["Ouvrez l’email d’invitation reçu.", "Cliquez sur le bouton de l’invitation."] } };
        const base = thread(SUPPORT, ["Je n’ai pas reçu le lien d’invitation à mon espace."], { knowledge: [SUPPORT, other], accessScope: { ...scope, sources: [...scope.sources, { ...invite, use: "answer" as const }] } });
        const answer = { ...proposal(), nextAction: { kind: "answer", requestIds: ["r1"], steps: [{ text: "Demander l’invitation.", knowledge: invite, newFactIds: [] }], expectedResult: "Invitation." }, reply: { text: "Demandez à votre administrateur de renvoyer l’invitation. https://new.limova.ai", citations: [invite], impossibilityClaims: [], accountAdvice: "none" } };
        expect(textOf(validateCaseDecision(answer, base, now))).toContain("renvoyer l’invitation");
      });
    });
    describe("the version speaks", () => {
      it("the advice is the version's own sentence: another wording in another version changes the reply", () => {
        const own = "Regardez aussi vos courriers indésirables sur cette boîte.";
        expect(textOf(validateCaseDecision(proposal(), thread(relayed({ content: CURRENT.content, steps: [...CURRENT.steps, own] }), [A06, "Toujours rien."]), now))).toContain(own);
      });
      it("a sent version that did not advise the spam folder does not count as advised on the new one", () => {
        const base = afterOurProcedure(SUPPORT, [A06, "Toujours rien."]);
        const text = textOf(validateCaseDecision(proposal(), { ...base, trials: [{ ...base.trials[0]!, knowledge: { ...ref, contentVersionId: "k-login-v0" } }] }, now));
        expect(text).toContain(FUTURE.steps[2]);
      });
      it("no version, no spam step, no spam sentence; a version without the official host gets no composed reply", () => {
        expect(textOf(validateCaseDecision(proposal(), thread(relayed(), [A06, "Toujours rien."]), now))).not.toMatch(/spam|indésirable/i);
        const io = relayed({ content: CURRENT.content.replace("new.limova.ai", "new.limova.io"), steps: CURRENT.steps.map(step => step.replace("new.limova.ai", "new.limova.io")) });
        const result = validateCaseDecision(proposal(), thread(io, [A06, "Toujours rien."]), now);
        expect(result.outcome).toBe("needs_review");
        expect(JSON.stringify(result)).not.toContain("limova.io");
      });
    });
  });

  // Any card, not only the login's: the second subject (SYN) goes through the same two ledgers, and the pilot's admission is not widened.
  describe("second subject (SYN), through the same scope", () => {
    const invite = { knowledgeId: "k-invite", contentVersionId: "k-invite-v1" };
    const inviteCard = { ...relayed(), id: "k-invite", contentVersionId: "k-invite-v1", title: "Accepter une invitation", content: "Procédure d’invitation.",
      resolution: { steps: ["Ouvrez l’email d’invitation reçu sur l’adresse invitée.", "Cliquez sur le bouton de l’invitation dans cet email.", "Créez votre compte sur new.limova.ai avec cette même adresse invitée."] } } as SavRetrievalCandidate;
    const OPEN = "Je n’ai pas accès à l’espace de mon équipe, on m’a invité.";
    const syn = (mails: string[], over: Partial<CaseDecisionValidationContext> = {}) => thread(inviteCard, mails, { knowledge: [inviteCard], accessScope: { ...scope, sources: [{ ...invite, use: "answer" as const, firstReply: "procedure_steps" as const }] }, ...over });
    const reply = (text: string) => ({ ...proposal(), nextAction: { kind: "answer", requestIds: ["r1"], steps: [{ text: "Suivre.", knowledge: invite, newFactIds: [] }], expectedResult: "Accès." }, reply: { text, citations: [invite], impossibilityClaims: [], accountAdvice: "none" } });
    const askInvite = (text: string) => ({ ...proposal(), nextAction: { kind: "ask", questions: [{ requestId: "r1", text, reducesUncertainty: "Préciser.", seeks: [{ kind: "environment" }] }] }, reply: { text: `${text} https://new.limova.ai`, citations: [invite], impossibilityClaims: [], accountAdvice: "none" } });
    const sent = { trials: [{ id: "t1", requestId: "r1", knowledge: invite, askedAt: "2026-11-04T01:30:00Z", outcome: "pending" as const, resultAt: null }] };
    const RESTART = "Ouvrez l’email d’invitation reçu sur l’adresse invitée. Cliquez sur le bouton de l’invitation dans cet email. https://new.limova.ai";
    const codes = (result: CaseDecisionValidation) => result.outcome === "needs_review" ? result.rejections.map(row => row.code) : [];

    it("the card's own steps are sent once, verbatim, as a first reply", () => {
      expect(textOf(validateCaseDecision(reply("Procédure. https://new.limova.ai"), { ...syn([OPEN]) }, now))).toContain("Cliquez sur le bouton de l’invitation dans cet email.");
    });
    it("sent, then « Toujours rien. »: the same steps are refused for correction, and the login template never fires", () => {
      const result = validateCaseDecision(reply(RESTART), syn([OPEN, "Toujours rien."], sent), now);
      expect(codes(result)).toContain("procedure_step_repeated");
      expect(classifyCaseDecisionRefusal(result.outcome === "needs_review" ? result.rejections : [])?.correctable).toBe(true);
    });
    it("a step the customer states they did is refused, even with no reply of ours yet; the question that moves on is accepted", () => {
      const said = "J’ai déjà ouvert l’email d’invitation reçu sur l’adresse invitée, rien ne se passe.";
      expect(codes(validateCaseDecision(reply("Ouvrez l’email d’invitation reçu sur l’adresse invitée. https://new.limova.ai"), syn([OPEN, said]), now))).toContain("procedure_step_repeated");
      expect(kind(validateCaseDecision(askInvite("Que se passe-t-il quand vous cliquez sur le bouton ?"), syn([OPEN, said]), now))).toBe("ask");
    });
    it("a doubt or a correction is no done step; a thanks after the steps is not a repeat", () => {
      expect(codes(validateCaseDecision(reply("Ouvrez l’email d’invitation reçu sur l’adresse invitée. https://new.limova.ai"), syn([OPEN, "Je ne sais pas si j’ai ouvert l’email d’invitation reçu sur l’adresse invitée."]), now))).not.toContain("procedure_step_repeated");
      expect(codes(validateCaseDecision(reply("Vous avez ouvert l’email d’invitation reçu sur l’adresse invitée, merci. https://new.limova.ai"), syn([OPEN, "J’ai déjà ouvert l’email d’invitation reçu sur l’adresse invitée."]), now))).not.toContain("procedure_step_repeated");
    });
    it("a family outside the pilot stays refused: nothing here admits another subject", () => {
      const out = { ...reply("Procédure. https://new.limova.ai"), understanding: { requests: [{ id: "r1", summary: "Intégration", family: "integration", status: "open" }], newFacts: [] } };
      expect(codes(validateCaseDecision(out, syn([OPEN]), now))).toContain("pilot_family_out_of_scope");
    });
  });
});

// Q3 (9/11, Ugo's acceptance): a persistent access problem reads the history, asks the spam folder only if never asked nor answered, asks the exact text displayed
// or a screenshot only if absent, then relays with the context. No loop, no repeated procedure, no closure on a thanks, no claim to read an image.
describe("Q3 — accès persistant : historique, spams, capture, puis relais", () => {
  const RELAY = "Si le client signale un blocage, demander au besoin le message affiché, puis transmettre à l’équipe.";
  const relayed = (version = CURRENT, escalation: string | undefined = RELAY) => { const card = login(version); return { ...card, resolution: { ...card.resolution, ...(escalation ? { escalation } : {}) } } as SavRetrievalCandidate; };
  const email = (id: string, order: number) => ({ ref: { type: "email" as const, id }, direction: "customer_inbound" as const, at: `2026-11-04T0${order}:00:00Z`, order });
  const thread = (card: SavRetrievalCandidate, mails: string[], over: Partial<CaseDecisionValidationContext> = {}): CaseDecisionValidationContext => ({ ...context(card, mails[0]!),
    customerTexts: Object.fromEntries(mails.map((text, i) => [`email:m${i + 1}`, text])), sources: mails.map((_, i) => email(`m${i + 1}`, i + 1)), ...over });
  const accepted = (result: CaseDecisionValidation) => {
    if (result.outcome !== "accepted") throw Error(`REFUSED:${result.rejections.map(row => row.code).join(",")}`);
    return result.decision;
  };
  const asked = (factKeys: string[]) => ({ questions: [{ id: "q1", factKeys, askedAt: "2026-11-04T01:30:00Z", answeredBy: null }] });
  const CAPTURE = "Voici une capture d’écran en pièce jointe.";
  const SCREEN_HOW = "Vous pouvez recopier le texte exact ou joindre une capture d’écran.";
  const restates = (text: string) => /\b(?:ouvrez|voici le lien|saisissez votre adresse|vérifiez le dossier|pensez à vérifier)\b/i.test(text.replace(/saisissez-le uniquement/g, ""));

  it("bon lien et adresse confirmés, spams jamais demandés : la vérification des spams, puis le texte exact ou une capture", () => {
    const decision = accepted(validateCaseDecision(proposal(), context(relayed(FUTURE), A06), now));
    expect(decision.nextAction.kind).toBe("ask");
    expect(decision.reply!.text).toContain(FUTURE.steps[2]);
    expect(decision.reply!.text).toContain(SCREEN_HOW);
  });
  it("spams déjà demandés, sans réponse : la question des spams n'est pas reposée", () => {
    const decision = accepted(validateCaseDecision(proposal(), thread(relayed(FUTURE), [A06, "Toujours rien."], asked(["login_spam_checked"])), now));
    expect(decision.nextAction.kind).toBe("ask");
    expect(decision.reply!.text).not.toMatch(/spams|indésirables/i);
    expect(decision.reply!.text).toContain(SCREEN_HOW);
  });
  it("spams vérifiés et code absent : le texte exact ou une capture, sans répéter lien, adresse ni spams", () => {
    const decision = accepted(validateCaseDecision(proposal(), context(relayed(FUTURE), A08), now));
    expect(decision.reply!.text).toContain("Quel message s’affiche à l’écran après la saisie de votre adresse e-mail ?");
    expect(decision.reply!.text).toContain(SCREEN_HOW);
    expect(restates(decision.reply!.text)).toBe(false);
  });
  it.each([
    ["dans le même mail", [`${A08} ${CAPTURE}`], {}],
    ["en réponse à notre question", [A08, "Ci-joint la capture d’écran."], asked(["login_error_message"])],
    ["signée", [A08, "Je vous joins une capture.\n\nCordialement,\nJean Dupont\n06 12 34 56 78"], asked(["login_error_message"])],
  ])("capture jointe %s : rien n'est redemandé, relais avec les faits et la limite de lecture", (_name, mails, over) => {
    const decision = accepted(validateCaseDecision(proposal(), thread(relayed(), mails as string[], over), now));
    if (decision.nextAction.kind !== "handoff") throw Error(`NOT_HANDOFF:${decision.nextAction.kind}`);
    expect(decision.reply).toBeUndefined();
    expect(decision.nextAction.reason).toBe("diagnosis_out_of_tools");
    expect(decision.nextAction.report.observed).toContain("capture d’écran");
    expect(decision.nextAction.report.observed).toContain("L’agent ne lit pas les images");
    expect(decision.nextAction.report.need).toContain("bon lien, bonne adresse, spams");
    expect(decision.nextAction.report.hypotheses).toEqual([]);
  });
  it("capture jointe et le modèle redemande une capture : traité comme une répétition, relais", () => {
    const again = { ...proposal(), nextAction: { kind: "ask", questions: [{ requestId: "r1", text: "Pouvez-vous m’envoyer une capture de l’écran ?", reducesUncertainty: "Voir.", seeks: [{ kind: "screenshot" }] }] },
      reply: { text: "Pouvez-vous m’envoyer une capture de l’écran ?", citations: [], impossibilityClaims: [], accountAdvice: "none" } };
    expect(accepted(validateCaseDecision(again, context(relayed(), `${A08} ${CAPTURE}`), now)).nextAction.kind).toBe("handoff");
  });
  it("capture jointe sur une fiche sans relais : refus corrigible, jamais une nouvelle question", () => {
    const result = validateCaseDecision(proposal(), context(relayed(CURRENT, "Lire le message disponible."), `${A08} ${CAPTURE}`), now);
    expect(result.outcome).toBe("needs_review");
    expect(result.outcome === "needs_review" && result.rejections.map(row => row.code)).toContain("login_procedure_redundant");
  });
  it("« je n'ai pas de capture » n'est pas une capture : on demande le texte affiché", () => {
    const decision = accepted(validateCaseDecision(proposal(), context(relayed(), `${A08} Je n’ai pas de capture d’écran.`), now));
    expect(decision.nextAction.kind).toBe("ask");
    expect(decision.reply!.text).toContain("Quel message s’affiche");
  });
  it("premier mail avec une capture annoncée : la procédure, sans demander ce qui s'affiche", () => {
    const text = accepted(validateCaseDecision(proposal(), context(relayed(), `${FIRST} ${CAPTURE}`), now)).reply!.text;
    expect(text).toContain("Voici le lien de connexion");
    expect(text).not.toContain("ce qui s’affiche");
  });
  it("historique signé : la signature (nom, téléphone) ne fausse ni les vérifications ni le rappel", () => {
    const signed = (text: string) => `${text}\n\nCordialement,\nJean Dupont\n06 12 34 56 78`;
    const decision = accepted(validateCaseDecision(proposal(), thread(relayed(), [signed(A09_TEXT), signed("Toujours pas de code.")]), now));
    expect(decision.nextAction.kind).toBe("handoff");
  });
  // Contre-recette lot 3 (p5 v2, Q3-1/4/5/6): the official domain written in the customer's sentence must not hide the address confirmed in it.
  describe("le domaine écrit par le client ne fait pas perdre l'adresse confirmée", () => {
    const WITH_HOST = "Bonjour, j’ai déjà essayé le bon lien new.limova.ai et la bonne adresse e-mail, mais je ne reçois aucun code de connexion. J’ai aussi déjà vérifié les spams et les courriers indésirables, il n’y a rien.";
    const noStepAgain = (text: string) => expect(text).not.toMatch(/Saisir l’adresse|Entrez l’adresse|Pouvez-vous me confirmer/);
    it("spams jamais demandés : lien et adresse reconnus, l'étape adresse n'est pas redonnée", () => {
      const host = WITH_HOST.replace(" J’ai aussi déjà vérifié les spams et les courriers indésirables, il n’y a rien.", "");
      const text = accepted(validateCaseDecision(proposal(), context(relayed(FUTURE), host), now)).reply!.text;
      expect(text).toContain("avec votre adresse d’inscription");
      noStepAgain(text);
    });
    it.each([
      ["texte de l'écran fourni", [`${WITH_HOST} L’écran affiche « adresse e-mail inconnue ».`], {}],
      ["capture jointe", [`${WITH_HOST} Je vous joins une capture d’écran.`], {}],
      ["question d'écran déjà posée, réponse vide", [WITH_HOST, "Je ne sais pas."], asked(["login_error_message"])],
    ])("%s : relais, rien de redemandé", (_name, mails, over) => {
      const decision = accepted(validateCaseDecision(proposal(), thread(relayed(FUTURE), mails as string[], over), now));
      expect(decision.nextAction.kind).toBe("handoff");
      expect(decision.reply).toBeUndefined();
      expect(decision.nextAction.kind === "handoff" && decision.nextAction.report.need).toContain("bon lien, bonne adresse, spams");
    });
  });
  it("une phrase écrite après le séparateur de signature reste lue dans l'historique (Q1) : le message affiché qu'elle donne n'est pas redemandé", () => {
    const decision = accepted(validateCaseDecision(proposal(), thread(relayed(), [`${A08}\n--\nJean Dupont\nL’écran affiche « identifiant introuvable ».`, "Toujours pas de code."]), now));
    if (decision.nextAction.kind !== "handoff") throw Error(`NOT_HANDOFF:${decision.nextAction.kind}`);
    expect(decision.nextAction.report.observed).toContain("identifiant introuvable");
  });
  it("un ancien « ça marche » signé termine l'ancien problème : ses vérifications ne comptent plus", () => {
    const decision = accepted(validateCaseDecision(proposal(), thread(relayed(), [A09_TEXT, "Ça marche, merci !\n\nJean Dupont", FIRST]), now));
    expect(decision.nextAction.kind).not.toBe("handoff");
  });

  const resolution = (quote: string) => ({ caseVersion: 3, understanding: proposal().understanding,
    nextAction: { kind: "confirm_resolution", requestIds: ["r1"], evidence: [{ requestId: "r1", source: { type: "email", id: "m2" }, trialId: "t1", quote }] } });
  const afterTrial = (reply: string): CaseDecisionValidationContext => ({ ...thread(relayed(), [FIRST, reply]),
    trials: [{ id: "t1", requestId: "r1", knowledge: ref, askedAt: "2026-11-04T01:30:00Z", outcome: "pending" as const, resultAt: null }] });
  it.each([
    ["merci seul", "Merci beaucoup !", "Merci beaucoup"],
    ["merci signé", "Merci !\n\nJean Dupont\n06 12 34 56 78", "Merci"],
    ["ça marche + fonction + demande cachée", "Ça marche, merci !\n\nJean Dupont\nDeux sommes prises en octobre", "Ça marche"],
    ["ça marche + nom + résiliation paraphrasée", "Ça marche.\n\nJean\nFermez tout au 30", "Ça marche"],
  ])("%s : aucune preuve de résolution", (_name, reply, quote) => {
    const result = validateCaseDecision(resolution(quote), afterTrial(reply), now);
    expect(result.outcome).toBe("needs_review");
    expect(result.outcome === "needs_review" && result.rejections.map(row => row.detail)).toContain("latest_customer_login_not_confirmed");
  });
  it("« ça marche » avec une signature standard reste une preuve recevable", () => {
    const result = validateCaseDecision(resolution("Ça marche, merci"), afterTrial("Ça marche, merci !\n\nBien cordialement,\nJean Dupont\njean.dupont@exemple.test"), now);
    expect(result.outcome === "needs_review" ? result.rejections.map(row => row.detail) : []).not.toContain("latest_customer_login_not_confirmed");
  });
});
const A09_TEXT = "J’ai déjà essayé le bon lien et la bonne adresse e-mail, mais je ne reçois aucun code. J’ai déjà vérifié les spams. L’écran affiche l’erreur « identifiant introuvable ».";
