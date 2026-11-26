import { describe, expect, it, vi } from "vitest";
import type { SavRetrievalCandidate } from "../../request-retrieval";
import { emptyCaseBody, SAV_CASE_CONTRACT_REVISION, type CaseEvent, type CaseSnapshot } from "../case-types";
import {
  buildCaseCustomerAttachments, SAV_CASE_ATTACHMENT_LIMITS, SAV_CASE_ATTACHMENTS_INSTRUCTION, withCaseCustomerAttachments, type CaseCustomerAttachmentMedia,
} from "../investigation-customer-attachments";
import type { CaseCustomerContext } from "../investigation-customer-context";
import type { CaseInvestigationModelRequest } from "../investigation-runner";
import { grantSmartCaseAttachments, SAV_SMART_FILES_FACTS_NOTE, SAV_SMART_FILES_VERIFY_NOTE, type SmartFilesBudget } from "./smart-attachments";
import { smartCaseDecisionProvider, smartLiveSearchWithGuidance } from "./smart-case-provider";
import { smartCommercialNoRepeatVerdictSchema, smartCommercialVerdictSchema, smartNoRepeatVerdictSchema, smartVerdictSchema, smartVerdictSchemaFor } from "./smart-contract";
import type { SmartLiveSearch } from "./smart-live-search";
import { smartTurnPrompts } from "./smart-no-repeat";
import { SAV_SMART_PROMPT_SHA256, smartDecidePrompt, smartPromptSha256, smartUnderstandPrompt, smartVerifyPrompt } from "./smart-prompt";
import { SMART_CONFORME, smartGoodDecision, smartReading, smartScriptedModel, type SmartScript } from "./smart-test-doubles";

/*
 * Wave 2 (26/11): live search (`SAV_V2_SMART_LIVE_SEARCH`) and no-repeat (`SAV_V2_SMART_NO_REPEAT`) on top of wave 1 (images, commercial split).
 * Each switch alone keeps its own tests; here, what only exists when they meet. FICTIONAL cards, texts and bytes: no database, no key, no network.
 */

const CARD = { id: "fiche-connexion", contentVersionId: "v3", title: "Se connecter", source: "fixture", verifiedAt: "2026-11-10T00:00:00Z", semanticScore: null,
  content: "Pour vous connecter, utilisez l'adresse e-mail de votre invitation. Si le code n'arrive pas, vérifiez le dossier des indésirables.", resolution: { steps: ["Ouvrir la page"] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } } as SavRetrievalCandidate;
const LIVE_ESCALATION = "Si le code n'arrive toujours pas après deux essais : transmettre à un conseiller.";
const LIVE_EXCEPTION = "Compte créé par une invitation expirée : demander une nouvelle invitation.";
const LIVE = { ...CARD, id: "fiche-code-connexion", contentVersionId: "v1", title: "Le code de connexion n'arrive pas",
  content: "Le code de connexion arrive en moins de deux minutes. Vérifiez le dossier des indésirables puis redemandez un code.",
  resolution: { steps: [], escalation: LIVE_ESCALATION, exceptions: [LIVE_EXCEPTION] } } as SavRetrievalCandidate;
const SNAPSHOT = { contractRevision: SAV_CASE_CONTRACT_REVISION, caseId: "case-w2", ticketId: "t-w2", threadIds: ["th-w2"], version: 3, owner: "agent", phase: "queued", sensitivity: "none",
  createdAt: "2026-11-26T07:00:00Z", updatedAt: "2026-11-26T08:00:00Z", admissionInputVersion: 1, admission: { admission: "smart_support" },
  body: { ...emptyCaseBody(), openRequests: [{ id: "r1", family: "other", status: "open", openedAt: "2026-11-26T07:00:00Z" }] } } as unknown as CaseSnapshot;
const MAIL: CaseEvent = { id: "e2", caseId: "case-w2", kind: "inbound_confirmed", dedupeKey: "inbound:m2", caseVersion: 3, direction: "customer_inbound",
  occurredAt: "2026-11-26T08:00:00Z", sourceRef: { type: "email", id: "m2" }, detail: null, createdAt: "2026-11-26T08:00:00Z" };
