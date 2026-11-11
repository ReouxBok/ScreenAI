import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { finalReplyText } from "../../../../test/sav-case-reply-text";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
import { contentItems, contentVersions, knowledgeFamilies, knowledgeFamilyRevisions, knowledgeProjections } from "@/db/schema";
import { canonicalKnowledgeSchema } from "@/lib/knowledge/contracts";
import { createTemporaryIncidentReader, readRuntimeTemporaryIncidents, type IncidentProjection } from "@/lib/knowledge/temporary-incidents-runtime";
import { temporaryIncidentSchema } from "@/lib/knowledge/temporary-incidents";
import { readSavAgentPause } from "../intake/agent-pause";
import type { SavRetrievalBackend, SavRetrievalCandidate } from "../request-retrieval";
import { listCaseEvents, openCaseEvent } from "./case-store";
import { caseDedupeKey, caseRequestId, type CaseSnapshot, type KnowledgeRef } from "./case-types";
import { SAV_CASE_ACCESS_SCOPE_REVISION, type CaseAccessScope } from "./investigation-access-scope";
import { caseIncidentBindings, revalidateIncidentContext } from "./investigation-incidents";
import { incidentContext, type IncidentBinding, type IncidentContext } from "./investigation-incidents-contract";
import { caseGeminiDecisionProvider, caseInvestigationPrompt, prepareCaseGeminiDecisionRequest } from "./investigation-v2-providers";
import { expandInvestigationContext } from "./investigation-context-view";
import { caseDecisionDraft } from "./investigation-intent";
import { selectCaseKnowledge } from "./investigation-knowledge";
import { readCaseInvestigationProgress } from "./investigation-record";
import { latestInvestigationInput, runCaseInvestigation, type CaseInvestigationModelRequest, type CaseInvestigationModelResult } from "./investigation-runner";
import { caseInvestigationStorePorts } from "./investigation-store-ports";
import { pilotProvenanceGate, readPilotReplyProvenance } from "./pilot-passage-provenance";
import { caseCallLedgerAdapter } from "./investigation-call-ledger";
import { reserveSavCaseCall, markSavCaseCallDispatched, settleSavCaseCall, releaseSavCaseCall } from "./case-calls";

