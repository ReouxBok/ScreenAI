import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { fakeSlack } from "../../../../test/sav-handoff-fakes";
import { executionProvider } from "../../../../test/sav-intake-execution-provider";
const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("../hubspot-transport", async importOriginal => {
  const { virtualSavHubspotTransportModule } = await import("../../../../test/sav-virtual-hubspot-transport");
  return virtualSavHubspotTransportModule(await importOriginal<typeof import("../hubspot-transport")>());
});
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));
import { savCaseEffectExecutions, savCases, savMailboxes, savThreads, staffUsers } from "@/db/schema";
import { readSavAgentPause } from "../intake/agent-pause";
import { approveIntakeExecutionPolicy, type ExecutionPolicy } from "../intake/execution-policy";
import type { GmailRequest } from "../intake/execution-adapters";
import type { ExecutionOptions } from "../intake/execution-types";
import type { SavRetrievalBackend } from "../request-retrieval";
import type { CaseAdmissionInput } from "./admission-policy";
import { enqueueHandoffNotice, enqueueHandoffNotices, runHandoffNoticePass } from "./case-handoff-notice-store";
import { encryptSavPayload } from "../crypto";
import { HANDOFF_NOTICE_CONTRACT, HANDOFF_NOTICE_KEY_PREFIX, handoffNoticeFacts, type HandoffCrmReading, type HandoffReason } from "./case-handoff-notice";
import { enqueueHandoffStage, enqueueHandoffStages } from "./case-handoff-stage";
import { listCaseEvents, openCaseEvent, readCase } from "./case-store";
import { TICKET_STAGE_KEY_PREFIX } from "./case-ticket-stage";
import { openHandoffVersion } from "./case-ticket-stage-queue";
import { caseDedupeKey, caseRequestId, type CaseAdmissionQualification, type CaseRequestSubject } from "./case-types";
import { createCaseV2WakeDeps } from "./case-v2-wake-ports";
import { runCaseV2Wake, type CaseV2WakeDeps } from "./case-v2-wake";
import { selectCaseKnowledge } from "./investigation-knowledge";
import { runCaseInvestigation, type CaseInvestigationModelRequest } from "./investigation-runner";
import { caseInvestigationStorePorts } from "./investigation-store-ports";
import { smartHandoffProposal } from "./smart/smart-case-provider";

/*
 * Ugo (25/11): every case the V2 hands to the team moves its ticket to « Nouveau », no owner (and HIGH priority under its switch), including a case refused
 * at entry (born with the team, with its mail). Slack (Ugo 25/11, firm) is ONLY for the cases the agent took and worked on: a case refused at entry never
 * gets a notice, and the entry notices PR #365 already created are cancelled before any Slack call. And the hand-over sweeps walk only the cases touched since the activation date,
 * so a smart hand-over is reached in the very next wake. Real case store, ledger, executor, sweeps and wake on PGlite; SYN data only. Doubles: the model
 * (the smart brain's own hand-over mapping), the knowledge search, the CRM reading, Slack and HubSpot (function-shaped, no socket).
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, policyId: string, policyHash: string, policy: ExecutionPolicy, ticketSeq = 9_800_000, options: ExecutionOptions;
let slack = fakeSlack(), p = executionProvider(), environment: Record<string, string | undefined> = {}, since = new Date();
const STAFF = "20000000-0000-4000-8000-000000000002", AT = "2026-11-04T09:00:00.000Z", CUSTOMER = "customer@example.invalid";
const CHANNEL = "CSYNCHANNEL1", TOKEN = "xoxb-" + "TEST".repeat(4), PORTAL = "1234567", V2_OWNER = "424242", TEAM_OWNER = "999111";
const POLICY = { revision: "policy-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT };
const CONFIRMED: CaseAdmissionQualification["identity"] = { status: "confirmed", source: { type: "hubspot_object", id: "contact-syn" } };
type Family = "access" | "cancellation" | "usage";
const qualification = (requests: CaseAdmissionQualification["requests"]): CaseAdmissionQualification => ({ requests, identity: CONFIRMED, crmContext: "complete", teamSignals: [] });
const ruled = (requestId: string, family: Family = "access") => ({ requestId, family, provenance: { kind: "qualified_rule" as const, ruleId: "rule-access", revision: "r1", at: AT } });
const admissionOf = (requestId: string, family: Family): CaseAdmissionInput => ({ policy: POLICY, qualification: qualification([ruled(requestId, family)]) });
const subject = (text: string): CaseRequestSubject => ({ status: "available", text, provenance: { source: "v1_accepted_analysis", field: "ticketSummary",
  runId: "30000000-0000-4000-8000-000000000001", runVersion: 1, resultHash: "result-hash", validatorRevision: "validator-r1", acceptedAt: AT } });
const backend: SavRetrievalBackend = { readRevision: async () => "kb-r1", search: async queries => queries.map(() => []) };
const policyRef = () => ({ id: policyId, hash: policyHash });

/** A customer mail relayed by V1: a cancellation is refused at entry (`sensitive_family`, born with the team), an access request is admitted for the agent. */
async function relayed(gmail: string, family: Family, ticket?: { ticketId: string; threadId: string }) {
  const ticketId = ticket?.ticketId ?? String(++ticketSeq), threadId = ticket?.threadId ?? randomUUID(), requestId = caseRequestId(gmail, "r1");
  await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `gmail-thread-${threadId}`, customerEmail: CUSTOMER }).onConflictDoNothing();
  const opened = (await openCaseEvent({ ticketId, threadId, admission: admissionOf(requestId, family),
    opens: [{ id: requestId, summary: "Demande relevée par l'analyse V1.", subject: subject(family === "cancellation" ? "Résilier mon abonnement." : "Connexion impossible à la plateforme.") }],
    kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmail), sourceRef: { type: "email", id: gmail }, occurredAt: new Date().toISOString() })).case;
  if (!ticket) p.seedTicket({ id: ticketId, ownerId: V2_OWNER, stage: "open" });
  return { caseId: opened.caseId, ticketId, threadId };
}