/** Our reply already sent (turn 1), and turn 2's draft that copies it. */
const SENT = "Bonjour,\n\nPour vous connecter, utilisez l'adresse e-mail de votre invitation. Si le code n'arrive pas, vérifiez le dossier des indésirables de votre messagerie.\n\nQuel message s'affiche exactement sur votre écran de connexion ?\n\nBelle journée.";
const LATEST = "Toujours bloqué, je vous joins une capture de l'écran.";
const repeated = smartGoodDecision({ reply: SENT });
const handoff = { outcome: "handoff", reply: "Bonjour,\n\nMerci pour la capture. Je transmets votre demande à un conseiller, qui reviendra vers vous.\n\nBelle journée.",
  teamNote: { raison: "unsure", besoin: "Se connecter : le code n'arrive pas.", compris: "Le client a déjà vérifié les indésirables et joint une capture.", prochaineVerification: "Vérifier l'envoi du code." },
  handoffReason: "unsure", coverage: [{ needId: "n1", status: "handed" }], facts: [], memory: null };

const image = (hash: string): CaseCustomerAttachmentMedia => ({ mimeType: "image/png", bytes: Buffer.from(`fausse-image-${hash}`), hash, pages: null });
const contextOf = (images: boolean) => {
  const base = { latestMessage: { at: "2026-11-26T08:00:00Z", from: "customer", text: LATEST, truncated: false, subject: "Re: Connexion", instructionLikeText: false },
    thread: [{ at: "2026-11-26T07:00:00Z", from: "customer", text: "Bonjour, je n'arrive pas à me connecter, le code n'arrive pas.", truncated: false }] } as unknown as CaseCustomerContext;
  if (!images) return base;
  const built = withCaseCustomerAttachments(base, buildCaseCustomerAttachments([{ message: "latest", filename: "capture-ecran.png", mimeType: "image/png", size: 4096, reading: null,
    media: { ok: true, value: image("a") } }]));
  return grantSmartCaseAttachments(built, true);
};
const requestOf = (customerContext: CaseCustomerContext): CaseInvestigationModelRequest => ({
  purpose: "decision", caseId: "case-w2", caseVersion: 3, inputKey: "in:m2", call: 1, subjectKey: "s", callKey: "s:call1", caseBudgetKey: "sav-case:case-w2",
  snapshot: SNAPSHOT, events: [MAIL], knowledge: [CARD], coverage: null, feedback: [], closure: [], customerContext,
});
const budget: SmartFilesBudget = { reserveMicroUsd: 10_000_000, maxOutputTokens: 1_024, cost: usage => usage ? usage.inputTokens + usage.outputTokens : 10_000_000 };
const FIT = { model: "gemini-3.6-flash", mediaTokens: 3 * SAV_CASE_ATTACHMENT_LIMITS.imageTokens, budget };
const sourceOf = (card: SavRetrievalCandidate) => ({ cardId: card.id, version: card.contentVersionId, title: card.title, content: card.content, steps: [], needIds: ["n1"], validUntil: null });

