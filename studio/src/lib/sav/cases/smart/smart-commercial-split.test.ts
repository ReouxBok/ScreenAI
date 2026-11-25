import { describe, expect, it } from "vitest";
import type { SavRetrievalCandidate } from "../../request-retrieval";
import { emptyCaseBody, SAV_CASE_CONTRACT_REVISION, type CaseEvent, type CaseSnapshot } from "../case-types";
import type { CaseInvestigationModelRequest } from "../investigation-runner";
import { runSmartTurn, type SmartKnowledgePort, type SmartTurnPorts } from "./smart-agent";
import type { SmartSource } from "./smart-checks";
import { smartCaseDecisionProvider } from "./smart-case-provider";
import type { SmartReading } from "./smart-contract";
import { SAV_SMART_COMMERCIAL_ROUTE } from "./smart-handoff-note";
import type { SmartModelPort } from "./smart-model";
import {
  SAV_SMART_COMMERCIAL_PROMPT_SHA256, SAV_SMART_PROMPT_MAX_BYTES, SAV_SMART_PROMPT_SHA256, smartCorrectionPrompt, smartDecidePrompt, smartPromptBytes, smartPromptPinned,
  smartPromptSha256, smartUnderstandPrompt, smartVerifyPrompt,
} from "./smart-prompt";
import { SAV_SMART_COMMERCIAL_SPLIT_ENV, smartCommercialSet } from "./smart-switch";
import { SMART_CONFORME } from "./smart-test-doubles";

/*
 * 25/11 (Ugo): « quelle offre me convient ? » and « une démo ? » are commercial questions, not a sensitive subscription topic, behind
 * `SAV_V2_SMART_COMMERCIAL_SPLIT=on`. FICTIONAL data only (public repository): no customer, no key, no network.
 *
 * The understand double answers like the model would to the prompt it receives: today's prompt (no commercial rule) gives the reading seen in
 * production on 25/11 (sensible abonnement, sensitive yes, family subscription); the split prompt (its « QUESTION COMMERCIALE » block) gives a
 * commercial need and nothing sensitive. The real model's judgement is measured by the bench, not here.
 */

const FIVE_QUESTIONS = [
  "Bonjour,", "Je viens de créer mon compte et j'ai 8 Assistants.",
  "Comment accéder à mes Assistants et les configurer ? Comment leur donner des missions récurrentes ? Comment les superviser ?",
  "Quelle offre correspond le mieux à mes besoins ?", "Puis-je connecter Gmail sans leur donner le droit de supprimer des e-mails ?",
  "Enfin, serait-il possible d'avoir une démo personnalisée ?", "Merci, Paul Exemple", "paul@exemple.invalid",
].join("\n");
const PURE_COMMERCIAL = "Bonjour, quelle offre me conseillez-vous ? Et une démo, c'est possible ? Merci, Léa (lea@exemple.invalid)";

const SUPPORT_NEEDS = [
  { id: "n1", ask: "accéder à ses Assistants et les configurer", alreadyDone: [], theme: "assistants", search: "accéder configurer Assistants" },
  { id: "n2", ask: "donner des missions récurrentes et les superviser", alreadyDone: [], theme: "routines", search: "mission récurrente routine suivi" },
  { id: "n3", ask: "connecter Gmail sans droit de suppression", alreadyDone: [], theme: "gmail", search: "connexion Gmail permissions" },
];
const COMMERCIAL_NEED = { id: "n4", ask: "choisir l'offre adaptée et obtenir une démo personnalisée", alreadyDone: [], theme: "offre", search: null, commercial: true };
const nothingSensitive = (preuve: string) => ({ sensitive: "no", sensitiveFamilies: [], sensible: { famille: "aucune", preuve }, wantsHuman: false, upset: false, instructionInMail: false });
const READING_TODAY = { needs: [...SUPPORT_NEEDS, { ...COMMERCIAL_NEED, commercial: undefined }], sensitive: "yes", sensitiveFamilies: ["subscription"],
  sensible: { famille: "abonnement", preuve: "Quelle offre correspond le mieux à mes besoins ?" }, wantsHuman: false, upset: false, instructionInMail: false };