/** The runner on pole A's stores, with the smart brain's own mapping of a « no source » hand-over (`smartHandoffProposal`, as for f4dcab86). */
async function smartHandoff(caseId: string, reason: Extract<HandoffReason, "knowledge_missing" | "sensitive_request" | "diagnosis_out_of_tools"> = "knowledge_missing") {
  const now = () => new Date(Date.now() + 6 * 60_000);
  const ports = caseInvestigationStorePorts({
    readTicketOwner: async () => "v2", holder: "sav-v2-investigation", scope: { locale: "fr-FR", audience: "support" }, now,
    pauseState: async () => (await readSavAgentPause(f.db as never, "v2")).level,
    knowledge: snapshot => selectCaseKnowledge(snapshot, backend, { locale: "fr-FR", audience: "support", now: now() }),
    customerTexts: async (_caseId, refs) => Object.fromEntries(refs.map(row => [`${row.type}:${row.id}`, "Bonjour, je n'arrive plus à me connecter."])),
    revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" }),
    callModel: async (request: CaseInvestigationModelRequest) => ({ status: "ok", output: smartHandoffProposal(request, { reason, noteText: null,
      note: { raison: "no_source", besoin: "Le client n'arrive plus à se connecter.", compris: "Aucune fiche ne couvre ce blocage.", verifie: [], essaye: [], hypotheses: [],
        prochaineVerification: "Vérifier le compte du client.", ditAuClient: null } }) }),
    admissionPolicyRevision: async () => "policy-r1",
    qualify: async (snapshot, events) => {
      const latest = events.filter(event => event.kind === "inbound_confirmed").at(-1);
      const requests = snapshot.body.openRequests.filter(row => row.status === "open").map(row => ruled(row.id));
      return latest ? { admission: { policy: POLICY, qualification: qualification(requests) }, sourceRef: latest.sourceRef } : null;
    },
  });
  return runCaseInvestigation(caseId, "observe", ports);
}

