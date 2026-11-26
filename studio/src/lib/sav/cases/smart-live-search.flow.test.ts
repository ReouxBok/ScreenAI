import { describe, expect, it, vi } from "vitest";
import type { SavRetrievalCandidate } from "../request-retrieval";
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
import { createSmartLiveFoundRegistry, savV2SmartLiveSearchOn, type SmartLiveSearch } from "./smart/smart-live-search";
import { SMART_CONFORME, smartGoodDecision, smartReading, smartScriptedModel, type SmartScript } from "./smart/smart-test-doubles";
import type { SmartCaseTrace } from "./smart/smart-trace";

/*
 * Live search (26/11), the real case of 26/11 rewritten with FICTIONAL cards and words: « on ne retrouve plus nos agents créés depuis Limova 3 », we asked
 * « agent téléphonique ou chatbot ? », the customer answers « oui, les agents que j'avais créés ». At turn 2 the brain calls
 * `chercher_fiches("recréer agent téléphonique Limova 3")`. Production runner, real provider selection, real validator, in-memory ports, scripted model.
 * No database, no key, no network, no effect.
 */

const policy = { revision: "synthetic", approvedBy: "20000000-0000-4000-8000-000000000004", approvedAt: "2026-11-01T00:00:00Z",
  transport: { model: "synthetic-model", embeddingModel: "synthetic-embedding", priceExpiresAt: "2027-01-01T00:00:00Z", maxInputTokens: 131072, maxOutputTokens: 1024, maxInputBytes: 100_000, embeddingMaxInputTokens: 2048, embeddingMaxTexts: 3, embeddingMaxTextBytes: 1024 },
  model: { dailyCapMicroUsd: 2_000_000, reserveMicroUsdPerCall: 200_000, microUsdPerMillionInputTokens: 1_000_000, microUsdPerMillionOutputTokens: 1_000_000 },
  embedding: { dailyCapMicroUsd: 2_000_000, reserveMicroUsdPerCall: 10_000, microUsdPerMillionInputTokens: 1_000_000 } };
const BASE_ENV = { SAV_V2_MODEL: "synthetic-model", SAV_V2_EMBEDDING_MODEL: "synthetic-embedding", SAV_V2_SPEND_POLICY_JSON: JSON.stringify(policy), SAV_V2_GEMINI_API_KEY: "synthetic-v2-key", SAV_V2_ENTRY_SMART: "on" };
const NOW = new Date("2026-11-26T09:00:00Z");