const READING_SPLIT = { needs: [...SUPPORT_NEEDS, COMMERCIAL_NEED], ...nothingSensitive("Quelle offre correspond le mieux à mes besoins ?") };

const CARD: SmartSource = {
  cardId: "fiche-assistants", version: "v2", title: "Prendre en main ses Assistants",
  content: "Vos Assistants se trouvent dans l'onglet Assistants. Une routine donne une mission récurrente à un Assistant. L'historique des conversations montre ce que chaque Assistant a fait. La connexion Gmail se fait depuis Intégrations.",
  steps: [], needIds: ["n1", "n2", "n3"], validUntil: null,
};
const fact = (needId: string, excerpt: string) => ({ needId, type: "fait_limova", sourceKind: "fiche", cardId: CARD.cardId, version: CARD.version, excerpt });
const SUPPORT_REPLY = "Bonjour,\n\nVos Assistants se trouvent dans l'onglet Assistants. Une routine donne une mission récurrente à un Assistant, et l'historique des conversations montre ce que chaque Assistant a fait. La connexion Gmail se fait depuis Intégrations.\n\nVotre question sur l'offre et la démo est transmise à l'équipe.\n\nBelle journée.";
const supportFacts = [fact("n1", "Vos Assistants se trouvent dans l'onglet Assistants."), fact("n2", "Une routine donne une mission récurrente à un Assistant."),
  fact("n3", "La connexion Gmail se fait depuis Intégrations.")];
const decisionWith = (coverage4: "handed" | "answered", teamNote: unknown) => ({
  outcome: "reply", reply: SUPPORT_REPLY, handoffReason: null, teamNote,
  coverage: [{ needId: "n1", status: "answered" }, { needId: "n2", status: "answered" }, { needId: "n3", status: "answered" }, { needId: "n4", status: coverage4 }],
  facts: supportFacts,
});
const MODEL_NOTE = { raison: "other", besoin: "Le client veut savoir quelle offre lui convient et avoir une démo.", compris: "8 Assistants, compte neuf.", verifie: [], essaye: [], hypotheses: [],
  prochaineVerification: "Proposer une démo.", ditAuClient: "Sa question sur l'offre est transmise." };

type Call = { kind: string; system: string; payload: unknown };
/** The model double: understand reads the prompt it gets (see above), decide returns the given decision, the counter-reads are « conforme ». */
function brain(readings: Readonly<{ today: unknown; split: unknown }>, decision: unknown) {
  const calls: Call[] = [];
  const model: SmartModelPort = async ({ kind, system, payload }) => {
    calls.push({ kind, system, payload });
    const output = kind === "understand" ? (system.includes("QUESTION COMMERCIALE") ? readings.split : readings.today)
      : kind === "decide" ? { thinking: "", action: "final", calls: [], decision } : SMART_CONFORME;
    return { status: "ok", output, usage: { inputTokens: 1_000, outputTokens: 200 }, inputBytes: Buffer.byteLength(JSON.stringify(payload)) };
  };
  return { model, calls };
}
function knowledge(): SmartKnowledgePort & { asked: Array<SmartReading["needs"]> } {
  const asked: Array<SmartReading["needs"]> = [];
  return Object.assign(async (needs: SmartReading["needs"]) => { asked.push(needs); return { status: "ok" as const, sources: [CARD], codes: [] }; }, { asked });
}
const ports = (model: SmartModelPort, port: SmartKnowledgePort, extra: Partial<SmartTurnPorts> = {}): SmartTurnPorts =>
  ({ model, knowledge: port, maxInputBytes: 200_000, today: "2026-11-25", ...extra });
const mail = (body: string) => ({ subject: "Questions de démarrage", body, thread: [] });