const route: typeof fetch = (input, init) => new URL(String(input)).hostname === "slack.com" ? slack.network(input, init) : p.network(input, init);
const gmail: GmailRequest = async <T>(mailbox: string, path: string, init?: RequestInit) => p.gmail<T>(mailbox, path, init);
const crmReading: HandoffCrmReading = { ticket: null, contacts: [] };
function wakeDeps(): CaseV2WakeDeps {
  const deps = createCaseV2WakeDeps({ env: () => environment, policy: policyRef(), since, deadlineMs: Date.now() + 60_000, network: route, gmail: { request: gmail, permissions: async () => { } },
    readPolicyRecord: async () => ({ policy: POLICY, validFrom: new Date(Date.now() - 3_600_000).toISOString(), validUntil: new Date(Date.now() + 3_600_000).toISOString() }) });
  const context = { runtime: options.runtime, policy: options.policy };
  return { ...deps, replies: { ...deps.replies, context }, handoff: { ...deps.handoff, context, crm: async () => crmReading }, stages: { ...deps.stages, context } };
}
const wake = () => runCaseV2Wake(wakeDeps());
const noticeRows = (caseId: string) => f.db.select().from(savCaseEffectExecutions).where(and(eq(savCaseEffectExecutions.caseId, caseId), like(savCaseEffectExecutions.replyKey, `${HANDOFF_NOTICE_KEY_PREFIX}%`)));
const stageRows = (caseId: string) => f.db.select().from(savCaseEffectExecutions).where(and(eq(savCaseEffectExecutions.caseId, caseId), like(savCaseEffectExecutions.replyKey, `${TICKET_STAGE_KEY_PREFIX}%:handoff:%`)));
const posts = () => slack.state.calls.filter(call => call.url.pathname === "/api/chat.postMessage");
const ticketPatches = (ticketId: string) => p.calls.filter(call => call.method === "PATCH" && call.path === `/crm/v3/objects/tickets/${ticketId}`);
const firstAdmission = async (caseId: string) => (await listCaseEvents(caseId)).find(event => event.kind === "admission_decided")!;
/** Activation now: the hand-overs recorded from here on are the V2's to notice and to move. */
const activate = () => { const at = new Date(); environment.SAV_V2_HANDOFF_STAGE_SINCE = at.toISOString(); return at; };

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-entry-encryption-key-32-characters-long"); vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.spyOn(console, "info").mockImplementation(() => { });
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
  if (!policyId) {
    const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-admin", email: "contact@limova.ai", name: "Synthetic Admin", role: "admin", active: true }).returning();
    state.user = { id: admin!.clerkId, primaryEmailAddress: { emailAddress: admin!.email, verification: { status: "verified" } } };
    mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0]!.id;
    policy = {
      revision: "sav-intake-execution-2026-10-21.v1", mailboxId, codeRevision: "a".repeat(40), enginePolicyHash: "b".repeat(64), resourcesHash: "c".repeat(64),
      createdAfter: new Date(Date.now() - 10_000).toISOString(), receivedAfter: new Date(Date.now() - 3_600_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      maxDossiers: 100, mutations: ["send_case_reply", "append_case_note", "notify_case_handoff", "set_case_ticket_stage"], admission: { kind: "automatic" },
    };
    const grant = await approveIntakeExecutionPolicy(policy);
    policyId = grant.id; policyHash = grant.policyHash;
    options = { runtime: {} as never, policy, config: { policyId, policyHash, codeRevision: "a".repeat(40) }, env: () => environment, signal: AbortSignal.timeout(60_000), adapters: undefined as never };
  }
  environment = {
    SAV_INTAKE_EXECUTION_MODE: "execute", SAV_INTAKE_EXECUTION_POLICY_ID: policyId, SAV_INTAKE_EXECUTION_POLICY_SHA256: policyHash, SAV_CODE_REVISION: "a".repeat(40),
    HUBSPOT_ACCESS_TOKEN: "synthetic-hubspot-token", SAV_V2_HUBSPOT_OWNER_ID: V2_OWNER, HUBSPOT_SAV_OWNER_ID: TEAM_OWNER,
    SAV_V2_TICKET_STAGES: "on", SAV_V2_STAGE_WAITING_CUSTOMER: "2", SAV_V2_STAGE_CLOSED: "4", SAV_V2_HANDOFF_STAGE: "on",
    SAV_HANDOFF_NOTICE: "on", SAV_HANDOFF_SLACK_BOT_TOKEN: TOKEN, SAV_HANDOFF_SLACK_CHANNEL_ID: CHANNEL, SAV_HANDOFF_TEAM_OWNER_ID: TEAM_OWNER, HUBSPOT_PORTAL_ID: PORTAL,
  };
  slack = fakeSlack(); p = executionProvider(); since = new Date(Date.now() - 3_600_000);
  await f.client.exec("UPDATE sav.case_effect_executions SET state = 'refused' WHERE state NOT IN ('confirmed', 'refused')");
  await f.client.exec("DELETE FROM sav.sync_state WHERE key LIKE 'sav-v2-sweep.v1:%'");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("A: the hand-over stage of a case refused at entry", () => {
  it("its version is its first admission decision; a second sweep finds it existing; a refusal recorded before the activation gets none", async () => {
    activate();
    const made = await relayed("gm-entry-stage", "cancellation");
    const snapshot = (await readCase(made.caseId))!;
    expect(snapshot).toMatchObject({ owner: "human", phase: "handoff_pending", body: { handoff: { reason: "sensitive_family" } } });
    const admission = await firstAdmission(made.caseId);
    expect(await f.db.transaction(tx => openHandoffVersion(tx as never, snapshot))).toBe(admission.caseVersion);
    const input = { policy: policyRef(), env: () => environment };
    const first = await enqueueHandoffStage({ ...input, caseId: made.caseId });
    expect(first).toMatchObject({ ok: true, created: true, key: `case-stage:${made.caseId}:handoff:handoff-v${admission.caseVersion}` });
    expect(await enqueueHandoffStage({ ...input, caseId: made.caseId })).toMatchObject({ ok: true, created: false, key: (first as { key: string }).key });
    // A follow-up mail re-admits the case: the same hand-over, the same key, nothing new.
    await relayed("gm-entry-stage-2", "cancellation", made);
    expect(await enqueueHandoffStage({ ...input, caseId: made.caseId })).toMatchObject({ ok: true, created: false, key: (first as { key: string }).key });
    expect(await stageRows(made.caseId)).toHaveLength(1);

    const old = await relayed("gm-entry-stage-old", "cancellation");
    environment.SAV_V2_HANDOFF_STAGE_SINCE = new Date(Date.now() + 1000).toISOString();
    expect(await enqueueHandoffStage({ ...input, caseId: old.caseId })).toEqual({ ok: false, reason: "handoff_before_since" });
    expect(await stageRows(old.caseId)).toEqual([]);
  });
});

