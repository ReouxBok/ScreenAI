import { describe, expect, it, vi } from "vitest";
import type { SavRetrievalCandidate } from "../request-retrieval";
import { savReplyFooter } from "../reply-format";
import { prepareCaseReplyText } from "./case-reply-outbound";
import {
  emptyCaseBody, SAV_CASE_ADMISSION_REVISION, SAV_CASE_CONTRACT_REVISION, smartSupportProvenance, SAV_SMART_ENTRY_POLICY_REVISION,
  type CaseAdmissionRecord, type CaseBody, type CaseEvent, type CaseSnapshot,
} from "./case-types";
import {
  runCaseInvestigation, type CaseInvestigationModelRequest, type CaseInvestigationPorts, type CaseInvestigationProgress, type CaseInvestigationRecord,
} from "./investigation-runner";
import { caseGeminiDecisionPreflight, caseGeminiDecisionProvider } from "./investigation-v2-providers";
import type { CaseV2ModelTransport } from "./investigation-v2-spend";
import { smartCaseDecisionProvider } from "./smart/smart-case-provider";
import { SAV_SMART_SUPPORT_STAMP } from "./smart-support-scope";
import { SMART_CONFORME, smartGoodDecision, smartReading, smartScriptedModel, type SmartScript } from "./smart/smart-test-doubles";
import type { SmartTurnResult } from "./smart/smart-agent";

/*
 * SAV-123 (N8): the smart brain in the REAL V2 decision path, end to end on in-memory ports: the production runner (`runCaseInvestigation`), the real
 * provider selection (`caseGeminiDecisionProvider`), the real validator (called by the runner), a scripted brain model and a fake Gemini network.
 * Fictional data only: no database, no key, no network, no effect. Every scenario counts the model calls of one turn (old brain vs smart). The pilot scope
 * port is wired as in production; a smart case is decided without it while the switch is on (`smart-support-scope.ts`). The passage to the send plan and
 * the person's approval are proven on PGlite in `smart-circuit.passage.flow.test.ts`.
 */

const ON = { SAV_V2_ENTRY_SMART: "on" } as const;
const policy = { revision: "synthetic", approvedBy: "20000000-0000-4000-8000-000000000004", approvedAt: "2026-11-01T00:00:00Z",
  transport: { model: "synthetic-model", embeddingModel: "synthetic-embedding", priceExpiresAt: "2027-01-01T00:00:00Z", maxInputTokens: 131072, maxOutputTokens: 1024, maxInputBytes: 100_000, embeddingMaxInputTokens: 2048, embeddingMaxTexts: 3, embeddingMaxTextBytes: 1024 },
  model: { dailyCapMicroUsd: 2_000_000, reserveMicroUsdPerCall: 200_000, microUsdPerMillionInputTokens: 1_000_000, microUsdPerMillionOutputTokens: 1_000_000 },
  embedding: { dailyCapMicroUsd: 2_000_000, reserveMicroUsdPerCall: 10_000, microUsdPerMillionInputTokens: 1_000_000 } };
const GEMINI_ENV = { SAV_V2_MODEL: "synthetic-model", SAV_V2_EMBEDDING_MODEL: "synthetic-embedding", SAV_V2_SPEND_POLICY_JSON: JSON.stringify(policy), SAV_V2_GEMINI_API_KEY: "synthetic-v2-key" };
const NOW = new Date("2026-11-21T08:00:00Z");

