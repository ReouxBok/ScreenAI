import { describe, expect, it } from "vitest";
import { runSmartTurn, type SmartTurnInput } from "./smart-agent";
import type { SmartSource } from "./smart-checks";
import { SAV_SMART_VERIFY_CODES, smartVerdictSchema } from "./smart-contract";
import { SAV_SMART_CORRECTION_INSTRUCTION, smartDecidePrompt, smartVerifyPrompt } from "./smart-prompt";
import { SMART_CONFORME, smartReading, smartScriptedModel, smartStaticKnowledge, type SmartScript } from "./smart-test-doubles";

/*
 * v21 (25/11, real case): a customer asked whether her Limova V2 conversations would disappear once V2 is shut down for good. The cited card only said
 * that switching versions deletes nothing and that V2 is still accessible; the agent answered « Vos conversations ne risquent pas de disparaître » and
 * the counter-read judged it « conforme ». A guarantee, a permanence or a future statement, like the answer the customer asked for, must come from a
 * cited excerpt, never be deduced from a nearby one. Model-led (prompt + counter-read code), no word list on the server. Fictional data only.
 */
const MAIL: SmartTurnInput = { subject: "Conversations V2", body: "Bonjour, quand Limova V2 sera arrêtée pour de bon, est-ce que mes conversations V2 vont disparaître ? Merci, Alice (alice@exemple.invalid)", thread: [] };
const CARD: SmartSource = {
  cardId: "fiche-versions", version: "v1", title: "Passer de Limova V2 à Limova V3",
  content: "Passer de Limova V2 à Limova V3 ne supprime aucune donnée. Limova V2 reste accessible.", steps: [], needIds: ["n1"], validUntil: null,
};
const reading = smartReading({ needs: [{ id: "n1", ask: "savoir si ses conversations V2 disparaîtront à l'arrêt de Limova V2", alreadyDone: [], theme: "versions", search: "conversations V2 arrêt" }] });
const GUARANTEE = "Vos conversations ne risquent pas de disparaître.";
const unsourced = {
  outcome: "reply", teamNote: null, handoffReason: null, coverage: [{ needId: "n1", status: "answered" }],
  reply: `Bonjour,\n\nVous vous demandez si vos conversations V2 disparaîtront. Passer de Limova V2 à Limova V3 ne supprime aucune donnée. ${GUARANTEE}\n\nBelle journée.`,
  facts: [{ sentence: "Passer de Limova V2 à Limova V3 ne supprime aucune donnée.", needId: "n1", type: "fait_limova", sourceKind: "fiche", cardId: "fiche-versions", version: "v1",
    excerpt: "Passer de Limova V2 à Limova V3 ne supprime aucune donnée." }],
};
const handedOver = {
  outcome: "handoff", handoffReason: "no_source", coverage: [{ needId: "n1", status: "handed" }], facts: [],
  reply: "Bonjour,\n\nVous vous demandez ce que deviendront vos conversations V2 à l'arrêt de Limova V2. Je n'ai pas cette information : notre équipe vous répond sur ce point.\n\nBelle journée.",
  teamNote: { raison: "no_source", besoin: "savoir si les conversations V2 disparaîtront à l'arrêt de Limova V2", compris: "aucune fiche ne parle de l'arrêt de V2", verifie: [], essaye: [],
    hypotheses: [], prochaineVerification: "confirmer ce que deviennent les conversations V2 à l'arrêt", ditAuClient: "information transmise à l'équipe" },
};
const flagged = { verdict: "non_conforme", problems: [{ code: "unsourced_claim", sentence: GUARANTEE }] };

const run = (script: SmartScript) => {
  const scripted = smartScriptedModel(script);
  return runSmartTurn(MAIL, { model: scripted.model, knowledge: smartStaticKnowledge([CARD]), maxInputBytes: 100_000, today: "2026-11-25", recordOwn: true })
    .then(result => ({ result, calls: scripted.calls, kinds: scripted.calls.map(call => call.kind) }));
};

describe("v21 : aucune garantie, permanence ou réponse déduite sans extrait cité", () => {
  it("décision : la règle dit qu'une garantie ou un avenir exige une fiche qui le dit, sans déduction, sinon on n'a pas l'information et on transmet", () => {
    expect(smartDecidePrompt()).toContain("Sans source, tu ne l'affirmes pas ni ne le déduis d'une phrase voisine ; une garantie ou un avenir (« ne disparaîtra pas », « aucun risque ») exige une fiche qui le dit. Sinon : tu n'as pas l'information, propose de la transmettre à l'équipe.");
  });
  it("relecture : le code unsourced_claim est dans le prompt (avec le cas V2) et dans la liste fermée du contrat ; la correction sait le traiter", () => {
    const verify = smartVerifyPrompt();
    expect(verify).toContain("12. unsourced_claim : la réponse donne une garantie, une permanence ou un avenir (« ne disparaîtra pas », « sera toujours disponible », « arrivera bientôt », « aucun risque »), ou répond à ce que le client demande, sans qu'un extrait le dise ; une déduction tirée d'un extrait voisin compte.");
    expect(verify).toContain("extrait « changer de version ne supprime rien », réponse « vos conversations V2 ne risquent pas de disparaître à l'arrêt de V2 »");
    expect(SAV_SMART_VERIFY_CODES).toContain("unsourced_claim");
    expect(smartVerdictSchema.parse(flagged).problems).toEqual([{ code: "unsourced_claim", sentence: GUARANTEE }]);
    expect(SAV_SMART_CORRECTION_INSTRUCTION).toContain("unsourced_claim : retire la garantie ou la déduction, dis que tu n'as pas cette information et propose de transmettre la question à l'équipe.");
  });
  it("cas V2 : la relecture reçoit l'extrait cité et la réponse ; la garantie signalée part en correction, qui transmet à l'équipe", async () => {
    const { result, calls, kinds } = await run({ understand: { output: reading }, decide: { output: unsourced }, verify: { output: flagged }, correct: { output: handedOver }, reverify: { output: SMART_CONFORME } });
    expect(kinds).toEqual(["understand", "decide", "verify", "correct", "reverify"]);
    expect(result.checks.first).toEqual([]);
    expect(calls[2]!.payload).toMatchObject({ reply: unsourced.reply, facts: [{ source: "fiche-versions", excerpt: "Passer de Limova V2 à Limova V3 ne supprime aucune donnée." }] });
    expect(calls[3]!.payload).toMatchObject({ problems: [{ code: "unsourced_claim", sentence: GUARANTEE }] });
    expect(result).toMatchObject({ outcome: "handoff", corrected: true, teamNote: { raison: "no_source" } });
    expect(result.replyWithFooter).toContain("Je n'ai pas cette information");
    expect(result.replyWithFooter).not.toContain("ne risquent pas de disparaître");
  });
  it("cas V2 : la garantie revient après la correction ; passage à l'équipe, rien n'est envoyé, le code est nommé (pas de resserrement)", async () => {
    const { result, kinds } = await run({ understand: { output: reading }, decide: { output: unsourced }, verify: { output: flagged }, correct: { output: unsourced }, reverify: { output: flagged } });
    expect(kinds).toEqual(["understand", "decide", "verify", "correct", "reverify"]);
    expect(result).toMatchObject({ outcome: "handoff", replyWithFooter: null });
    expect(result.reasons).toEqual(expect.arrayContaining(["refused_after_correction", "verify:unsourced_claim"]));
    expect(result.reasons).not.toContain("correction:narrowed");
  });
});