describe("SAV_V2_SMART_COMMERCIAL_SPLIT : question commerciale ≠ sujet sensible", () => {
  it("le switch ne vaut que « on » exactement ; éteint, il n'ajoute rien", () => {
    expect(SAV_SMART_COMMERCIAL_SPLIT_ENV).toBe("SAV_V2_SMART_COMMERCIAL_SPLIT");
    expect(smartCommercialSet({ SAV_V2_SMART_COMMERCIAL_SPLIT: "on" })).toEqual({ commercialSplit: true });
    for (const value of [undefined, "", "ON", "true", "1", "off", "shadow"]) expect(smartCommercialSet({ SAV_V2_SMART_COMMERCIAL_SPLIT: value })).toEqual({});
  });

  it("éteint : les prompts et l'empreinte sont ceux de la v21, octet pour octet ; allumé : une autre empreinte, figée elle aussi", () => {
    expect(smartPromptSha256()).toBe(SAV_SMART_PROMPT_SHA256);
    expect(smartPromptSha256({})).toBe(SAV_SMART_PROMPT_SHA256);
    expect(smartPromptSha256({ commercialSplit: false })).toBe(SAV_SMART_PROMPT_SHA256);
    expect(smartPromptSha256({ commercialSplit: true })).toBe(SAV_SMART_COMMERCIAL_PROMPT_SHA256);
    expect(SAV_SMART_COMMERCIAL_PROMPT_SHA256).not.toBe(SAV_SMART_PROMPT_SHA256);
    expect(smartPromptPinned()).toBe(true);
    for (const prompt of [smartUnderstandPrompt, smartDecidePrompt, smartVerifyPrompt, smartCorrectionPrompt]) expect(prompt({})).toBe(prompt());
  });

  it("allumé : la définition commerciale et le garde-fou argent/contrat sont dans les prompts ; décision sous 9 000 octets", () => {
    const on = { commercialSplit: true } as const, understand = smartUnderstandPrompt(on);
    expect(smartUnderstandPrompt()).not.toContain("QUESTION COMMERCIALE");
    expect(understand).toContain("QUESTION COMMERCIALE (AVANT ACHAT)");
    expect(understand).toContain("Fais-en un besoin à part avec commercial à true");
    expect(understand).toContain("Reste sensible, tout le mail à l'équipe : payer, souscrire ou passer à une offre, changer, renouveler ou résilier son abonnement, une facture, un remboursement, un changement de facturation.");
    expect(understand).toContain(`"commercial":false}`);
    expect(understand).not.toContain("résiliation, abonnement ou offre, paiement");
    expect(smartDecidePrompt(on)).toContain("Besoin commercial true (choix d'offre, démo) : ni offre, ni prix, ni démo ; coverage handed avec teamNote");
    expect(smartVerifyPrompt(on)).toContain("Dire qu'une question commerciale (choix d'offre, démo) est transmise à l'équipe n'est pas sensitive_handled.");
    expect(smartPromptBytes(on).decide).toBeLessThanOrEqual(SAV_SMART_PROMPT_MAX_BYTES);
  });

  it("le mail aux 5 questions, éteint : tout le mail à l'équipe comme aujourd'hui (sensible abonnement), aucune fiche cherchée", async () => {
    const { model, calls } = brain({ today: READING_TODAY, split: READING_SPLIT }, decisionWith("handed", MODEL_NOTE)), port = knowledge();
    const result = await runSmartTurn(mail(FIVE_QUESTIONS), ports(model, port));
    expect(result.outcome).toBe("team_sensitive");
    expect(result.sensitiveStop).toBe("understand");
    expect(result.reasons).toEqual(["hint:subscription", "understand:sensible_abonnement", "understand:sensitive_yes", "family:subscription"]);
    expect(port.asked).toHaveLength(0);
    expect(calls.map(call => call.kind)).toEqual(["understand"]);
    expect(calls[0]!.system).toBe(smartUnderstandPrompt());
  });

  it("le mail aux 5 questions, allumé : pas de stop sensible ; les questions d'usage cherchées et répondues ; offre + démo → l'équipe (Sacha)", async () => {
    const { model, calls } = brain({ today: READING_TODAY, split: READING_SPLIT }, decisionWith("handed", MODEL_NOTE)), port = knowledge();
    const result = await runSmartTurn(mail(FIVE_QUESTIONS), ports(model, port, { commercialSplit: true }));
    expect(result.outcome).toBe("reply");
    expect(result.sensitiveStop).toBeNull();
    expect(result.reasons).toContain("understand:commercial");
    expect(result.reasons.some(reason => reason.startsWith("understand:sensi") || reason.startsWith("family:"))).toBe(false);
    // The commercial need is never searched: the search gets the three usage needs only.
    expect(port.asked).toHaveLength(1);
    expect(port.asked[0]!.map(need => need.id)).toEqual(["n1", "n2", "n3"]);
    expect(calls.map(call => call.kind)).toEqual(["understand", "decide", "verify"]);
    expect(calls[0]!.system).toBe(smartUnderstandPrompt({ commercialSplit: true }));
    expect(calls[1]!.system).toBe(smartDecidePrompt({ commercialSplit: true }));
    expect(calls[2]!.system).toBe(smartVerifyPrompt({ commercialSplit: true }));
    expect(result.decision?.coverage).toEqual([{ needId: "n1", status: "answered" }, { needId: "n2", status: "answered" }, { needId: "n3", status: "answered" }, { needId: "n4", status: "handed" }]);
    expect(result.replyWithFooter).toContain("Vos Assistants se trouvent dans l'onglet Assistants.");
    expect(result.teamNote?.besoin).toBe(`${SAV_SMART_COMMERCIAL_ROUTE} : choisir l'offre adaptée et obtenir une démo personnalisée | ${MODEL_NOTE.besoin}`);
    expect(result.teamNoteText).toContain("Besoin : Demande commerciale (choix d'offre / démo) → Sacha : choisir l'offre adaptée");
  });

  it("allumé, le modèle « répond » au besoin commercial : le serveur le passe quand même à l'équipe, avec une note de routage", async () => {
    const { model } = brain({ today: READING_TODAY, split: READING_SPLIT }, decisionWith("answered", null));
    const result = await runSmartTurn(mail(FIVE_QUESTIONS), ports(model, knowledge(), { commercialSplit: true }));
    expect(result.outcome).toBe("reply");
    expect(result.decision?.coverage.find(row => row.needId === "n4")).toEqual({ needId: "n4", status: "handed" });
    expect(result.teamNote).toMatchObject({ raison: "other", besoin: `${SAV_SMART_COMMERCIAL_ROUTE} : choisir l'offre adaptée et obtenir une démo personnalisée`,
      prochaineVerification: "Transmettre à Sacha (équipe commerciale) la question sur le choix d'offre ou la démo." });
  });

  it("allumé, un passage de main avant toute décision (le client demande une personne) garde le routage commercial dans la note", async () => {
    const reading = { ...READING_SPLIT, wantsHuman: true };
    const { model, calls } = brain({ today: reading, split: reading }, decisionWith("handed", null));
    const result = await runSmartTurn(mail(FIVE_QUESTIONS), ports(model, knowledge(), { commercialSplit: true }));
    expect(result.outcome).toBe("handoff");
    expect(calls.map(call => call.kind)).toEqual(["understand"]);
    expect(result.teamNote?.besoin.startsWith(`${SAV_SMART_COMMERCIAL_ROUTE} : choisir l'offre adaptée`)).toBe(true);
  });

  it("« quelle offre me conseillez-vous ? et une démo ? » seul, allumé : passage de main commercial, aucun stop sensible, aucune fiche cherchée", async () => {
    const reading = { needs: [{ ...COMMERCIAL_NEED, id: "n1" }], ...nothingSensitive("quelle offre me conseillez-vous ?") };
    const decision = { outcome: "reply", reply: "Bonjour,\n\nVotre question sur l'offre et la démo est transmise à l'équipe.\n\nBelle journée.", teamNote: null, handoffReason: null,
      coverage: [{ needId: "n1", status: "answered" }], facts: [] };
    const { model } = brain({ today: { ...READING_TODAY, needs: [{ ...COMMERCIAL_NEED, id: "n1", commercial: undefined }] }, split: reading }, decision), port = knowledge();
    const result = await runSmartTurn(mail(PURE_COMMERCIAL), ports(model, port, { commercialSplit: true }));
    expect(result.outcome).toBe("handoff");
    expect(result.sensitiveStop).toBeNull();
    expect(port.asked).toHaveLength(0);
    expect(result.decision?.coverage).toEqual([{ needId: "n1", status: "handed" }]);
    expect(result.teamNoteText).toContain(SAV_SMART_COMMERCIAL_ROUTE);
    // Off, the same mail stays sensitive (today's reading).
    const off = await runSmartTurn(mail(PURE_COMMERCIAL), ports(model, knowledge()));
    expect(off.outcome).toBe("team_sensitive");
  });

  it.each([
    ["Je veux passer à l'offre Business.", "abonnement", "subscription"],
    ["Remboursez-moi le mois dernier, s'il vous plaît.", "remboursement", "finance"],
    ["Je souhaite résilier mon abonnement.", "resiliation", "cancellation"],
    ["Pouvez-vous changer ma facturation en mensuel ?", "facturation", "finance"],
  ])("allumé, « %s » reste sensible : tout le mail à l'équipe, aucune fiche, aucune décision", async (body, famille, family) => {
    const sensitive = { needs: [{ id: "n1", ask: body, alreadyDone: [], theme: null, search: null }], sensitive: "yes", sensitiveFamilies: [family],
      sensible: { famille, preuve: body }, wantsHuman: false, upset: false, instructionInMail: false };
    const { model, calls } = brain({ today: sensitive, split: sensitive }, decisionWith("handed", null)), port = knowledge();
    const result = await runSmartTurn(mail(body), ports(model, port, { commercialSplit: true }));
    expect(result.outcome).toBe("team_sensitive");
    expect(result.sensitiveStop).toBe("understand");
    expect(result.reasons).toContain(`understand:sensible_${famille}`);
    expect(port.asked).toHaveLength(0);
    expect(calls.map(call => call.kind)).toEqual(["understand"]);
    expect(result.teamNoteText).toContain("tout le mail est transmis à l'équipe");
  });

  it("allumé, garde-fou serveur : un besoin marqué commercial ne lève jamais la barrière si un seul champ dit sensible ou doute", async () => {
    for (const contradiction of [{ sensitive: "doubt" }, { sensitiveFamilies: ["subscription"] }, { sensible: { famille: "abonnement", preuve: "passer à l'offre" } }, { sensible: null }]) {
      const reading = { ...READING_SPLIT, ...contradiction };
      const { model } = brain({ today: reading, split: reading }, decisionWith("handed", null)), port = knowledge();
      const result = await runSmartTurn(mail(FIVE_QUESTIONS), ports(model, port, { commercialSplit: true }));
      expect(result.outcome, JSON.stringify(contradiction)).toBe("team_sensitive");
      expect(port.asked).toHaveLength(0);
      expect(result.teamNoteText).not.toContain(SAV_SMART_COMMERCIAL_ROUTE);
    }
  });

  it("éteint : une marque commercial écrite quand même par le modèle est ignorée ; le tour est identique à celui sans la marque", async () => {
    const unmarked = { ...READING_SPLIT, needs: [...SUPPORT_NEEDS, { ...COMMERCIAL_NEED, commercial: undefined }] };
    const run = async (reading: unknown) => {
      const { model, calls } = brain({ today: reading, split: reading }, decisionWith("handed", MODEL_NOTE)), port = knowledge();
      return { result: await runSmartTurn(mail(FIVE_QUESTIONS), ports(model, port)), calls, port };
    };
    const marked = await run(READING_SPLIT), plain = await run(unmarked);
    expect(marked.result).toEqual(plain.result);
    expect(marked.calls).toEqual(plain.calls);
    expect(marked.port.asked[0]!.map(need => need.id)).toEqual(["n1", "n2", "n3", "n4"]);
    expect(marked.result.reading?.needs.some(need => "commercial" in need)).toBe(false);
    expect(marked.result.teamNote?.besoin).toBe(MODEL_NOTE.besoin);
  });
});