// Real migrated PostgreSQL-compatible DB, joins, retrieval selector, case store, runner and final provenance gate.
// External boundaries only: search index, owner, approved admission policy and model. No network or paid provider.
let f: Awaited<ReturnType<typeof createSavTestDb>>, clock: Date, seq = 9100000;
const STAFF = "20000000-0000-4000-8000-000000000079";
const POLICY = { revision: "syn-policy-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "syn-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: "2026-11-01T00:00:00Z" };
const ruled = (requestId: string) => ({ requestId, family: "access" as const, provenance: { kind: "qualified_rule" as const, ruleId: "syn-access", revision: "r1", at: POLICY.approvedAt } });
const qualified = (ids: string[]) => ({ requests: ids.map(ruled), identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "syn-contact" } }, crmContext: "complete" as const, teamSignals: [] });
const document = canonicalKnowledgeSchema.parse({ schemaVersion: 1, objective: "Connexion synthétique", applicability: "sav_only", locale: "fr-FR", prerequisites: [], expectedResult: "La connexion fonctionne.", exceptions: [], escalation: "Contacter l’équipe.", steps: [{ id: "login.open", userLabel: "Ouvrir la connexion", objective: "Accéder au compte", instruction: "Ouvrir la page de connexion.", expectedResult: "La page est affichée.", prerequisites: [], exceptions: [], escalation: "", variants: [] }] });
const incident = () => temporaryIncidentSchema.parse({ schemaVersion: 1, id: "syn-login-delay", revision: 1, title: "SYN délai de connexion", scope: { families: ["access"], productArea: "Connexion documentaire SYN" }, status: "active", knownSince: new Date(clock.getTime() - 3600000).toISOString(), validUntil: new Date(clock.getTime() + 86400000).toISOString(), infoToCollect: ["Le message affiché"], approvedReply: "Un délai de connexion est connu ; l’équipe suit le sujet.", fix: { level: "none", evidence: "" }, provenance: { source: "Déclaration interne synthétique", recordedAt: new Date(clock.getTime() - 3000000).toISOString() } });
type Seed = Awaited<ReturnType<typeof seed>>;
async function seed(value: unknown = incident(), reviewState = "approved") {
  const itemId = randomUUID(), versionId = randomUUID(), familyId = randomUUID(), revisionId = randomUUID();
  await f.db.insert(contentItems).values({ id: itemId, slug: `syn-${itemId}`, title: "Connexion SYN", type: "article", ownerEmail: "reviewer@example.invalid" });
  await f.db.insert(contentVersions).values({ id: versionId, itemId, version: 1, bodyMarkdown: "Connexion SYN", metadata: { intents: [], limovaPaths: [], prerequisites: [], expectedResult: "Connexion", troubleshooting: "" }, changeNote: "SYN", authorEmail: "reviewer@example.invalid" });
  await f.db.insert(knowledgeFamilies).values({ id: familyId, canonicalKey: `syn-${familyId}`, title: "Connexion SYN", createdBy: "reviewer@example.invalid", approvedRevisionId: revisionId });
  await f.db.insert(knowledgeFamilyRevisions).values({ id: revisionId, familyId, revision: 1, canonicalHash: `syn-hash-${revisionId}`, document: { ...document, ...(value === undefined ? {} : { temporaryIncident: value }) } as never, reviewState, reviewedBy: "ugo@limova.ai", reviewedAt: new Date(clock.getTime() - 60000) });
  await f.db.insert(knowledgeProjections).values({ familyId, revisionId, surface: "sav", itemId, versionId });
  const card: SavRetrievalCandidate = { id: itemId, contentVersionId: versionId, title: "Connexion SYN", content: "Ouvrir la page de connexion.", source: "fixture", verifiedAt: new Date(clock.getTime() - 86400000).toISOString(), semanticScore: null, resolution: { steps: ["Ouvrir la connexion"] }, availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } };
  return { itemId, versionId, familyId, revisionId, card, binding: { requestId: "syn-request", family: "access" as const, knowledgeId: itemId, contentVersionId: versionId } };
}
const scopeFor = (s: Seed): CaseAccessScope => ({ schema: SAV_CASE_ACCESS_SCOPE_REVISION, policyRevision: POLICY.revision, revision: "syn-scope-r1", family: "access", sources: [{ knowledgeId: s.itemId, contentVersionId: s.versionId, use: "answer" }] });
async function context(bindings: IncidentBinding[]) { const result = await readRuntimeTemporaryIncidents(bindings, clock); if (!result.ok) throw Error(result.problem); return result.context; }
async function accessCase() {
  const gmail = `syn-${randomUUID()}`, requestId = caseRequestId(gmail, "r1");
  return (await openCaseEvent({ ticketId: String(++seq), threadId: randomUUID(), admission: { policy: POLICY, qualification: qualified([requestId]) }, opens: [{ id: requestId, summary: "Connexion impossible", subject: { status: "available", text: "Connexion impossible à la plateforme", provenance: { source: "v1_accepted_analysis", field: "ticketSummary", runId: randomUUID(), runVersion: 1, resultHash: "syn-hash", validatorRevision: "syn-r1", acceptedAt: POLICY.approvedAt } } }], kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmail), sourceRef: { type: "email", id: gmail }, occurredAt: new Date().toISOString() })).case;
}
async function run(c: CaseSnapshot, s: Seed, options: { duringModel?: () => Promise<void>; owner?: "v2" | "human"; pause?: "fully_paused"; failed?: boolean; reply?: string; ledger?: { money: { count: number }; crashAfterSettle?: boolean; legacy?: boolean } } = {}) {
  const calls: CaseInvestigationModelRequest[] = [], scope = scopeFor(s);
  const backend: SavRetrievalBackend = { readRevision: async () => "syn-kb-r1", search: async queries => queries.map(() => [s.card]) };
  const ports = caseInvestigationStorePorts({ readTicketOwner: async () => options.owner ?? "v2", holder: "sav-v2-investigation", scope: { locale: "fr-FR", audience: "support" }, now: () => clock,
    pauseState: async () => options.pause ?? (await readSavAgentPause(f.db as never, "v2")).level,
    knowledge: snapshot => selectCaseKnowledge(snapshot, backend, { locale: "fr-FR", audience: "support", now: clock }), customerTexts: async (_caseId, refs) => Object.fromEntries(refs.map(ref => [`${ref.type}:${ref.id}`, "Bonjour, connexion impossible à mon compte."])), revisions: async () => ({ rules: "syn-r1", playbookId: "syn-p1", model: "syn-model", prompt: "syn-prompt" }),
    callModel: async request => { calls.push(structuredClone(request)); await options.duringModel?.(); if (options.failed) return { status: "failed", uncertain: true };
      const ref: KnowledgeRef = { knowledgeId: s.itemId, contentVersionId: s.versionId }, open = request.snapshot.body.openRequests.filter(row => row.status === "open");
      return { status: "ok", output: { caseVersion: request.snapshot.version, understanding: { requests: open.map(row => ({ id: row.id, summary: "Connexion impossible", family: "access", status: "open" })), newFacts: [] }, nextAction: { kind: "answer", requestIds: [open[0]!.id], steps: [{ text: "Ouvrir la page de connexion.", knowledge: ref }], expectedResult: "Le client se connecte." }, reply: { text: options.reply ?? "Bonjour, depuis https://new.limova.ai : un délai est connu ; l’équipe suit le sujet.", citations: [ref], impossibilityClaims: [], accountAdvice: "none" } } } satisfies CaseInvestigationModelResult;
    }, admissionPolicyRevision: async () => POLICY.revision, qualify: async (snapshot, events) => { const latest = events.filter(event => event.kind === "inbound_confirmed").at(-1); return latest ? { admission: { policy: POLICY, qualification: qualified(snapshot.body.openRequests.filter(row => row.status === "open").map(row => row.id)) }, sourceRef: latest.sourceRef } : null; } });
  const ledger = options.ledger;
  const callModel = ledger ? caseCallLedgerAdapter({ ledger: { reserve: reserveSavCaseCall, markDispatched: markSavCaseCallDispatched, release: releaseSavCaseCall,
    settle: async input => { const result = input.result.status === "ok" && ledger.legacy ? { ...input.result, output: (input.result.output as { output: unknown }).output } : input.result;
      await settleSavCaseCall({ ...input, result }); if (ledger.crashAfterSettle) throw Error("SYN_CRASH_AFTER_SETTLE"); } },
    money: async () => { ledger.money.count++; return { status: "allowed" }; }, provider: async request => {
      const result = await ports.callModel(request); if (result.status !== "ok" && result.status !== "failed") throw Error("SYN_PROVIDER_RESULT"); return result;
    }, holder: "syn-incidents", leaseSeconds: 60, maxPerSubject: 3 }) : ports.callModel;
  return { report: await runCaseInvestigation(c.caseId, "observe", { ...ports, callModel, accessScope: async () => scope, temporaryIncidents: readRuntimeTemporaryIncidents }), calls };
}
async function draftOf(c: CaseSnapshot, s: Seed) {
  const events = await listCaseEvents(c.caseId), read = readCaseInvestigationProgress(events, latestInvestigationInput(events)!);
  if (read.state !== "found") throw Error(`NO_RECORD:${read.state}`);
  const scope = scopeFor(s), draft = caseDecisionDraft(c.caseId, read.record, events, { accessScope: { revision: scope.revision, policyRevision: scope.policyRevision } });
  if (!draft?.reply || !draft.triggerEventId) throw Error("NO_DRAFT");
  return { proposal: { caseId: c.caseId, triggerEventId: draft.triggerEventId, ...draft.reply, text: finalReplyText(draft.reply.text) }, record: read.record };
}
const depsFor = (s: Seed) => ({ accessScope: async () => scopeFor(s), currentPolicyRevision: async () => POLICY.revision, readActiveSource: async () => ({ active: true, title: s.card.title, content: s.card.content, verifiedAt: s.card.verifiedAt! }), readTemporaryIncidents: readRuntimeTemporaryIncidents, now: () => clock });
const TRANSPORT_ENV = { SAV_V2_GEMINI_API_KEY: "synthetic-key", SAV_V2_MODEL: "synthetic-model", SAV_V2_EMBEDDING_MODEL: "synthetic-embedding", SAV_V2_SPEND_POLICY_JSON: JSON.stringify({ revision: "synthetic", approvedBy: STAFF, approvedAt: "2026-11-01T00:00:00Z", transport: { model: "synthetic-model", embeddingModel: "synthetic-embedding", priceExpiresAt: "2027-01-01T00:00:00Z", maxInputTokens: 42384, maxOutputTokens: 4096, maxInputBytes: 26000, embeddingMaxInputTokens: 2048, embeddingMaxTexts: 3, embeddingMaxTextBytes: 1792 }, model: { dailyCapMicroUsd: 197000, reserveMicroUsdPerCall: 48000, microUsdPerMillionInputTokens: 750000, microUsdPerMillionOutputTokens: 3750000 }, embedding: { dailyCapMicroUsd: 3000, reserveMicroUsdPerCall: 1000, microUsdPerMillionInputTokens: 150000 } }) };
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => { clock = new Date(Date.now() + 360000); vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-incident-runtime-test-key"); vi.stubEnv("SAV_CASE_RECORDING", "on"); vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); })); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("SAV-79 exact approved projection reader", () => {
  it("joins the exact selected SAV version and carries distinct canonical, approval and incident proofs", async () => {
    const s = await seed(), read = await context([s.binding]);
    expect(read).toMatchObject({ scope: "bound", entries: [{ grantsActions: false, fixLevel: "none", productArea: incident().scope.productArea, proof: { knowledgeId: s.itemId, contentVersionId: s.versionId, familyId: s.familyId, canonicalRevisionId: s.revisionId, incidentRevision: 1 } }] });
    expect(await context([{ ...s.binding, contentVersionId: randomUUID() }])).toMatchObject({ entries: [], scope: "scope_missing" });
  });
  it.each(["pending", "rejected"])("never applies a %s canonical revision", async review => { const s = await seed(incident(), review); expect((await context([s.binding])).entries).toEqual([]); });
  it("a newer pending revocation leaves the current approved projection intact", async () => {
    const s = await seed(), initial = await context([s.binding]);
    await f.db.insert(knowledgeFamilyRevisions).values({ familyId: s.familyId, revision: 2, canonicalHash: "syn-pending-revoke", reviewState: "pending", document: { ...document, temporaryIncident: { ...incident(), revision: 2, status: "revoked", revocation: { at: clock.toISOString(), reason: "Retrait SYN" } } } as never });
    expect(await context([s.binding])).toEqual(initial);
  });
  it.each(["expired", "future", "revoked", "family"])("does not apply %s data or resurrect a historical incident", async kind => {
    const value = incident();
    if (kind === "expired") { value.knownSince = new Date(clock.getTime() - 86400000).toISOString(); value.validUntil = clock.toISOString(); }
    if (kind === "future") { value.knownSince = new Date(clock.getTime() + 1000).toISOString(); }
    if (kind === "revoked") { value.status = "revoked"; value.revocation = { at: clock.toISOString(), reason: "Retrait SYN" }; }
    if (kind === "family") value.scope.families = ["usage"];
    const s = await seed(value); expect(await context([s.binding])).toMatchObject({ entries: [], scope: "not_applicable" });
    expect((await context([s.binding])).entries).toEqual([]);
  });
  it("refuses conflicts between two selected incident-bearing cards for one request", async () => {
    const first = await seed(), second = await seed({ ...incident(), id: "syn-other-delay", approvedReply: "Autre réponse approuvée SYN." });
    expect(await readRuntimeTemporaryIncidents([first.binding, second.binding], clock)).toEqual({ ok: false, problem: "conflict" });
  });
  it("canonical identity/hash and approval withdrawal invalidate even identical incident data", async () => {
    const s = await seed(), initial = await context([s.binding]);
    await f.db.update(knowledgeFamilyRevisions).set({ canonicalHash: "syn-new-hash" }).where(eq(knowledgeFamilyRevisions.id, s.revisionId));
    expect(await revalidateIncidentContext(initial, readRuntimeTemporaryIncidents, clock)).toBe(false);
    await f.db.update(knowledgeFamilies).set({ approvedRevisionId: null }).where(eq(knowledgeFamilies.id, s.familyId));
    expect((await context([s.binding])).scope).toBe("scope_missing");
  });
  it("bounds and failed reads close without truncation", async () => {
    const s = await seed();
    expect(await readRuntimeTemporaryIncidents(Array(19).fill(s.binding), clock)).toEqual({ ok: false, problem: "scope_limit" });
    expect(await createTemporaryIncidentReader(async () => { throw Error("SYN_DB_DOWN"); })([s.binding], clock)).toEqual({ ok: false, problem: "read_failed" });
    expect(await createTemporaryIncidentReader(async () => Array(19).fill({}) as IncidentProjection[])([s.binding], clock)).toEqual({ ok: false, problem: "scope_limit" });
  });
});