const card = (id: string, version: string, content: string, verifiedAt = "2026-11-10T00:00:00Z"): SavRetrievalCandidate => ({
  id, contentVersionId: version, title: `Fiche ${id}`, content, source: "fixture", verifiedAt, semanticScore: null, resolution: { steps: ["Étape synthétique"] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" },
}) as SavRetrievalCandidate;
const SHEET_CARD = card("fiche-sheet", "v2", "Pour remplir le Google Sheet, ouvrez l'onglet Intégrations puis reconnectez Google Sheets avec le compte propriétaire du fichier.");
const LOGIN_CARD = card("fiche-connexion", "v3", "Pour vous connecter, utilisez l'adresse e-mail de votre invitation. Si le code n'arrive pas, vérifiez le dossier des indésirables.");
/** A card the validator no longer accepts (checked more than 90 days ago): the brain may still cite it, the server refuses it. */
const STALE_CARD = card("fiche-connexion", "v3", LOGIN_CARD.content, "2025-01-01T00:00:00Z");

const request = { id: "r1", summary: "Demande support.", family: "other" as const, status: "open" as const, openedAt: "2026-11-21T07:50:00Z" };
const smartAdmission = (): CaseAdmissionRecord => ({ revision: SAV_CASE_ADMISSION_REVISION, target: "agent", reasons: [], nextStep: "none", families: ["other"], sensitivity: "none",
  policyRevision: SAV_SMART_ENTRY_POLICY_REVISION, admission: "smart_support", decidedAt: "2026-11-21T07:50:02Z", version: 2, inputVersion: 1,
  qualification: { requests: [{ requestId: "r1", family: "other", provenance: smartSupportProvenance("2026-11-21T07:50:00Z") }], identity: { status: "confirmed", source: { type: "email", id: "m1" } },
    crmContext: "complete", teamSignals: [] } });
const snapshotOf = (admission: CaseAdmissionRecord | null = smartAdmission(), body: Partial<CaseBody> = {}): CaseSnapshot => ({
  contractRevision: SAV_CASE_CONTRACT_REVISION, caseId: "case-1", ticketId: "ticket-1", threadIds: ["thread-1"], version: 2, owner: "agent", phase: "queued", sensitivity: "none",
  createdAt: "2026-11-21T07:50:01Z", updatedAt: "2026-11-21T07:50:01Z", body: { ...emptyCaseBody(), openRequests: [request], ...body } as CaseBody, admission, admissionInputVersion: 1,
});
const inbound: CaseEvent = { id: "e1", caseId: "case-1", kind: "inbound_confirmed", dedupeKey: "inbound:m1", caseVersion: 1, direction: "customer_inbound",
  occurredAt: "2026-11-21T07:50:00Z", sourceRef: { type: "email", id: "m1" }, detail: null, createdAt: "2026-11-21T07:50:01Z" };
const contextOf = (subject: string, text: string): NonNullable<CaseInvestigationModelRequest["customerContext"]> => ({
  revision: "sav-case-customer-context-2026-11-12.v1", notice: "DONNÉES CLIENT", latestMessage: { at: "2026-11-21T07:50:00Z", from: "customer", text, truncated: false, subject, instructionLikeText: false },
  thread: [], threadOmitted: 0, crm: null, missing: [] } as unknown as NonNullable<CaseInvestigationModelRequest["customerContext"]>);

type Run = { report: Awaited<ReturnType<typeof runCaseInvestigation>>; records: CaseInvestigationRecord[]; circuitCalls: CaseInvestigationModelRequest[]; brainCalls: Array<{ kind: string; payload: unknown }>;
  geminiCalls: number; turns: SmartTurnResult[] };

/** One pass of the production runner on in-memory ports, the decision chosen by the REAL provider selection. */
async function runTurn(options: { env: Record<string, string>; script?: SmartScript; mail: [string, string]; knowledge?: SavRetrievalCandidate[]; snapshot?: CaseSnapshot;
  policyRevision?: string; geminiOutput?: unknown; pilot?: false }): Promise<Run> {
  const env: Record<string, string> = { ...GEMINI_ENV, ...options.env }, snap = options.snapshot ?? snapshotOf(), knowledge = options.knowledge ?? [SHEET_CARD];
  const brain = smartScriptedModel(options.script ?? {}), turns: SmartTurnResult[] = [];
  const smart = smartCaseDecisionProvider({ model: brain.model, env: () => env, now: () => NOW, maxInputBytes: () => 100_000, observe: result => turns.push(result) });
  const network = vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(options.geminiOutput ?? {}) }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } }));
  const provider: CaseV2ModelTransport = caseGeminiDecisionProvider({ env: () => env, network, smart });
  const preflight = caseGeminiDecisionPreflight(() => env);
  const records: CaseInvestigationRecord[] = [], circuitCalls: CaseInvestigationModelRequest[] = [], progress = new Map<string, CaseInvestigationProgress>();
  const ports: CaseInvestigationPorts = {
    scope: { locale: "fr-FR", audience: "support" },
    pauseState: async () => "running",
    readCase: async () => ({ snapshot: snap, events: [inbound] }),
    // What N8 gives the actors under the switch: the smart entry's revision (`smart-entry.v1`).
    admissionPolicyRevision: async () => options.policyRevision ?? SAV_SMART_ENTRY_POLICY_REVISION,
    reevaluateAdmission: async () => "handed_off",
    claim: async () => ({ token: "lease-1", actionsPaused: false }),
    release: async () => {},
    knowledge: async () => knowledge,
    customerContext: async () => contextOf(options.mail[0], options.mail[1]),
    customerTexts: async () => ({ "email:m1": options.mail[1] }),
    revisions: async () => ({ rules: "rules", playbookId: "playbook", model: "synthetic-model", prompt: "prompt" }),
    callModel: async modelRequest => {
      circuitCalls.push(modelRequest);
      const refused = preflight(modelRequest);
      if (refused) return { status: "input_rejected", diagnostic: refused };
      return (await provider(modelRequest)).result;
    },
    progress: { load: async (caseId, key) => structuredClone(progress.get(`${caseId}:${key}`) ?? null), save: async (caseId, key, value) => { progress.set(`${caseId}:${key}`, structuredClone(value)); } },
    record: async record => { records.push(record); },
    now: () => NOW,
    readTicketOwner: async () => "v2",
    // The real runtime always wires the pilot scope port (`investigation-runtime.ts`: `deps.accessScope ?? (async () => null)`), and the factory the smart
    // switch (`investigation-v2-factory.ts`): both are wired here by default, as in production.
    ...(options.pilot === false ? {} : { accessScope: async () => null }),
    smartSupport: () => env.SAV_V2_ENTRY_SMART === "on",
  };
  const report = await runCaseInvestigation("case-1", "observe", ports);
  return { report, records, circuitCalls, brainCalls: brain.calls, geminiCalls: network.mock.calls.length, turns };
}