// The production path: the circuit's provider reads the switch from the env (fictional case, no database).
const CIRCUIT_CARD = { id: CARD.cardId, contentVersionId: CARD.version, title: CARD.title, source: "fixture", verifiedAt: "2026-11-10T00:00:00Z", semanticScore: null,
  content: CARD.content, resolution: { steps: [] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } } as unknown as SavRetrievalCandidate;
const caseEvent = (id: string, version: number): CaseEvent => ({ id, caseId: "case-c", kind: "inbound_confirmed", dedupeKey: `inbound:${id}`, caseVersion: version, direction: "customer_inbound",
  occurredAt: "2026-11-25T21:00:00Z", sourceRef: { type: "email", id }, detail: null, createdAt: "2026-11-25T21:00:00Z" });
const circuitRequest = (): CaseInvestigationModelRequest => ({
  purpose: "decision", caseId: "case-c", caseVersion: 2, inputKey: "in:e1", call: 1, subjectKey: "s", callKey: "s:call1", caseBudgetKey: "sav-case:case-c",
  snapshot: { contractRevision: SAV_CASE_CONTRACT_REVISION, caseId: "case-c", ticketId: "t-c", threadIds: ["th-c"], version: 2, owner: "agent", phase: "queued", sensitivity: "none",
    createdAt: "2026-11-25T21:00:00Z", updatedAt: "2026-11-25T21:00:00Z", admissionInputVersion: 1, admission: { admission: "smart_support" },
    body: { ...emptyCaseBody(), openRequests: [{ id: "r1", family: "other", status: "open", openedAt: "2026-11-25T21:00:00Z" }] } } as unknown as CaseSnapshot,
  events: [caseEvent("m1", 1)], knowledge: [CIRCUIT_CARD], coverage: null, feedback: [], closure: [],
  customerContext: { latestMessage: { at: "2026-11-25T21:00:00Z", from: "customer", text: FIVE_QUESTIONS, truncated: false, subject: "Questions de démarrage", instructionLikeText: false },
    thread: [] } as unknown as CaseInvestigationModelRequest["customerContext"],
});
const circuit = (env: Record<string, string>) => {
  const { model, calls } = brain({ today: READING_TODAY, split: READING_SPLIT }, decisionWith("handed", MODEL_NOTE));
  return { calls, run: smartCaseDecisionProvider({ model, env: () => ({ SAV_V2_ENTRY_SMART: "on", ...env }), now: () => new Date("2026-11-25T21:20:00Z"), maxInputBytes: () => 200_000 }) };
};

