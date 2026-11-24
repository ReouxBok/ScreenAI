import { describe, expect, it } from "vitest";
import { smartSensitiveCommitment, smartServerChecks } from "./smart-checks";
import { smartDecisionSchema, smartReadingSchema } from "./smart-contract";
import { smartJudgeInput, smartJudgeRead, smartTeamReplyFor } from "./smart-judge";
import { SMART_GOOD_REPLY, SMART_TEST_CARD, smartGoodDecision, smartReading } from "./smart-test-doubles";

const check = (reply: string, extra: { customer?: string; facts?: unknown[]; cards?: typeof SMART_TEST_CARD[] } = {}) => smartServerChecks({
  decision: smartDecisionSchema.parse(smartGoodDecision({ reply, ...(extra.facts ? { facts: extra.facts } : {}) })), reading: smartReadingSchema.parse(smartReading()),
  customerText: extra.customer ?? "Je n'arrive pas à me connecter.", sources: extra.cards ?? [SMART_TEST_CARD],
}).codes;

describe("contrôles serveur sans modèle (lot D3)", () => {
  it("une réponse fondée passe", () => expect(check(SMART_GOOD_REPLY)).toEqual([]));
  it("liens : ressources et liens d'une fiche fournie admis ; tout autre lien ou domaine refusé", () => {
    expect(check(`${SMART_GOOD_REPLY} Les webinaires : https://bienvenue.limova.ai/webinaires.`)).toEqual([]);
    const card = { ...SMART_TEST_CARD, content: `${SMART_TEST_CARD.content} Guide : https://aide.limova.ai/connexion` };
    expect(check(`${SMART_GOOD_REPLY} Guide : https://aide.limova.ai/connexion`, { cards: [card] })).toEqual([]);
    expect(check(`${SMART_GOOD_REPLY} Guide : https://aide.limova.ai/autre`)).toContain("link_not_allowed");
    expect(check(`${SMART_GOOD_REPLY} Rendez-vous sur wix.com.`)).toContain("link_not_allowed");
  });
  it("autre plateforme : un CONCURRENT recommandé, vanté ou proposé à l'inscription est refusé même nommé par le client ; un outil du client cité pour le relier à Limova passe", () => {
    const customer = "Je veux relier Limova à mon site Wix. Un ami me parle de ChatGPT.";
    expect(check(`${SMART_GOOD_REPLY} Je vous recommande d'utiliser ChatGPT pour cela.`, { customer })).toContain("other_platform_recommended");
    expect(check(`${SMART_GOOD_REPLY} ChatGPT propose déjà un assistant vocal.`, { customer })).toContain("other_platform_recommended");
    // PORTE 1J (orchestrator): a clause WITHOUT a named third party is never refused for a sign-up (« chez eux » names no tool): left to the counter-read.
    expect(check(`${SMART_GOOD_REPLY} Créez un compte chez eux.`, { customer })).not.toContain("other_platform_recommended");
    expect(check(`${SMART_GOOD_REPLY} Créez un compte chez ChatGPT.`, { customer })).toContain("other_platform_recommended");
    // Bench 22/11 (Ugo): the customer's own site builder is no competitor; replacing Limova with it still is.
    expect(check(`${SMART_GOOD_REPLY} Dans votre éditeur Wix, utilisez le bloc « Code HTML ».`, { customer })).not.toContain("other_platform_recommended");
    expect(check(`${SMART_GOOD_REPLY} Utilisez Wix à la place de Limova.`, { customer })).toContain("other_platform_recommended");
    expect(check(`${SMART_GOOD_REPLY} Utilisez plutôt un outil comme celui-ci.`)).toContain("other_platform_recommended");
    expect(check(`${SMART_GOOD_REPLY} Pour votre site Wix, je transmets la question à l'équipe.`, { customer })).toEqual([]);
    expect(check(`${SMART_GOOD_REPLY} Inscrivez-vous au prochain webinaire Limova.`)).toEqual([]);
    expect(check(`${SMART_GOOD_REPLY} Zapier peut vous aider.`)).toContain("third_party_named");
  });
  it("promesses et actions sur le compte", () => {
    expect(check(`${SMART_GOOD_REPLY} Ce sera corrigé d'ici demain.`)).toContain("promise_unsourced");
    expect(check(`${SMART_GOOD_REPLY} Cette option est gratuite.`)).toContain("promise_unsourced");
    expect(check(`${SMART_GOOD_REPLY} Cette fonction sera bientôt disponible.`)).toContain("promise_unsourced");
    expect(check(`${SMART_GOOD_REPLY} J'ai réinitialisé votre accès.`)).toContain("account_action_claimed");
  });
  it("N2 : 6 réponses qui ENGAGENT une action sensible sur le compte sont refusées (sensitive_commitment)", () => {
    for (const sentence of [
      "Nous allons annuler votre abonnement dès aujourd'hui.",
      "Je vous rembourse le mois de novembre.",
      "Votre abonnement sera résilié à la fin du mois.",
      "Nous allons supprimer toutes vos données.",
      "Je vais changer le titulaire du compte pour votre associé.",
      "Je vous envoie un nouveau mot de passe par mail.",
    ]) {
      expect(smartSensitiveCommitment(sentence), sentence).toBe(true);
      expect(check(`${SMART_GOOD_REPLY} ${sentence}`), sentence).toContain("sensitive_commitment");
    }
    expect(smartSensitiveCommitment("Vous serez remboursé intégralement.")).toBe(true);
    expect(smartSensitiveCommitment("On a supprimé votre compte.")).toBe(true);
  });
  it("N2 : 6 réponses qui MENTIONNENT seulement un sujet sensible passent (un mot ne refuse plus, « kernel_in_reply » n'est plus émis)", () => {
    for (const sentence of [
      "Votre facture est disponible dans votre espace, rubrique Facturation.",
      "Le prix d'une intégration n'est pas indiqué dans nos fiches, je transmets cette question à l'équipe.",
      "Vous pouvez annuler la routine depuis la conversation où elle a été créée.",
      "Pour supprimer un fichier, ouvrez la bibliothèque puis cliquez sur « … ».",
      "Votre question sur le remboursement est transmise à l'équipe.",
      "Votre abonnement n'est pas en cause : le souci vient de la connexion Gmail.",
    ]) {
      expect(smartSensitiveCommitment(sentence), sentence).toBe(false);
      expect(check(`${SMART_GOOD_REPLY} ${sentence}`), sentence).toEqual([]);
    }
    // Orchestrator decision (second review): abonnement + annuler in OUR reply refuses even in the negative; the turn goes to the team.
    expect(smartSensitiveCommitment("Nous ne pouvons pas annuler votre abonnement nous-mêmes.")).toBe(true);
    expect(smartSensitiveCommitment("Je vous suggère de supprimer le fichier puis de le réimporter.")).toBe(false);
    // Orchestrator decision (second review): any word of cancellation in OUR reply refuses, even a mention; the turn then goes to the team.
    expect(check(`${SMART_GOOD_REPLY} Pour toute question de résiliation, je transmets votre message à l'équipe.`)).toContain("sensitive_commitment");
  });
  it("revue N2 (P1 Astra) : la procédure donnée au client pour résilier ou annuler son abonnement ou son contrat est refusée ; annuler une routine passe", () => {
    for (const sentence of [
      "Vous pouvez résilier votre abonnement depuis vos paramètres.",
      "Vous pouvez résilier depuis vos paramètres.",
      "Résiliez votre abonnement depuis l'onglet Facturation.",
      "Pour annuler votre abonnement, ouvrez vos paramètres.",
      "Il vous suffit de mettre fin à votre contrat depuis votre espace.",
      "Annulez le renouvellement depuis votre compte.",
      // Second review (PORTE_1C): the button label, whatever the wording.
      "Dans vos paramètres Limova, cliquez sur “Résilier mon abonnement”, puis confirmez.",
      "La résiliation se fait en un clic depuis votre espace.",
      "Vous pouvez arrêter votre abonnement à tout moment.",
      "Pour mettre fin au contrat, écrivez-nous.",
      // Third review (PORTE_1E): the object BEFORE the verb, in any order within one sentence.
      "Dans vos paramètres Limova, ouvrez la rubrique Abonnement, cliquez sur “Annuler”, puis confirmez.",
      "Votre forfait peut être suspendu depuis votre espace.",
      "Pour votre offre, il suffit de cliquer sur Désactiver.",
      // Fourth review (PORTE_1G): the whole reply, the same procedure split in two sentences.
      "Dans vos paramètres Limova, ouvrez la rubrique Abonnement. Cliquez sur “Annuler”, puis confirmez.",
      // Accepted false positive (orchestrator): a subscription word and a stop verb anywhere in the reply → the team.
      "Votre abonnement est bien actif. Pour arrêter la routine, ouvrez sa conversation.",
    ]) expect(check(`${SMART_GOOD_REPLY} ${sentence}`), sentence).toContain("sensitive_commitment");
    for (const sentence of [
      "Vous pouvez annuler la routine depuis vos paramètres.",
      "Pour arrêter la routine, supprimez-la depuis sa conversation.",
      "Vous pouvez annuler l'envoi programmé avant 8 h.",
      "Vous pouvez annuler une tâche en cours depuis la conversation.",
      "Votre facture est disponible dans votre espace, rubrique Facturation.",
      "Votre abonnement n'est pas en cause : le souci vient de la connexion Gmail.",
      // Third review (PORTE_1E): « compte » is not a subscription object; « offre » as a verb is not one either.
      "Vous pouvez arrêter la routine depuis votre compte Limova.",
      "Limova offre la possibilité d'annuler une tâche en cours.",
    ]) expect(check(`${SMART_GOOD_REPLY} ${sentence}`), sentence).toEqual([]);
  });
  it("N2, enquête : demander l'URL de la conversation, des captures ou le numéro de téléphone du client n'est pas une demande de secret", () => {
    expect(check(`${SMART_GOOD_REPLY} Pouvez-vous nous envoyer l'URL de la conversation, visible dans la barre d'adresse, et une capture d'écran ?`)).toEqual([]);
    expect(check(`${SMART_GOOD_REPLY} Pouvez-vous nous indiquer le numéro de téléphone avec lequel vous écrivez à Charly Max ?`)).toEqual([]);
    expect(check(`${SMART_GOOD_REPLY} Pouvez-vous nous envoyer votre token API ?`)).toContain("credential_request");
  });
  it("faits : une phrase indicative reformulée n'est plus refusée (SAV-122) ; fait d'un autre éditeur, extrait du client introuvable", () => {
    const fact = smartGoodDecision().facts[0];
    expect(check(SMART_GOOD_REPLY, { facts: [{ ...fact, sentence: "Une phrase qui n'est pas dans la réponse." }] })).toEqual([]);
    expect(check(SMART_GOOD_REPLY, { facts: [{ ...fact, type: "fait_tiers" }] })).toContain("third_party_fact_unsourced");
    expect(check(SMART_GOOD_REPLY, { facts: [{ ...fact, type: "dit_par_le_client", sourceKind: "client", cardId: null, version: null, excerpt: "j'ai tout réinstallé" }] })).toContain("excerpt_not_found");
    expect(check(SMART_GOOD_REPLY, { facts: [{ ...fact, version: "v2" }] })).toContain("card_not_retrieved_for_need");
  });
});