describe("b. anti-répétition × recherche réelle : les consignes de la fiche suivent aussi une fiche trouvée en direct", () => {
  const search: SmartLiveSearch = async () => ({ status: "ok", codes: ["n1:candidates"], cards: [LIVE], sources: [sourceOf(LIVE)] });
  const script: SmartScript = {
    understand: { output: smartReading() },
    decide: [
      { output: { thinking: "Chercher une fiche plus précise.", action: "tools", calls: [{ id: "c1", tool: "chercher_fiches", needId: "n1", args: { recherche: "code de connexion non reçu" } }] } },
      { output: { thinking: "Passer la main.", action: "final", calls: [], decision: handoff } },
    ],
    verify: { output: SMART_CONFORME },
  };
  const run = async (env: Record<string, string>) => {
    const brain = smartScriptedModel(script), sentReplies = vi.fn(async () => [{ at: "2026-11-26T07:30:00Z", text: SENT }]);
    const provider = smartCaseDecisionProvider({ model: brain.model, env: () => ({ SAV_V2_ENTRY_SMART: "on", SAV_V2_SMART_LIVE_SEARCH: "on", ...env }), now: () => new Date("2026-11-26T08:05:00Z"),
      maxInputBytes: () => 100_000, sentReplies, liveSearch: () => search, liveFound: () => undefined });
    await provider(requestOf(contextOf(false)));
    const decides = brain.calls.filter(call => call.kind === "decide");
    return { second: JSON.stringify(decides[1]?.payload ?? null), sentReplies };
  };

  it("les deux allumés : la fiche trouvée en direct arrive au modèle avec son escalade et ses exceptions, sous « Consignes de la fiche »", async () => {
    const { second, sentReplies } = await run({ SAV_V2_SMART_NO_REPEAT: "on" });
    expect(sentReplies).toHaveBeenCalledWith("case-w2");
    expect(second).toContain(LIVE.id);
    expect(second).toContain(JSON.stringify(`${LIVE.content}\n\nConsignes de la fiche :\nEscalade : ${LIVE_ESCALATION}\nException : ${LIVE_EXCEPTION}`).slice(1, -1));
  });

  it("anti-répétition éteint : la fiche trouvée en direct arrive telle quelle (comportement de la recherche réelle seule)", async () => {
    const { second, sentReplies } = await run({});
    expect(sentReplies).not.toHaveBeenCalled();
    expect(second).toContain(LIVE.id);
    expect(second).not.toContain("Consignes de la fiche");
    expect(second).not.toContain(LIVE_ESCALATION);
  });

  it("l'habillage garde les cartes, les codes et le statut ; une source sans résolution structurée reste intacte", async () => {
    const bare = { ...LIVE, id: "fiche-sans-consigne", resolution: { steps: [] } } as SavRetrievalCandidate;
    const guided = await smartLiveSearchWithGuidance(async () => ({ status: "ok", codes: ["n1:candidates"], cards: [LIVE, bare], sources: [sourceOf(LIVE), sourceOf(bare)] }))([]);
    expect(guided.status).toBe("ok");
    expect(guided.codes).toEqual(["n1:candidates"]);
    expect(guided.cards).toEqual([LIVE, bare]);
    expect(guided.sources[0]!.content).toContain(`Escalade : ${LIVE_ESCALATION}`);
    expect(guided.sources[1]).toEqual(sourceOf(bare));
  });
});