const decision = (record: CaseInvestigationRecord) => record.validation.outcome === "accepted" ? record.validation.decision : null;
const SHEET_REPLY = "Bonjour,\n\nVotre Google Sheet ne se remplit plus. Ouvrez l'onglet Intégrations puis reconnectez Google Sheets avec le compte propriétaire du fichier.\n\nSi cela bloque encore, dites-nous ce qui s'affiche.\n\nBelle journée.";
const sheetDecision = (extra: Record<string, unknown> = {}) => smartGoodDecision({ reply: SHEET_REPLY,
  facts: [{ sentence: "Ouvrez l'onglet Intégrations puis reconnectez Google Sheets avec le compte propriétaire du fichier.", needId: "n1", type: "fait_limova", sourceKind: "fiche",
    cardId: "fiche-sheet", version: "v2", excerpt: "ouvrez l'onglet Intégrations puis reconnectez Google Sheets avec le compte propriétaire du fichier" }], ...extra });
const sheetReading = smartReading({ needs: [{ id: "n1", ask: "faire remplir son Google Sheet", alreadyDone: [], theme: "intégrations", search: "google sheet ne se remplit pas" }] });
const SHEET_MAIL: [string, string] = ["Google Sheet vide", "Bonjour, mon agent ne remplit plus mon Google Sheet depuis hier. Merci de votre aide."];