describe("SAV-79 runner and final reply gate composition", () => {
  it("injects only this admitted request's ANSWER card, records provenance and revalidates before reply", async () => {
    const s = await seed(), other = await seed({ ...incident(), id: "syn-unselected" }), c = await accessCase();
    const result = await run(c, s);
    expect(result.report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect(result.calls[0]?.temporaryIncidents?.entries).toHaveLength(1);
    expect(result.calls[0]?.temporaryIncidents?.entries[0]?.proof.knowledgeId).toBe(s.itemId);
    expect(JSON.stringify(result.calls[0]?.temporaryIncidents)).not.toContain(other.itemId);
    const { proposal, record } = await draftOf(c, s);
    expect((record.decision?.temporaryIncidents as IncidentContext).fingerprint).toBe(result.calls[0]?.temporaryIncidents?.fingerprint);
    expect(await readPilotReplyProvenance(proposal, depsFor(s))).toMatchObject({ status: "proven" });
    const selected = { requestId: c.body.openRequests[0]!.id, family: "access" as const, status: "covered" as const, knowledge: [{ knowledgeId: s.itemId, contentVersionId: s.versionId }], limitations: [] };
    expect(caseIncidentBindings(c, [s.card], [{ ...selected, requestId: "other-request" }], scopeFor(s), "fr-FR", "support", clock)).toEqual([]);
    expect(caseIncidentBindings(c, [s.card], [selected], { ...scopeFor(s), sources: [{ ...scopeFor(s).sources[0]!, use: "orient_only" }] }, "fr-FR", "support", clock)).toEqual([]);
  });
  it.each(["withdraw", "replace", "expire", "revoke"])("%s after generation refuses the final pre-dispatch provenance gate", async change => {
    const s = await seed(), c = await accessCase(); expect((await run(c, s)).report.status).toBe("recorded");
    const { proposal } = await draftOf(c, s);
    if (change === "withdraw") await f.db.update(knowledgeFamilies).set({ approvedRevisionId: null }).where(eq(knowledgeFamilies.id, s.familyId));
    if (change === "replace") { const id = randomUUID(); await f.db.insert(knowledgeFamilyRevisions).values({ id, familyId: s.familyId, revision: 2, canonicalHash: "syn-replacement", document: { ...document, temporaryIncident: incident() }, reviewState: "approved", reviewedBy: "ugo@limova.ai", reviewedAt: clock }); await f.db.update(knowledgeFamilies).set({ approvedRevisionId: id }).where(eq(knowledgeFamilies.id, s.familyId)); }
    if (change === "expire") clock = new Date(clock.getTime() + 86400001);
    if (change === "revoke") await f.db.update(knowledgeFamilyRevisions).set({ document: { ...document, temporaryIncident: { ...incident(), revision: 2, status: "revoked", revocation: { at: clock.toISOString(), reason: "Retrait SYN" } } } }).where(eq(knowledgeFamilyRevisions.id, s.revisionId));
    expect(await readPilotReplyProvenance(proposal, depsFor(s))).toMatchObject({ status: "unproven", reasons: ["temporary_incident_unproven"] });
    // This exact gate is the store/driver port, called by newWorkGuard before the external SDK.
    expect(await pilotProvenanceGate(depsFor(s))(proposal as never)).toBe("temporary_incident_unproven");
  });
  it("withdrawal during generation preserves paid attempt but records no accepted decision and never regenerates silently", async () => {
    const s = await seed(), c = await accessCase();
    expect((await run(c, s, { duringModel: async () => { await f.db.update(knowledgeFamilies).set({ approvedRevisionId: null }).where(eq(knowledgeFamilies.id, s.familyId)); } })).report).toMatchObject({ status: "knowledge_requeue", modelCalls: 1 });
    const again = await run(c, s); expect(again.calls).toHaveLength(0); expect(again.report).toMatchObject({ status: "knowledge_requeue", modelCalls: 1 });
    const resumed = await run(c, s); expect(resumed.calls).toHaveLength(1); expect(resumed.report).toMatchObject({ status: "recorded", modelCalls: 2 });
  });
  it("refuses an unproven fix announcement even when the normal Access decision was accepted", async () => {
    const s = await seed(), c = await accessCase();
    expect((await run(c, s, { reply: "Bonjour, depuis https://new.limova.ai : le problème est corrigé." })).report).toMatchObject({ status: "recorded", outcome: "accepted" });
    const { proposal } = await draftOf(c, s);
    expect(await readPilotReplyProvenance(proposal, depsFor(s))).toMatchObject({ status: "unproven", reasons: ["temporary_incident_claim_unproven"] });
  });
  it("missing projection keeps the existing Access path and sends no incident field to the model", async () => {
    const s = await seed(), c = await accessCase(); await f.db.delete(knowledgeProjections).where(eq(knowledgeProjections.familyId, s.familyId));
    const result = await run(c, s); expect(result.report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 }); expect(result.calls[0]).not.toHaveProperty("temporaryIncidents");
  });
  it.each(["pause", "human"])("preserves %s stops before model", async stop => {
    const s = await seed(), c = await accessCase(), result = await run(c, s, stop === "pause" ? { pause: "fully_paused" } : { owner: "human" }); expect(result.calls).toHaveLength(0); expect(result.report.status).not.toBe("recorded");
  });
  it("uncertain external model outcome stays counted and never becomes an incident response", async () => {
    const s = await seed(), c = await accessCase(), result = await run(c, s, { failed: true }); expect(result.calls).toHaveLength(1); expect(result.report).toMatchObject({ status: "usage_uncertain", modelCalls: 1 });
  });
});