describe("SAV_V2_SMART_COMMERCIAL_SPLIT dans le circuit V2 (fournisseur de décision)", () => {
  it("éteint : passation sensible de tout le mail, comme aujourd'hui", async () => {
    const { calls, run } = circuit({});
    const out = await run(circuitRequest());
    expect(calls[0]!.system).toBe(smartUnderstandPrompt());
    expect(out.result).toMatchObject({ status: "ok", output: { nextAction: { kind: "handoff", reason: "sensitive_request" } } });
  });

  it("allumé : passation ordinaire (non sensible) dont la note route la demande commerciale vers Sacha ; aucune réponse envoyée par ce chemin", async () => {
    const { calls, run } = circuit({ SAV_V2_SMART_COMMERCIAL_SPLIT: "on" });
    const out = await run(circuitRequest());
    expect(calls[0]!.system).toBe(smartUnderstandPrompt({ commercialSplit: true }));
    expect(out.result.status).toBe("ok");
    const proposal = (out.result as { output: { nextAction: { kind: string; reason: string; report: { need: string } }; reply?: unknown } }).output;
    expect(proposal.nextAction.kind).toBe("handoff");
    expect(proposal.nextAction.reason).not.toBe("sensitive_request");
    expect(proposal.nextAction.report.need.startsWith(SAV_SMART_COMMERCIAL_ROUTE)).toBe(true);
    expect(proposal.reply).toBeUndefined();
  });
});