describe("SAV-123 (N8) — interrupteur allumé : le cerveau smart décide, le circuit valide", () => {
  it("1. mail Google Sheet → réponse smart validée par le serveur et enregistrée comme décision du circuit (pied de page IA ajouté une seule fois, à l'envoi)", async () => {
    const run = await runTurn({ env: ON, mail: SHEET_MAIL, script: { understand: { output: sheetReading }, decide: { output: sheetDecision() }, verify: { output: SMART_CONFORME } } });
    expect(run.report).toMatchObject({ status: "recorded", outcome: "accepted", refusal: null, modelCalls: 1 });
    const accepted = decision(run.records[0]!)!;
    expect(accepted.nextAction).toMatchObject({ kind: "answer", requestIds: ["r1"], steps: [{ knowledge: { knowledgeId: "fiche-sheet", contentVersionId: "v2" } }] });
    expect(accepted.reply).toMatchObject({ text: SHEET_REPLY, citations: [{ knowledgeId: "fiche-sheet", contentVersionId: "v2" }] });
    // One brain, its 3 calls (understand, decide, verify); the old Gemini decision is never called.
    expect(run.brainCalls.map(call => call.kind)).toEqual(["understand", "decide", "verify"]);
    expect(run.geminiCalls).toBe(0);
    // The footer: absent from the decision, added exactly once by the circuit's outbound preparation.
    const footer = savReplyFooter("fr", "automated");
    expect(accepted.reply!.text).not.toContain(footer.trim().split("\n")[0]!);
    const sent = prepareCaseReplyText(accepted.reply!.text, "fr", "automated", "answer");
    expect(sent.split(footer.trim().split("\n")[0]!).length - 1).toBe(1);
  });

  it("2. mail énervé → passage à l'équipe avec la note smart dans le rapport (1 appel modèle)", async () => {
    const run = await runTurn({ env: ON, mail: ["Inadmissible", "C'est la troisième fois que j'écris, c'est inadmissible, je vais laisser un avis négatif partout."],
      script: { understand: { output: smartReading({ upset: true }) } } });
    expect(run.report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect(decision(run.records[0]!)!.nextAction).toMatchObject({ kind: "handoff", requestIds: ["r1"], report: { need: "se connecter à son espace" } });
    expect(run.turns[0]!.teamNote?.raison).toBe("upset");
    expect(run.brainCalls.map(call => call.kind)).toEqual(["understand"]);
    expect(run.geminiCalls).toBe(0);
  });

  it("3. question → une question validée (le J+2 la suit dans le circuit existant)", async () => {
    const reply = "Bonjour,\n\nPour vous aider, pouvez-vous nous dire quel message s'affiche quand l'agent essaie d'écrire dans le Google Sheet ?\n\nBelle journée.";
    const run = await runTurn({ env: ON, mail: SHEET_MAIL, script: { understand: { output: sheetReading }, verify: { output: SMART_CONFORME },
      decide: { output: { outcome: "ask", reply, teamNote: null, handoffReason: null, coverage: [{ needId: "n1", status: "asked" }], facts: [],
        memory: { question: "Quel message s'affiche quand l'agent écrit dans le Google Sheet ?" } } } } });
    expect(run.report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect(decision(run.records[0]!)!.nextAction).toMatchObject({ kind: "ask", questions: [{ requestId: "r1", text: "Quel message s'affiche quand l'agent écrit dans le Google Sheet ?" }] });
    expect(decision(run.records[0]!)!.reply!.text).toBe(reply);
  });

  it("4. « merci c'est réglé » → LIMITE : le cerveau écrit une courtoisie (banc 22/11), mais le circuit n'a pas d'issue « résolu » : sans fiche citée, le dossier part à l'équipe (pas de clôture)", async () => {
    const courtesy = { outcome: "reply", reply: "Bonjour,\n\nMerci pour votre retour, ravi que tout remarche !\n\nBelle journée.", teamNote: null, handoffReason: null, coverage: [], facts: [] };
    const run = await runTurn({ env: ON, mail: ["Re: Google Sheet vide", "Merci, c'est réglé, tout remarche !"],
      script: { understand: { output: smartReading({ needs: [] }) }, decide: { output: courtesy }, verify: { output: SMART_CONFORME } } });
    expect(run.turns[0]!.outcome).toBe("reply");
    expect(run.report).toMatchObject({ status: "recorded", outcome: "accepted", closure: null, modelCalls: 1 });
    expect(decision(run.records[0]!)!.nextAction.kind).toBe("handoff");
    expect(run.turns[0]!.reasons).toContain("understand:no_need");
  });

  it("5. deux refus du validateur → l'équipe : le 1er refus est rendu au cerveau une fois, pas de 3e tour", async () => {
    const run = await runTurn({ env: ON, mail: ["Connexion", "Bonjour, je n'arrive pas à me connecter, le code n'arrive pas."], knowledge: [STALE_CARD],
      script: { understand: { output: smartReading() }, decide: { output: smartGoodDecision() }, verify: { output: SMART_CONFORME } } });
    expect(run.report).toMatchObject({ status: "recorded", outcome: "needs_review", modelCalls: 2 });
    expect(run.records[0]!.refusalHandoff).toMatchObject({ reason: "decision_refused", refusals: 2 });
    expect(run.circuitCalls.map(call => call.feedback.length > 0)).toEqual([false, true]);
    // The refusal reached the brain as failed server checks, on the decide call of the second turn only.
    const decides = run.brainCalls.filter(call => call.kind === "decide").map(call => (call.payload as { serverRefusals?: Array<{ code: string }> }).serverRefusals ?? null);
    expect(decides[0]).toBeNull();
    expect(decides[1]!.map(row => row.code)).toEqual(expect.arrayContaining([run.records[0]!.refusal!.codes[0]!]));
    expect(run.brainCalls.map(call => call.kind)).toEqual(["understand", "decide", "verify", "understand", "decide", "verify"]);
    expect(run.geminiCalls).toBe(0);
  });

  it("7. mail mixte (support + résiliation) → l'équipe, sujet sensible, aucune réponse", async () => {
    const run = await runTurn({ env: ON, mail: ["Sheet et résiliation", "Mon Google Sheet ne se remplit plus. Et je veux résilier mon abonnement à la fin du mois."],
      script: { understand: { output: smartReading({ sensitive: "yes", sensitiveFamilies: ["cancellation"], sensible: { famille: "resiliation", preuve: "je veux résilier mon abonnement" } }) } } });
    expect(run.report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    const accepted = decision(run.records[0]!)!;
    expect(accepted.nextAction).toMatchObject({ kind: "handoff", reason: "sensitive_request" });
    expect(accepted.reply).toBeUndefined();
    expect(run.turns[0]!.outcome).toBe("team_sensitive");
  });
});

describe("SAV-123 (N8) — un seul cerveau par cas", () => {
  const OLD_OUTPUT = { caseVersion: 2, understanding: { requests: [{ id: "r1", summary: "Demande.", family: "other", status: "open" }], newFacts: [] },
    nextAction: { kind: "ask", questions: [{ text: "Quel message s'affiche ?", requestId: "r1", reducesUncertainty: "Savoir où cela échoue.", seeks: [{ kind: "observed_result" }] }] } };

  it("6. interrupteur éteint → l'ancien fournisseur Gemini répond (1 appel), le cerveau smart n'est jamais appelé", async () => {
    const run = await runTurn({ env: {}, mail: SHEET_MAIL, geminiOutput: OLD_OUTPUT, policyRevision: SAV_SMART_ENTRY_POLICY_REVISION, pilot: false,
      script: { understand: { output: sheetReading }, decide: { output: sheetDecision() }, verify: { output: SMART_CONFORME } } });
    expect(run.report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect(run.geminiCalls).toBe(1);
    expect(run.brainCalls).toEqual([]);
    expect(decision(run.records[0]!)!.nextAction.kind).toBe("ask");
  });

  it("interrupteur allumé, cas historique (sans admission smart) → toujours l'ancien fournisseur, jamais les deux", async () => {
    const history = { ...smartAdmission(), admission: undefined, policyRevision: "policy-r1" } as CaseAdmissionRecord;
    delete (history as { admission?: unknown }).admission;
    const run = await runTurn({ env: ON, mail: SHEET_MAIL, geminiOutput: OLD_OUTPUT, snapshot: snapshotOf(history), policyRevision: "policy-r1", pilot: false,
      script: { understand: { output: sheetReading }, decide: { output: sheetDecision() }, verify: { output: SMART_CONFORME } } });
    expect(run.report).toMatchObject({ status: "recorded", modelCalls: 1 });
    expect(run.geminiCalls).toBe(1);
    expect(run.brainCalls).toEqual([]);
  });

  it("vitesse : appels modèle d'un tour, ancien contre smart (modèle simulé)", async () => {
    const old = await runTurn({ env: {}, mail: SHEET_MAIL, geminiOutput: OLD_OUTPUT, pilot: false });
    const smart = await runTurn({ env: ON, mail: SHEET_MAIL, script: { understand: { output: sheetReading }, decide: { output: sheetDecision() }, verify: { output: SMART_CONFORME } } });
    const measured = { old: { circuit: old.circuitCalls.length, gemini: old.geminiCalls + old.brainCalls.length }, smart: { circuit: smart.circuitCalls.length, gemini: smart.geminiCalls + smart.brainCalls.length } };
    expect(measured).toEqual({ old: { circuit: 1, gemini: 1 }, smart: { circuit: 1, gemini: 3 } });
  });
});

describe("SAV-123 (N8) — sans périmètre pilote pour un cas smart, interrupteur allumé seulement", () => {
  it("port de périmètre branché (comme en production) + interrupteur allumé : le cas smart est décidé, la décision porte le tampon smart", async () => {
    const run = await runTurn({ env: ON, mail: SHEET_MAIL, script: { understand: { output: sheetReading }, decide: { output: sheetDecision() }, verify: { output: SMART_CONFORME } } });
    expect(run.report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect(run.records[0]!.accessScope).toEqual(SAV_SMART_SUPPORT_STAMP);
    expect(run.records[0]!.blockScopes).toBeUndefined();
  });

  it("interrupteur éteint, le même cas smart est écarté AVANT tout appel (block_scope_missing), comme avant N8", async () => {
    const run = await runTurn({ env: {}, mail: SHEET_MAIL, script: { understand: { output: sheetReading }, decide: { output: sheetDecision() }, verify: { output: SMART_CONFORME } } });
    expect(run.report).toMatchObject({ status: "skipped", reason: "block_scope_missing", detail: "smart-support:scope_missing", modelCalls: 0 });
    expect(run.brainCalls).toEqual([]);
    expect(run.geminiCalls).toBe(0);
  });

  it("un cas smart dont une demande ouverte n'est pas du bloc smart garde les contrôles pilotes (aucun appel)", async () => {
    const mixed = snapshotOf(smartAdmission(), { openRequests: [request, { ...request, id: "r2", family: "access" }] });
    const run = await runTurn({ env: ON, mail: SHEET_MAIL, snapshot: mixed, script: { understand: { output: sheetReading } } });
    expect(run.report).toMatchObject({ status: "skipped", modelCalls: 0 });
    expect(run.brainCalls).toEqual([]);
  });
});