/** The entry notice exactly as PR #365's sweep sealed it (key `admission:<first admission event>`, reason `entry_sensitive`, no note), still open. */
async function legacyEntryNotice(made: Awaited<ReturnType<typeof relayed>>) {
  const snapshot = (await readCase(made.caseId))!, admission = await firstAdmission(made.caseId);
  const key = `${HANDOFF_NOTICE_KEY_PREFIX}${made.caseId}:admission:${admission.id}`;
  const facts = handoffNoticeFacts({ ok: true, caseId: made.caseId, ticketId: made.ticketId, inputKey: `admission:${admission.id}`, recordedAtVersion: admission.caseVersion,
    reason: "entry_sensitive", report: { need: "Demande laissée à l'équipe dès son arrivée : Résilier mon abonnement.", expected: null, observed: null, trialIds: [], hypotheses: [],
      missingInformation: [], expectedIntervention: "Reprendre le message et répondre au client : l'agent ne l'a pas pris en charge et ne lui a envoyé aucun mail." } }, snapshot.body);
  const [row] = await f.db.insert(savCaseEffectExecutions).values({ caseId: made.caseId, replyKey: key, threadId: made.threadId, policyId, policyHash,
    payloadCiphertext: encryptSavPayload({ contract: HANDOFF_NOTICE_CONTRACT, key, facts, teamOwnerId: TEAM_OWNER }) }).returning();
  return row!;
}
const noticePass = () => runHandoffNoticePass({ ...wakeDeps().handoff, env: () => environment, deadlineMs: Date.now() + 60_000 });