describe("SAV-79 context transitions and crash-safe server receipts", () => {
  it("empty→applicable during generation invalidates the proposal, retains calls, then resumes with the next key", async () => {
    const s = await seed(incident(), "pending"), c = await accessCase();
    expect((await run(c, s, { duringModel: async () => { await f.db.update(knowledgeFamilyRevisions).set({ reviewState: "approved" }).where(eq(knowledgeFamilyRevisions.id, s.revisionId)); } })).report).toMatchObject({ status: "knowledge_requeue", modelCalls: 1 });
    expect((await run(c, s)).report).toMatchObject({ status: "knowledge_requeue", modelCalls: 1 });
    expect((await run(c, s)).report).toMatchObject({ status: "recorded", modelCalls: 2 });
    expect((await run(c, s)).report).toMatchObject({ status: "already_recorded", modelCalls: 2 });
  });
  it("an approval after a recorded empty read invalidates its prepared reply and reports explicit human review", async () => {
    const s = await seed(incident(), "pending"), c = await accessCase(); expect((await run(c, s)).report.status).toBe("recorded");
    const { proposal } = await draftOf(c, s);
    await f.db.update(knowledgeFamilyRevisions).set({ reviewState: "approved" }).where(eq(knowledgeFamilyRevisions.id, s.revisionId));
    expect(await readPilotReplyProvenance(proposal, depsFor(s))).toMatchObject({ status: "unproven", reasons: ["temporary_incident_unproven"] });
    const retry = await run(c, s); expect(retry.report).toMatchObject({ status: "incident_context_review", modelCalls: 1 }); expect(retry.calls).toHaveLength(0);
  });
  it.each(["hash", "remove", "add"])("crash after real ledger settle then %s never relabels the known result or repays it", async change => {
    const s = await seed(incident(), change === "add" ? "pending" : "approved"), c = await accessCase(), money = { count: 0 };
    await expect(run(c, s, { ledger: { money, crashAfterSettle: true } })).rejects.toThrow("SYN_CRASH_AFTER_SETTLE"); expect(money.count).toBe(1);
    if (change === "hash") await f.db.update(knowledgeFamilyRevisions).set({ canonicalHash: "syn-changed-after-settle" }).where(eq(knowledgeFamilyRevisions.id, s.revisionId));
    if (change === "remove") await f.db.update(knowledgeFamilies).set({ approvedRevisionId: null }).where(eq(knowledgeFamilies.id, s.familyId));
    if (change === "add") await f.db.update(knowledgeFamilyRevisions).set({ reviewState: "approved" }).where(eq(knowledgeFamilyRevisions.id, s.revisionId));
    const known = await run(c, s, { ledger: { money } }); expect(known.report).toMatchObject({ status: "knowledge_requeue", searchedRevision: "incident_context_unproven", modelCalls: 1 }); expect(known.calls).toHaveLength(0); expect(money.count).toBe(1);
    const fresh = await run(c, s, { ledger: { money } }); expect(fresh.report).toMatchObject({ status: "recorded", modelCalls: 2 }); expect(fresh.calls).toHaveLength(1); expect(money.count).toBe(2);
    expect((await run(c, s, { ledger: { money } })).report).toMatchObject({ status: "already_recorded", modelCalls: 2 }); expect(money.count).toBe(2);
  });
  it.each([false, true])("an unchanged settled result recovers after crash without another model/money call (legacy=%s, no incident)", async legacy => {
    const s = await seed(incident(), "pending"), c = await accessCase(), money = { count: 0 };
    await expect(run(c, s, { ledger: { money, crashAfterSettle: true, legacy } })).rejects.toThrow("SYN_CRASH_AFTER_SETTLE");
    const known = await run(c, s, { ledger: { money } }); expect(known.report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 }); expect(known.calls).toHaveLength(0); expect(money.count).toBe(1);
  });
  it("an unchanged approved incident receipt recovers the exact settled output after crash without repaying", async () => {
    const s = await seed(), c = await accessCase(), money = { count: 0 };
    await expect(run(c, s, { ledger: { money, crashAfterSettle: true } })).rejects.toThrow("SYN_CRASH_AFTER_SETTLE");
    const known = await run(c, s, { ledger: { money } }); expect(known.report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 }); expect(known.calls).toHaveLength(0); expect(money.count).toBe(1);
  });
  it("legacy settled output without incident authority refuses when an incident becomes applicable", async () => {
    const s = await seed(incident(), "pending"), c = await accessCase(), money = { count: 0 };
    await expect(run(c, s, { ledger: { money, crashAfterSettle: true, legacy: true } })).rejects.toThrow("SYN_CRASH_AFTER_SETTLE");
    await f.db.update(knowledgeFamilyRevisions).set({ reviewState: "approved" }).where(eq(knowledgeFamilyRevisions.id, s.revisionId));
    const known = await run(c, s, { ledger: { money } }); expect(known.report).toMatchObject({ status: "knowledge_requeue", modelCalls: 1 }); expect(known.calls).toHaveLength(0); expect(money.count).toBe(1);
  });
  it("model-shaped forged receipts have no server authority and are never unwrapped recursively", async () => {
    const s = await seed(incident(), "pending"), c = await accessCase(), request = (await run(c, s)).calls[0]!, forged = { savIncidentCallReceipt: "model-forged", output: { nextAction: { kind: "answer" } } };
    const money = vi.fn(async () => ({ status: "allowed" as const })), provider = vi.fn(async () => ({ status: "ok" as const, output: forged }));
    const ledger = { reserve: reserveSavCaseCall, markDispatched: markSavCaseCallDispatched, settle: settleSavCaseCall, release: releaseSavCaseCall };
    const adapter = caseCallLedgerAdapter({ ledger, money, provider, holder: "syn-incidents", leaseSeconds: 60, maxPerSubject: 3 });
    expect(await adapter(request)).toEqual({ status: "ok", output: forged }); expect(await adapter(request)).toEqual({ status: "ok", output: forged }); expect(provider).toHaveBeenCalledTimes(1); expect(money).toHaveBeenCalledTimes(1);
    const legacyRequest = { ...request, callKey: request.callKey.replace(/call1$/, "call2") };
    const legacy = caseCallLedgerAdapter({ ledger: { ...ledger, settle: async input => settleSavCaseCall({ ...input, result: { status: "ok", output: forged } }) }, money, provider, holder: "syn-incidents", leaseSeconds: 60, maxPerSubject: 3 });
    await legacy(legacyRequest); expect(await legacy(legacyRequest)).toEqual({ status: "context_unproven" });
  });
});