describe("comparaison avec l'équipe (interface non branchée)", () => {
  const mailAt = "2026-11-20T09:00:00.000Z";
  it("la réponse humaine attribuée est la première après le mail et avant le mail suivant du client", () => {
    const events = [{ kind: "human_reply", occurredAt: "2026-11-20T08:00:00.000Z", text: "avant" }, { kind: "human_reply", occurredAt: "2026-11-20T10:00:00.000Z", text: "la bonne" },
      { kind: "customer_reply", occurredAt: "2026-11-20T11:00:00.000Z", text: "relance" }, { kind: "human_reply", occurredAt: "2026-11-20T12:00:00.000Z", text: "après la relance" }];
    expect(smartTeamReplyFor({ mailAt, events, sourceErrors: [] })).toEqual({ status: "comparable", text: "la bonne", at: "2026-11-20T10:00:00.000Z" });
  });
  it("sans preuve : couverture Gmail incertaine, livraison non vérifiée, pas encore de réponse", () => {
    expect(smartTeamReplyFor({ mailAt, events: [], sourceErrors: ["gmail:outbound_coverage_unverified"] })).toEqual({ status: "no_proof", reason: "gmail_coverage_unverified" });
    expect(smartTeamReplyFor({ mailAt, events: [{ kind: "email_unverified", occurredAt: "2026-11-20T10:00:00.000Z", text: "x" }], sourceErrors: [] })).toEqual({ status: "no_proof", reason: "delivery_unverified" });
    expect(smartTeamReplyFor({ mailAt, events: [], sourceErrors: [] })).toEqual({ status: "no_proof", reason: "no_reply_yet" });
  });
  it("à l'aveugle : A/B tiré du mail, les deux côtés masqués, verdict hors grille refusé", () => {
    const input = smartJudgeInput({ messageId: "m1", customerMail: "écrire à client@exemple.invalid", shadowReply: "ombre", teamReply: "équipe" });
    expect(JSON.stringify(input.payload)).not.toContain("client@exemple.invalid");
    expect([input.payload.A, input.payload.B].sort()).toEqual(["equipe", "ombre"].map(value => value === "equipe" ? "équipe" : value).sort());
    const no = { promise: "non", otherPlatform: "non", secretRequested: "non", sensitiveHandled: "non", repeatsDone: "non" };
    const read = smartJudgeRead(input.shadowIsA, { sameOutcome: "oui", contradiction: "non", better: input.shadowIsA ? "A" : "B", A: no, B: no });
    expect(read).toMatchObject({ ok: true, better: "shadow", sameOutcome: true });
    expect(smartJudgeRead(true, { better: "A" })).toEqual({ ok: false, problem: "output_invalid" });
  });
});