describe("C: no Slack notice for a case refused at entry (Ugo 25/11, firm)", () => {
  it("a sensitive_family case (V1 said cancellation) and a family_not_admitted case: no notice, by the hook or the sweep", async () => {
    activate();
    const sensitive = await relayed("gm-entry-sensitive", "cancellation");
    expect(await readCase(sensitive.caseId)).toMatchObject({ owner: "human", phase: "handoff_pending", body: { handoff: { reason: "sensitive_family" } } });
    const notAdmitted = await relayed("gm-entry-not-admitted", "usage");
    expect((await firstAdmission(notAdmitted.caseId)).detail).toMatchObject({ reasons: expect.arrayContaining(["family_not_admitted"]) });
    for (const made of [sensitive, notAdmitted]) {
      expect(await enqueueHandoffNotice({ caseId: made.caseId, policy: policyRef(), env: () => environment })).toMatchObject({ ok: false, code: "no_trigger" });
    }
    await enqueueHandoffNotices({ policy: policyRef(), env: () => environment, since, limit: 200 });
    // A follow-up mail on the refused case changes nothing.
    await relayed("gm-entry-sensitive-2", "cancellation", sensitive);
    expect(await enqueueHandoffNotice({ caseId: sensitive.caseId, policy: policyRef(), env: () => environment })).toMatchObject({ ok: false, code: "no_trigger" });
    expect(await noticeRows(sensitive.caseId)).toEqual([]);
    expect(await noticeRows(notAdmitted.caseId)).toEqual([]);
  });

  it("an entry notice already created by PR #365 is refused at execution time, for good, without any Slack call", async () => {
    activate();
    const made = await relayed("gm-entry-legacy", "cancellation");
    const row = await legacyEntryNotice(made);
    const info = vi.spyOn(console, "info").mockImplementation(() => { });
    const result = await wake();
    expect(result.failures).toEqual([]);
    expect(result.handoff).toMatchObject({ skipped: null, processed: [{ executionId: row.id, state: "refused", reason: "SAV_HANDOFF_NOTICE_CANCELLED_ENTRY_REFUSAL" }] });
    expect(slack.state.calls).toEqual([]);
    expect(info).toHaveBeenCalledWith("sav_v2_handoff_pass", { name: "handoff_notice", run: 1, confirmed: 0, deferred: {}, refused: { SAV_HANDOFF_NOTICE_CANCELLED_ENTRY_REFUSAL: 1 } });
    // Terminal: never listed again, never retried, no alert.
    expect(await noticePass()).toEqual({ skipped: "nothing_due" });
    const [after] = await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, row.id));
    expect(after).toMatchObject({ state: "refused", reason: "SAV_HANDOFF_NOTICE_CANCELLED_ENTRY_REFUSAL", leaseToken: null });
    expect(slack.state.calls).toEqual([]);
    // Its « Nouveau » stage (the stage part of #365) is kept.
    expect(ticketPatches(made.ticketId).map(call => call.body)).toEqual([{ properties: { hs_pipeline_stage: "1", hubspot_owner_id: "" } }]);
  });

  it("a smart team_sensitive hand-over (sensitive_request) and an investigated diagnosis_out_of_tools hand-over still get their notice", async () => {
    activate();
    const sensitive = await relayed("gm-smart-sensitive", "access");
    expect(await smartHandoff(sensitive.caseId, "sensitive_request")).toMatchObject({ status: "recorded", outcome: "accepted" });
    const tools = await relayed("gm-smart-tools", "access");
    expect(await smartHandoff(tools.caseId, "diagnosis_out_of_tools")).toMatchObject({ status: "recorded", outcome: "accepted" });
    expect(await readCase(tools.caseId)).toMatchObject({ owner: "human", phase: "handoff_pending" });
    for (const made of [sensitive, tools]) {
      expect(await enqueueHandoffNotice({ caseId: made.caseId, policy: policyRef(), env: () => environment })).toMatchObject({ ok: true, created: true });
    }
    const passed = await noticePass();
    expect(passed).toMatchObject({ skipped: null, processed: [{ state: "confirmed" }, { state: "confirmed" }] });
    expect(posts()).toHaveLength(2);
    const texts = posts().map(call => String(call.body?.text));
    expect(texts.some(text => text.includes("demande sensible, réservée à l'équipe"))).toBe(true);
    expect(texts.some(text => text.includes("le diagnostic dépasse les outils de l'agent"))).toBe(true);
  });

  it("COUNTER-TEST: an investigated hand-over recorded before the activation is not noticed under the date (without one: as before)", async () => {
    const made = await relayed("gm-entry-notice-investigated-old", "access");
    expect(await smartHandoff(made.caseId)).toMatchObject({ status: "recorded", outcome: "accepted" });
    environment.SAV_V2_HANDOFF_STAGE_SINCE = new Date(Date.now() + 1000).toISOString();
    expect(await enqueueHandoffNotice({ caseId: made.caseId, policy: policyRef(), env: () => environment })).toEqual({ ok: false, code: "no_trigger", why: "handoff_before_since" });
    expect(await noticeRows(made.caseId)).toEqual([]);
    environment.SAV_V2_HANDOFF_STAGE_SINCE = undefined;
    expect(await enqueueHandoffNotice({ caseId: made.caseId, policy: policyRef(), env: () => environment })).toMatchObject({ ok: true, created: true });
  });
});