describe("c. anti-répétition × prompt commercial × images : alreadySent et repeated_reply cohabitent", () => {
  const script: SmartScript = { understand: { output: smartReading() }, decide: { output: repeated }, verify: { output: SMART_CONFORME },
    correct: { output: handoff }, reverify: { output: SMART_CONFORME } };
  const run = async (env: Record<string, string>) => {
    const brain = smartScriptedModel(script), sentReplies = vi.fn(async () => [{ at: "2026-11-26T07:30:00Z", text: SENT }]);
    const provider = smartCaseDecisionProvider({ model: brain.model, env: () => ({ SAV_V2_ENTRY_SMART: "on", SAV_V2_SMART_COMMERCIAL_SPLIT: "on", ...env }),
      now: () => new Date("2026-11-26T08:05:00Z"), maxInputBytes: () => 100_000, sentReplies, attachmentFit: () => FIT });
    const out = await provider(requestOf(contextOf(true)));
    const call = (kind: string) => brain.calls.find(row => row.kind === kind);
    return { out, brain, call, sentReplies };
  };

  it("tout allumé : chaque appel garde le prompt commercial et l'instruction images, suivis de la partie anti-répétition ; la copie est refusée puis passée à l'équipe", async () => {
    const { out, call, sentReplies } = await run({ SAV_V2_SMART_NO_REPEAT: "on" });
    expect(sentReplies).toHaveBeenCalledWith("case-w2");
    const prompts = smartTurnPrompts(true, { commercialSplit: true });
    expect(prompts.understand.startsWith(smartUnderstandPrompt({ commercialSplit: true }))).toBe(true);
    expect(prompts.decide.startsWith(smartDecidePrompt({ commercialSplit: true }))).toBe(true);
    expect(call("understand")!.system).toBe(`${prompts.understand}\n\n${SAV_CASE_ATTACHMENTS_INSTRUCTION}`);
    expect(call("decide")!.system).toBe(`${prompts.decide}\n\n${SAV_CASE_ATTACHMENTS_INSTRUCTION}\n\n${SAV_SMART_FILES_FACTS_NOTE}`);
    expect(call("verify")!.system).toBe(`${prompts.verify}\n\n${SAV_SMART_FILES_VERIFY_NOTE}`);
    expect(call("correct")!.system).toBe(`${prompts.correct}\n\n${SAV_SMART_FILES_FACTS_NOTE}`);
    // The commercial line keeps number 13; the no-repeat line follows it as 14 (never two lines numbered 13).
    expect(call("verify")!.system).toContain("\n13. commercial_in_reply");
    expect(call("verify")!.system).toContain("\n14. repeated_reply");
    expect(call("verify")!.system).not.toContain("13. repeated_reply");
    // Payloads: the files' view where it belongs, alreadySent everywhere.
    for (const kind of ["understand", "decide"]) expect(call(kind)!.payload).toMatchObject({ customerContext: expect.any(Object), alreadySent: [{ texte: SENT, reponseDuClient: LATEST }] });
    expect(call("verify")!.payload).toMatchObject({ customerFiles: { count: 1, ids: ["pj1"] }, alreadySent: [{ texte: SENT }] });
    expect(call("verify")!.payload).not.toHaveProperty("customerContext");
    expect(call("correct")!.payload).not.toHaveProperty("customerContext");
    expect((call("correct")!.payload as { problems: unknown[] }).problems).toEqual(expect.arrayContaining([{ code: "repeated_reply", sentence: expect.any(String) }]));
    expect(out.result).toMatchObject({ status: "ok", output: { nextAction: { kind: "handoff" } } });
  });

  it("anti-répétition éteint (commercial et images allumés) : les appels de la vague 1, octet pour octet, sans alreadySent ni lecture des envois", async () => {
    const { out, brain, call, sentReplies } = await run({});
    expect(sentReplies).not.toHaveBeenCalled();
    expect(call("understand")!.system).toBe(`${smartUnderstandPrompt({ commercialSplit: true })}\n\n${SAV_CASE_ATTACHMENTS_INSTRUCTION}`);
    expect(call("verify")!.system).toBe(`${smartVerifyPrompt({ commercialSplit: true })}\n\n${SAV_SMART_FILES_VERIFY_NOTE}`);
    expect(call("verify")!.system).not.toContain("repeated_reply");
    for (const row of brain.calls) expect(JSON.stringify(row.payload)).not.toContain("alreadySent");
    expect(brain.calls.map(row => row.kind)).toEqual(["understand", "decide", "verify"]);
    expect(out.result).toMatchObject({ status: "ok", output: { nextAction: { kind: "answer" } } });
  });

  it("schéma de la contre-lecture : celui d'aujourd'hui quand les deux interrupteurs sont éteints ; repeated_reply n'est lu que si l'anti-répétition est allumé", () => {
    expect(smartVerdictSchemaFor({})).toBe(smartVerdictSchema);
    expect(smartVerdictSchemaFor({ commercialSplit: true })).toBe(smartCommercialVerdictSchema);
    expect(smartVerdictSchemaFor({ noRepeat: true })).toBe(smartNoRepeatVerdictSchema);
    expect(smartVerdictSchemaFor({ commercialSplit: true, noRepeat: true })).toBe(smartCommercialNoRepeatVerdictSchema);
    const both = [{ code: "repeated_reply", sentence: "x" }, { code: "commercial_in_reply", sentence: "y" }];
    const codes = (schema: ReturnType<typeof smartVerdictSchemaFor>) => schema.parse({ verdict: "non_conforme", problems: both }).problems.map(row => row.code);
    expect(codes(smartVerdictSchema)).toEqual(["unlisted_claim", "unlisted_claim"]);
    expect(codes(smartCommercialVerdictSchema)).toEqual(["unlisted_claim", "commercial_in_reply"]);
    expect(codes(smartNoRepeatVerdictSchema)).toEqual(["repeated_reply", "unlisted_claim"]);
    expect(codes(smartCommercialNoRepeatVerdictSchema)).toEqual(["repeated_reply", "commercial_in_reply"]);
  });

  it("empreinte des prompts éteints inchangée (eb8f8f00…)", () => {
    expect(smartPromptSha256()).toBe(SAV_SMART_PROMPT_SHA256);
    expect(SAV_SMART_PROMPT_SHA256.startsWith("eb8f8f00")).toBe(true);
    expect(smartTurnPrompts(false)).toEqual(smartTurnPrompts(false, {}));
  });
});