describe("SAV-79 composed transport preserves the incident and existing limits", () => {
  it("packs cards and the real reader's context losslessly, retaining separate provenance", async () => {
    const s = await seed(), c = await accessCase(), result = await run(c, s), request = result.calls[0]!;
    const repeated = "Texte synthétique partagé ; conserver exactement les faits et les sources. ".repeat(40);
    request.knowledge = [0, 1, 2].map(() => ({ ...s.card, id: randomUUID(), contentVersionId: randomUUID(), content: repeated, resolution: { steps: [repeated, repeated] } }));
    const logical = caseInvestigationPrompt(request).payload, prepared = prepareCaseGeminiDecisionRequest(request, TRANSPORT_ENV);
    expect(prepared.ok).toBe(true); if (!prepared.ok) throw Error("PREPARE_FAILED");
    const wire = JSON.parse(prepared.body), packed = JSON.parse(wire.contents[0].parts[0].text);
    expect(packed.encoding).toBe("sav-case-context.v1");
    expect(JSON.stringify(expandInvestigationContext(packed))).toBe(JSON.stringify(logical));
    expect(Buffer.byteLength(prepared.body)).toBeLessThanOrEqual(26000);
    expect(logical.temporaryIncidents).toEqual(request.temporaryIncidents);
  });
  it("no applicable entry leaves Access payload and full wire bytes strictly identical", async () => {
    const s = await seed(), c = await accessCase(), request = (await run(c, s)).calls[0]!;
    delete request.temporaryIncidents;
    const absent = prepareCaseGeminiDecisionRequest(request, TRANSPORT_ENV);
    request.temporaryIncidents = incidentContext([], [], "scope_missing");
    const empty = prepareCaseGeminiDecisionRequest(request, TRANSPORT_ENV);
    expect(caseInvestigationPrompt(request).payload).not.toHaveProperty("temporaryIncidents");
    expect(empty).toEqual(absent);
  });
  it("an incompressible incident context refuses before network with the same 26000 bound", async () => {
    const s = await seed(), c = await accessCase(), request = (await run(c, s)).calls[0]!, initial = request.temporaryIncidents!;
    const bindings = Array.from({ length: 18 }, (_, i) => ({ ...initial.bindings[0]!, requestId: `syn-${i}`, knowledgeId: randomUUID(), contentVersionId: randomUUID() }));
    const entries = bindings.map((binding, i) => ({ ...initial.entries[0]!, proof: { ...initial.entries[0]!.proof, requestId: binding.requestId, knowledgeId: binding.knowledgeId, contentVersionId: binding.contentVersionId }, reply: Array.from({ length: 30 }, (_, j) => createHash("sha256").update(`synthetic-${i}-${j}`).digest("hex")).join(" ") }));
    request.temporaryIncidents = incidentContext(bindings, entries, "bound");
    const prepared = prepareCaseGeminiDecisionRequest(request, TRANSPORT_ENV);
    expect(prepared).toMatchObject({ ok: false, diagnostic: { code: "input_too_large", networkAttempted: false, maxInputBytes: 26000 } });
    const network = vi.fn();
    expect(await caseGeminiDecisionProvider({ env: () => TRANSPORT_ENV, network })(request)).toMatchObject({ result: { status: "failed", uncertain: false, diagnostic: { code: "input_too_large", networkAttempted: false } } });
    expect(network).not.toHaveBeenCalled();
  });
});
