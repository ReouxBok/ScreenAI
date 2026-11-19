import { describe, expect, it } from "vitest";
import { smartServerChecks } from "./smart-checks";
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
  it("autre plateforme : invitation, recommandation ou éloge refusés même nommée par le client ; un outil du client cité pour le relier à Limova passe", () => {
    const customer = "Je veux relier Limova à mon site Wix.";
    expect(check(`${SMART_GOOD_REPLY} Je vous recommande d'utiliser Wix pour cela.`, { customer })).toContain("other_platform_recommended");
    expect(check(`${SMART_GOOD_REPLY} Wix propose déjà un assistant vocal.`, { customer })).toContain("other_platform_recommended");
    expect(check(`${SMART_GOOD_REPLY} Créez un compte chez eux.`, { customer })).toContain("other_platform_recommended");
    expect(check(`${SMART_GOOD_REPLY} Utilisez plutôt un outil comme celui-ci.`)).toContain("other_platform_recommended");
    expect(check(`${SMART_GOOD_REPLY} Pour votre site Wix, je transmets la question à l'équipe.`, { customer })).toEqual([]);
    expect(check(`${SMART_GOOD_REPLY} Inscrivez-vous au prochain webinaire Limova.`)).toEqual([]);
    expect(check(`${SMART_GOOD_REPLY} Zapier peut vous aider.`)).toContain("third_party_named");
  });
  it("promesses, actions sur le compte, noyau sensible dans notre réponse", () => {
    expect(check(`${SMART_GOOD_REPLY} Ce sera corrigé d'ici demain.`)).toContain("promise_unsourced");
    expect(check(`${SMART_GOOD_REPLY} Cette option est gratuite.`)).toContain("promise_unsourced");
    expect(check(`${SMART_GOOD_REPLY} Cette fonction sera bientôt disponible.`)).toContain("promise_unsourced");
    expect(check(`${SMART_GOOD_REPLY} J'ai réinitialisé votre accès.`)).toContain("account_action_claimed");
    expect(check(`${SMART_GOOD_REPLY} Vous pouvez résilier depuis vos paramètres.`)).toContain("kernel_in_reply");
  });
  it("faits : phrase absente, fait d'un autre éditeur, extrait du client introuvable", () => {
    const fact = smartGoodDecision().facts[0];
    expect(check(SMART_GOOD_REPLY, { facts: [{ ...fact, sentence: "Une phrase qui n'est pas dans la réponse." }] })).toContain("fact_sentence_missing");
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