describe("D: the wake reaches a smart hand-over and an entry refusal at once, not after a lap of the whole policy window", () => {
  it("60 older cases of the window are not walked; one wake: one Slack post (the smart one only) and one « Nouveau » PATCH (HIGH) each; the next wake adds nothing", async () => {
    environment.SAV_V2_HANDOFF_PRIORITY = "high";
    const older = [];
    for (let i = 0; i < 60; i++) older.push((await relayed(`gm-window-old-${i}`, "access")).caseId);
    // Touched inside the policy window (since = 1 h ago), before the activation: the old hand-over cases of production.
    await f.db.update(savCases).set({ updatedAt: new Date(Date.now() - 30 * 60_000) }).where(inArray(savCases.id, older));
    activate();
    const smart = await relayed("gm-window-smart", "access");
    expect(await smartHandoff(smart.caseId)).toMatchObject({ status: "recorded", outcome: "accepted" });
    const entry = await relayed("gm-window-entry", "cancellation");
    const info = vi.spyOn(console, "info").mockImplementation(() => { });

    const result = await wake();
    expect(result.failures).toEqual([]);
    expect(result.handoffSweep).toMatchObject({ created: 1 });
    expect(result.handoffSweep!.examined).toBeLessThan(10);
    expect(result.handoffStages).toMatchObject({ created: 2 });
    expect(await noticeRows(smart.caseId)).toHaveLength(1);
    expect(await noticeRows(entry.caseId)).toEqual([]);
    expect(posts()).toHaveLength(1);
    expect(posts().map(call => String(call.body?.text)).some(text => text.includes("sujet sensible (résiliation, facturation…)"))).toBe(false);
    for (const made of [smart, entry]) {
      expect(ticketPatches(made.ticketId).map(call => call.body)).toEqual([{ properties: { hs_pipeline_stage: "1", hubspot_owner_id: "", hs_ticket_priority: "HIGH" } }]);
      expect(await stageRows(made.caseId)).toHaveLength(1);
    }
    expect(info).toHaveBeenCalledWith("sav_v2_handoff_sweep", expect.objectContaining({ name: "handoff_notice", created: 1 }));
    expect(info).toHaveBeenCalledWith("sav_v2_handoff_sweep", expect.objectContaining({ name: "handoff_stage", created: 2 }));
    expect(info).toHaveBeenCalledWith("sav_v2_handoff_pass", { name: "handoff_notice", run: 1, confirmed: 1, deferred: {}, refused: {} });
    expect(info).toHaveBeenCalledWith("sav_v2_handoff_pass", expect.objectContaining({ name: "handoff_stage", confirmed: 2 }));

    const again = await wake();
    expect(again.handoffSweep).toMatchObject({ created: 0, existing: 1 });
    expect(again.handoffStages).toMatchObject({ created: 0 });
    expect(posts()).toHaveLength(1);
    expect([smart, entry].flatMap(made => ticketPatches(made.ticketId))).toHaveLength(2);
    // On the whole policy window the sweeps re-read the older cases too, and still create nothing twice (and no entry notice at all).
    const windowed = await enqueueHandoffNotices({ policy: policyRef(), env: () => ({ ...environment, SAV_V2_HANDOFF_STAGE_SINCE: undefined }), since, limit: 200 });
    expect(windowed.examined).toBeGreaterThanOrEqual(62);
    expect(windowed.created).toBe(0);
    expect(await noticeRows(entry.caseId)).toEqual([]);
    expect(await enqueueHandoffStages({ policy: policyRef(), env: () => environment, since, limit: 200 })).toMatchObject({ created: 0, existing: 2 });
  });
});