describe("v20 : le mail d'enquête avant passation (bug technique)", () => {
  const INVESTIGATION = "Bonjour,\n\nJ'ai bien noté votre retour : votre routine ne part plus. Pour enquêter plus en profondeur : quel message s'affiche, et depuis quand ?\n\n"
    + "Envoyez-nous aussi une capture du dernier problème et le lien de la conversation concernée : ouvrez-la dans Limova, cliquez dans la barre d'adresse de votre navigateur, copiez l'adresse et collez-la dans votre réponse.\n\nBelle journée.";
  const ask = (extra: Record<string, unknown> = {}) => smartServerChecks({
    decision: smartDecisionSchema.parse(smartGoodDecision({ outcome: "ask", reply: INVESTIGATION, coverage: [{ needId: "n1", status: "asked" }], facts: [],
      memory: { question: "Message affiché, depuis quand, capture et lien de la conversation." }, ...extra })),
    reading: smartReadingSchema.parse(smartReading({ needs: [{ id: "n1", ask: "faire repartir sa routine", alreadyDone: [], theme: "routine", search: "routine ne se lance plus" }] })),
    customerText: "Bonjour, ma routine ne part plus depuis hier.", sources: [],
  }).codes;
  it("un « ask » sans fiche ni lien, sans délai ni promesse : aucun contrôle serveur ne le refuse", () => expect(ask()).toEqual([]));
  it("le même texte avec une promesse de délai reste refusé ; la passation qui suit porte une note real_bug qui dit ce qui a été reçu", () => {
    expect(ask({ reply: `${INVESTIGATION} Ce sera corrigé d'ici demain.` })).toContain("promise_unsourced");
    const note = { raison: "real_bug", besoin: "faire repartir sa routine", compris: "URL de conversation reçue ; captures non reçues.", verifie: [], essaye: [], hypotheses: [],
      prochaineVerification: "Ouvrir la conversation transmise et relire l'exécution de la routine.", ditAuClient: "L'équipe reprend." };
    expect(smartDecisionSchema.parse(smartGoodDecision({ outcome: "handoff", teamNote: note, coverage: [{ needId: "n1", status: "handed" }], facts: [] })).teamNote)
      .toMatchObject({ raison: "real_bug", compris: note.compris });
  });
});