const card = (id: string, version: string, title: string, content: string): SavRetrievalCandidate => ({
  id, contentVersionId: version, title, content, source: "fixture", verifiedAt: "2026-11-20T00:00:00Z", semanticScore: null, resolution: { steps: ["Étape fictive"] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" },
});
/** The circuit's first card, found from the first mail. */
const MIGRATION = card("fiche-migration-l3", "v4", "Passage à Limova 3 : ce qui change", "Limova 3 regroupe les assistants dans un nouvel espace. Les anciens raccourcis ne sont plus affichés.");
/** The card the reply needs, distinct from the first one: only a real search with the model's words reaches it. */
const AGENT = card("fiche-agent-telephonique", "v2", "Passage à Limova 3 : retrouver un agent téléphonique ou un chatbot",
  "Depuis le passage à Limova 3, les agents téléphoniques se retrouvent dans l'onglet Agents. Pour en recréer un, cliquez sur Nouvel agent puis choisissez Agent téléphonique.");

const QUERY = "recréer agent téléphonique Limova 3";
const REPLY = "Bonjour,\n\nDepuis le passage à Limova 3, vos agents téléphoniques se retrouvent dans l'onglet Agents. Pour en recréer un, cliquez sur Nouvel agent puis choisissez Agent téléphonique.\n\nSi cela bloque encore, dites-nous ce qui s'affiche.\n\nBelle journée.";
const agentDecision = () => smartGoodDecision({ reply: REPLY, facts: [{ sentence: "Cliquez sur Nouvel agent puis choisissez Agent téléphonique.", needId: "n1", type: "fait_limova", sourceKind: "fiche",
  cardId: AGENT.id, version: AGENT.contentVersionId, excerpt: "cliquez sur Nouvel agent puis choisissez Agent téléphonique" }] });
const reading = smartReading({ needs: [{ id: "n1", ask: "retrouver ou recréer ses agents téléphoniques depuis Limova 3", alreadyDone: [], theme: "agents", search: "agents disparus Limova 3" }] });
const script = (): SmartScript => ({
  understand: { output: reading },
  decide: [
    { output: { thinking: "La fiche donnée ne dit pas comment recréer un agent téléphonique.", action: "tools", calls: [{ id: "c1", tool: "chercher_fiches", needId: "n1", args: { recherche: QUERY } }] } },
    { output: { thinking: "La fiche trouvée répond.", action: "final", calls: [], decision: agentDecision() } },
  ],
  verify: { output: SMART_CONFORME },
});

const request = { id: "r1", summary: "Demande support.", family: "other" as const, status: "open" as const, openedAt: "2026-11-26T08:50:00Z" };
const admission = (): CaseAdmissionRecord => ({ revision: SAV_CASE_ADMISSION_REVISION, target: "agent", reasons: [], nextStep: "none", families: ["other"], sensitivity: "none",
  policyRevision: SAV_SMART_ENTRY_POLICY_REVISION, admission: "smart_support", decidedAt: "2026-11-26T08:50:02Z", version: 2, inputVersion: 1,
  qualification: { requests: [{ requestId: "r1", family: "other", provenance: smartSupportProvenance("2026-11-26T08:50:00Z") }], identity: { status: "confirmed", source: { type: "email", id: "m1" } },
    crmContext: "complete", teamSignals: [] } });
const snapshot: CaseSnapshot = { contractRevision: SAV_CASE_CONTRACT_REVISION, caseId: "case-1", ticketId: "ticket-1", threadIds: ["thread-1"], version: 2, owner: "agent", phase: "queued",
  sensitivity: "none", createdAt: "2026-11-26T08:50:01Z", updatedAt: "2026-11-26T08:50:01Z", body: { ...emptyCaseBody(), openRequests: [request] } as CaseBody, admission: admission(), admissionInputVersion: 1 };
const inbound: CaseEvent = { id: "e1", caseId: "case-1", kind: "inbound_confirmed", dedupeKey: "inbound:m1", caseVersion: 1, direction: "customer_inbound",
  occurredAt: "2026-11-26T08:50:00Z", sourceRef: { type: "email", id: "m1" }, detail: null, createdAt: "2026-11-26T08:50:01Z" };
const LATEST = "Oui, les agents que j'avais créés.";
const customerContext = { revision: "sav-case-customer-context-2026-11-12.v1", notice: "DONNÉES CLIENT",
  latestMessage: { at: "2026-11-26T08:50:00Z", from: "customer", text: LATEST, truncated: false, subject: "Re: Agents introuvables", instructionLikeText: false },
  thread: [
    { at: "2026-11-25T08:00:00Z", from: "customer", text: "Bonjour, on ne retrouve plus nos agents créés depuis Limova 3.", truncated: false },
    { at: "2026-11-25T09:00:00Z", from: "support", text: "Bonjour, s'agit-il d'un agent téléphonique ou d'un chatbot ?", truncated: false },
  ], threadOmitted: 0, crm: null, missing: [] } as unknown as NonNullable<CaseInvestigationModelRequest["customerContext"]>;

async function runCase(options: { live: boolean; search?: SmartLiveSearch; proven?: SavRetrievalCandidate[]; selection?: boolean }) {
  const env: Record<string, string> = { ...BASE_ENV, ...(options.live ? { SAV_V2_SMART_LIVE_SEARCH: "on" } : {}) };
  const brain = smartScriptedModel(script()), registry = createSmartLiveFoundRegistry(), traces: SmartCaseTrace[] = [];
  const searched: string[] = [], customerWords: Array<string | undefined> = [], exactReads: string[][] = [];
  const search: SmartLiveSearch = options.search ?? (async needs => {
    searched.push(needs[0]!.search ?? "");
    const cards = [MIGRATION, AGENT];
    return { status: "ok", codes: ["n1:candidates"], cards, sources: cards.map(row => ({ cardId: row.id, version: row.contentVersionId, title: row.title, content: row.content, steps: [], needIds: ["n1"], validUntil: null })) };
  });
  const smart = smartCaseDecisionProvider({ model: brain.model, env: () => env, now: () => NOW, maxInputBytes: () => 100_000, trace: trace => { traces.push(trace); },
    liveSearch: () => search, liveFound: registry.put });
  const network = vi.fn(async () => Response.json({}));
  const provider: CaseV2ModelTransport = caseGeminiDecisionProvider({ env: () => env, network, smart });
  const preflight = caseGeminiDecisionPreflight(() => env);
  const records: CaseInvestigationRecord[] = [], progress = new Map<string, CaseInvestigationProgress>();
  const ports: CaseInvestigationPorts = {
    scope: { locale: "fr-FR", audience: "support" },
    pauseState: async () => "running",
    readCase: async () => ({ snapshot, events: [inbound] }),
    admissionPolicyRevision: async () => SAV_SMART_ENTRY_POLICY_REVISION,
    reevaluateAdmission: async () => "handed_off",
    claim: async () => ({ token: "lease-1", actionsPaused: false }),
    release: async () => {},
    // `selection`: the production shape (`selectCaseKnowledge`), each open request with the cards retrieved for it (`knowledge_not_linked_to_request`).
    knowledge: async (_snapshot, context) => {
      customerWords.push(context?.customerWords ?? undefined);
      return options.selection ? { status: "ready", selection: { revision: null, cards: [MIGRATION], alerts: [],
        coverage: [{ requestId: "r1", family: "other", status: "covered", knowledge: [{ knowledgeId: MIGRATION.id, contentVersionId: "v4" }], limitations: ["customer_words_searched"] }] } } : [MIGRATION];
    },
    customerContext: async () => customerContext,
    customerTexts: async () => ({ "email:m1": LATEST }),
    revisions: async () => ({ rules: "rules", playbookId: "playbook", model: "synthetic-model", prompt: "prompt" }),
    callModel: async modelRequest => {
      const refused = preflight(modelRequest);
      if (refused) return { status: "input_rejected", diagnostic: refused };
      return (await provider(modelRequest)).result;
    },
    progress: { load: async (caseId, key) => structuredClone(progress.get(`${caseId}:${key}`) ?? null), save: async (caseId, key, value) => { progress.set(`${caseId}:${key}`, structuredClone(value)); } },
    record: async record => { records.push(record); },
    now: () => NOW,
    readTicketOwner: async () => "v2",
    accessScope: async () => null,
    smartSupport: () => true,
    readScopeCards: async refs => { exactReads.push(refs.map(ref => ref.knowledgeId)); return (options.proven ?? [AGENT]).filter(row => refs.some(ref => ref.knowledgeId === row.id && ref.contentVersionId === row.contentVersionId)); },
    smartLiveSearch: { on: () => savV2SmartLiveSearchOn(env), take: registry.take },
  };
  const report = await runCaseInvestigation("case-1", "observe", ports);
  const toolPayload = brain.calls.filter(call => call.kind === "decide")[1]?.payload as { toolResults?: Array<{ status: string; cards?: Array<{ cardId: string }> }> } | undefined;
  return { report, records, searched, customerWords, exactReads, traces, toolResults: toolPayload?.toolResults ?? [], geminiCalls: network.mock.calls.length };
}
const accepted = (record: CaseInvestigationRecord | undefined) => record?.validation.outcome === "accepted" ? record.validation.decision : null;

describe("Recherche réelle — chercher_fiches cherche vraiment en production (SAV_V2_SMART_LIVE_SEARCH=on)", () => {
  it("cas réel fictif : au tour 2, la recherche du modèle trouve la fiche attendue (distincte de la fiche initiale), il la cite et le circuit l'accepte", async () => {
    const run = await runCase({ live: true });
    expect(run.searched).toEqual([QUERY]);
    // The tool result gives the NEW card only (the circuit's card is already in hand).
    expect(run.toolResults).toMatchObject([{ status: "ok", cards: [{ cardId: AGENT.id }] }]);
    expect(run.report).toMatchObject({ status: "recorded", outcome: "accepted", refusal: null, modelCalls: 1 });
    const decision = accepted(run.records[0])!;
    expect(decision.nextAction).toMatchObject({ kind: "answer", requestIds: ["r1"], steps: [{ knowledge: { knowledgeId: AGENT.id, contentVersionId: "v2" } }] });
    expect(decision.reply).toMatchObject({ text: REPLY, citations: [{ knowledgeId: AGENT.id, contentVersionId: "v2" }] });
    // The runner proved the card itself, at its exact version, before the validator read it; the record keeps it with its coverage.
    expect(run.exactReads).toEqual([[AGENT.id]]);
    expect(run.records[0]!.knowledge).toEqual([{ knowledgeId: MIGRATION.id, contentVersionId: "v4" }, { knowledgeId: AGENT.id, contentVersionId: "v2" }]);
    expect(run.records[0]!.coverage).toBeNull();
    expect(run.geminiCalls).toBe(0);
    // Trace: the tool search with its words, cards and codes.
    expect(run.traces[0]!.searches).toMatchObject([
      { kind: "initial", status: "ok", codes: ["circuit_cards"], found: [{ needId: "n1", cards: [{ id: MIGRATION.id }] }] },
      { kind: "tool", status: "ok", query: QUERY, found: [{ needId: "n1", cards: [{ id: AGENT.id, title: AGENT.title }] }] },
    ]);
    expect(run.traces[0]!.searches[1]!.codes).toEqual(expect.arrayContaining(["live_search", "live_search_known_cards"]));
    expect(run.traces[0]!.cited).toEqual([{ id: AGENT.id, version: "v2", title: AGENT.title }]);
  });

  it("forme de production (couverture par demande) : la carte prouvée rejoint la couverture de la demande, sans changer son statut, et passe le lien carte ↔ demande", async () => {
    const run = await runCase({ live: true, selection: true });
    expect(run.report).toMatchObject({ status: "recorded", outcome: "accepted", refusal: null });
    expect(accepted(run.records[0])!.reply).toMatchObject({ citations: [{ knowledgeId: AGENT.id, contentVersionId: "v2" }] });
    expect(run.records[0]!.coverage).toEqual([{ requestId: "r1", status: "covered", knowledge: [{ knowledgeId: MIGRATION.id, contentVersionId: "v4" }, { knowledgeId: AGENT.id, contentVersionId: "v2" }],
      limitations: ["customer_words_searched", "smart_live_search"] }]);
  });

  it("aux tours de continuation, la première recherche du circuit lit aussi la question posée et le message d'avant", async () => {
    const run = await runCase({ live: true });
    expect(run.customerWords).toEqual(["Re: Agents introuvables Oui, les agents que j'avais créés. — Bonjour, s'agit-il d'un agent téléphonique ou d'un chatbot ? — Bonjour, on ne retrouve plus nos agents créés depuis Limova 3."]);
  });

  it("interrupteur éteint : ancien comportement strict (aucune recherche, cartes initiales rendues à l'outil, mots du dernier mail seulement, la carte non retrouvée n'est jamais citée)", async () => {
    const run = await runCase({ live: false });
    expect(run.searched).toEqual([]);
    expect(run.exactReads).toEqual([]);
    expect(run.customerWords).toEqual(["Re: Agents introuvables Oui, les agents que j'avais créés."]);
    expect(run.toolResults).toMatchObject([{ status: "ok", cards: [{ cardId: MIGRATION.id }] }]);
    expect(run.traces[0]!.searches[1]).not.toHaveProperty("query");
    expect(run.traces[0]!.searches[1]!.codes).toEqual(["circuit_cards"]);
    const decision = run.records[0] ? accepted(run.records[0]) : null;
    expect(decision?.reply?.citations ?? []).not.toContainEqual({ knowledgeId: AGENT.id, contentVersionId: "v2" });
  });

  it("une carte que le runner ne peut pas prouver à sa version exacte n'entre pas : jamais citée dans une décision acceptée", async () => {
    const run = await runCase({ live: true, proven: [] });
    expect(run.exactReads[0]).toEqual([AGENT.id]);
    for (const record of run.records) {
      expect(record.knowledge).not.toContainEqual({ knowledgeId: AGENT.id, contentVersionId: "v2" });
      expect(accepted(record)?.reply?.citations ?? []).not.toContainEqual({ knowledgeId: AGENT.id, contentVersionId: "v2" });
    }
  });

  it("échec de la recherche : dégradation propre vers les cartes initiales, code dans la trace, le tour continue", async () => {
    const run = await runCase({ live: true, search: async () => { throw Error("SEARCH_DOWN"); } });
    expect(run.toolResults).toMatchObject([{ status: "ok", cards: [{ cardId: MIGRATION.id }] }]);
    expect(run.traces[0]!.searches[1]!.codes).toEqual(expect.arrayContaining(["circuit_cards", "live_search_failed"]));
    expect(run.exactReads).toEqual([]);
  });
});
