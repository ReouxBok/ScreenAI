import { describe, expect, it } from "vitest";
import type { SavRetrievalBackend, SavRetrievalCandidate } from "../../request-retrieval";
import { caseReplyHelpLine, prepareCaseReplyText } from "../case-reply-outbound";
import type { CaseRequestSubject, CaseSnapshot } from "../case-types";
import { SAV_CASE_LEXICAL_RECALL, selectCaseKnowledge } from "../investigation-knowledge";
import { smartServerChecks } from "./smart-checks";
import { smartDecisionSchema, smartReadingSchema } from "./smart-contract";
import { SMART_GOOD_REPLY, SMART_TEST_CARD, smartGoodDecision, smartReading } from "./smart-test-doubles";

/*
 * The three production quality bugs of 25/11 (Agent SAV live), on fictional data only.
 */

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. Recall: a request searched on the customer's words alone lost every card to the absolute floor
// ---------------------------------------------------------------------------------------------------------------------------------

const NOW = new Date("2026-11-25T12:00:00Z");
const availability = { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" };
const card = (id: string, title: string, semanticScore: number, content = "Procédure synthétique."): SavRetrievalCandidate => ({ id, contentVersionId: `${id}-v1`, title, content,
  source: "fixture", verifiedAt: "2026-11-20T00:00:00Z", semanticScore, resolution: { steps: ["Étape synthétique"] }, availability: { ...availability } });
// The production titles, fictional bodies; every vector score under the floor (0.65), as a whole two-topic mail gets.
const LINKEDIN_CARDS = [
  card("k-prospection", "Lancer une campagne de prospection LinkedIn : rechercher les prospects puis personnaliser la séquence", 0.58, "Envoyez la séquence de messages."),
  card("k-connecter", "Connecter LinkedIn pour prospecter ou publier", 0.57),
  card("k-limite", "Limite d'invitations LinkedIn : 20 par jour", 0.55),
  card("k-automatisation", "Créer une automatisation de création de post (V3)", 0.56, "Choisissez le jour et l'heure pour programmer le post."),
  card("k-rediger", "Rédiger un post pour les réseaux sociaux (V3)", 0.54),
  card("k-imap", "Connecter une boîte mail en IMAP (Nylas)", 0.6),
];
const WORDS = "Je souhaite envoyer des messages LinkedIn pour sourcer mais ça ne fonctionne pas. De plus je souhaite programmer des posts LinkedIn et ça ne fonctionne pas non plus.";
const row = (subject: CaseRequestSubject) => ({ id: "r1", summary: "Demande « support » relevée par l'analyse V1 du mail m1.", family: "other", status: "open", openedAt: "2026-11-25T10:00:00Z", subject });
const snap = (subject: CaseRequestSubject) => ({ caseId: "case-fixes", version: 3, body: { openRequests: [row(subject)] } }) as unknown as CaseSnapshot;
const NO_SUBJECT: CaseRequestSubject = { status: "absent", reason: "summary_shared" } as CaseRequestSubject;
const backend = (cards: SavRetrievalCandidate[]): SavRetrievalBackend => ({ readRevision: async () => "kb-r1", search: async queries => queries.map(() => cards) });
const scope = (lexicalRecall?: boolean) => ({ locale: "fr-FR", audience: "support" as const, now: NOW, customerWords: WORDS, ...(lexicalRecall ? { lexicalRecall } : {}) });

describe("1. recall: the customer's words alone, every vector score under the floor", () => {
  it("the smart brain's case keeps the cards whose title holds the words (LinkedIn, posts), never the off-topic one", async () => {
    const read = await selectCaseKnowledge(snap(NO_SUBJECT), backend(LINKEDIN_CARDS), scope(true));
    if (read.status !== "ready") throw Error("expected ready");
    const [coverage] = read.selection.coverage;
    expect(coverage).toMatchObject({ status: "covered" });
    expect(coverage!.knowledge).toHaveLength(3);
    expect(coverage!.knowledge.map(ref => ref.knowledgeId)).not.toContain("k-imap");
    expect(coverage!.knowledge.map(ref => ref.knowledgeId)).toEqual(expect.arrayContaining(["k-prospection", "k-automatisation"]));
    expect(coverage!.limitations).toEqual(expect.arrayContaining(["customer_words_searched", SAV_CASE_LEXICAL_RECALL]));
    expect(read.selection.cards.map(row => row.id)).toEqual(coverage!.knowledge.map(ref => ref.knowledgeId));
  });
  it("without the switch (pilot blocks, any other caller) the result is unchanged: no card, nothing applicable", async () => {
    const read = await selectCaseKnowledge(snap(NO_SUBJECT), backend(LINKEDIN_CARDS), scope());
    if (read.status !== "ready") throw Error("expected ready");
    expect(read.selection.coverage[0]).toMatchObject({ status: "no_applicable_knowledge", knowledge: [] });
    expect(read.selection.coverage[0]!.limitations).not.toContain(SAV_CASE_LEXICAL_RECALL);
  });
  it("a card the words do not name in its title or symptoms is never recalled; a request that already has a card is untouched", async () => {
    const offTopic = await selectCaseKnowledge(snap(NO_SUBJECT), backend([LINKEDIN_CARDS[5]!]), scope(true));
    if (offTopic.status !== "ready") throw Error("expected ready");
    expect(offTopic.selection.coverage[0]).toMatchObject({ status: "no_applicable_knowledge", knowledge: [] });
    const subject: CaseRequestSubject = { status: "available", text: "Envoyer des messages LinkedIn", provenance: { source: "v1_accepted_analysis", field: "ticketSummary",
      runId: "30000000-0000-4000-8000-000000000001", runVersion: 1, resultHash: "h", validatorRevision: "v", acceptedAt: "2026-11-25T09:59:00Z" } } as CaseRequestSubject;
    const withSubject = await selectCaseKnowledge(snap(subject), backend(LINKEDIN_CARDS), scope(true));
    const plain = await selectCaseKnowledge(snap(subject), backend(LINKEDIN_CARDS), scope());
    if (withSubject.status !== "ready" || plain.status !== "ready") throw Error("expected ready");
    expect(withSubject.selection.coverage).toEqual(plain.selection.coverage);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. Links: the official Academy link of the cited card is kept; a refused link is named so the correction removes only it
// ---------------------------------------------------------------------------------------------------------------------------------

const NYLAS = { ...SMART_TEST_CARD, content: `${SMART_TEST_CARD.content}\n\nOuvrez le guide Nylas sur la Limova Academy : https://academy.limova.ai/integrations/nylas. Remplissez les champs.` };
const checks = (reply: string, cards = [NYLAS]) => smartServerChecks({ decision: smartDecisionSchema.parse(smartGoodDecision({ reply })), reading: smartReadingSchema.parse(smartReading()),
  customerText: "Je n'arrive pas à me connecter.", sources: cards });

describe("2. links: official Limova links kept, every other link refused and named", () => {
  it("the cited card's Academy link passes, written plain, in Markdown bold or in French quotes", () => {
    for (const link of ["https://academy.limova.ai/integrations/nylas", "**https://academy.limova.ai/integrations/nylas**", "« https://academy.limova.ai/integrations/nylas »"])
      expect(checks(`${SMART_GOOD_REPLY} Le guide : ${link}`).codes, link).toEqual([]);
  });
  it("a card's deep link on another official host passes even glued to Markdown; the home page of an official Limova site always passes", () => {
    const card = { ...SMART_TEST_CARD, content: `${SMART_TEST_CARD.content} Guide : https://bienvenue.limova.ai/guides/connexion` };
    expect(checks(`${SMART_GOOD_REPLY} Guide : **https://bienvenue.limova.ai/guides/connexion**`, [card]).codes).toEqual([]);
    for (const link of ["https://new.limova.ai", "new.limova.ai", "https://new.limova.ai/", "https://limova.ai"])
      expect(checks(`${SMART_GOOD_REPLY} Connectez-vous sur ${link}.`, [SMART_TEST_CARD]).codes, link).toEqual([]);
  });
  it("an invented page on an official host and any other site stay refused, and each refused link is named for the correction", () => {
    const result = checks(`${SMART_GOOD_REPLY} Guide : https://academy.limova.ai/integrations/nylas puis https://new.limova.ai/page-inventee et https://hebergeur.exemple.invalid/imap`, [SMART_TEST_CARD]);
    expect(result.codes).toEqual(["link_not_allowed"]);
    const named = result.factProblems.filter(row => row.code === "link_not_allowed").map(row => row.sentence);
    expect(named).toHaveLength(2);
    expect(named.join("\n")).toContain("https://new.limova.ai/page-inventee");
    expect(named.join("\n")).toContain("https://hebergeur.exemple.invalid/imap");
    expect(named.join("\n")).not.toContain("academy.limova.ai");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 3. The generic help line is never appended to an automated reply (its AI notice already asks what still blocks)
// ---------------------------------------------------------------------------------------------------------------------------------

const ANSWER = "Bonjour.\n\n1. Ouvrez Intégrations.\n2. Recherchez Nylas.\n\nSi cela ne fonctionne toujours pas, envoyez-nous l'adresse de la conversation et une capture d'écran.";

describe("3. help line", () => {
  it("an automated answer or reminder ends with the reply then the AI notice, without the help line", () => {
    for (const purpose of ["answer", "reminder"] as const) {
      const text = prepareCaseReplyText(ANSWER, "fr", "automated", purpose);
      expect(text, purpose).not.toContain(caseReplyHelpLine("fr"));
      expect(text, purpose).toContain("capture d'écran.\n\nCharly — Agent IA du support Limova\n");
    }
  });
  it("a text stored with the help line is prepared again without it (idempotent, never stacked); the human-validated mode is unchanged", () => {
    const stored = `${ANSWER}\n\n${caseReplyHelpLine("fr")}`;
    expect(prepareCaseReplyText(stored, "fr", "automated", "answer")).toBe(prepareCaseReplyText(ANSWER, "fr", "automated", "answer"));
    expect(prepareCaseReplyText(ANSWER, "fr", "manual_reviewed", "answer")).toContain(caseReplyHelpLine("fr"));
  });
});
