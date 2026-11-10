import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { fakeSlack } from "../../../../test/sav-handoff-fakes";
const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));
import { savCaseEffectExecutions, savIntakeEffectJournal, savIntakeEffects, savMailboxes, savSyncState, savThreads, staffUsers } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { approveIntakeExecutionPolicy, type ExecutionPolicy } from "../intake/execution-policy";
import { executeIntakePass } from "../intake/executor";
import type { ExecutionOptions } from "../intake/execution-types";
import type { SavRetrievalBackend, SavRetrievalCandidate } from "../request-retrieval";
import { readSavAgentPause } from "../intake/agent-pause";
import type { CaseAdmissionInput } from "./admission-policy";
import { pendingCaseEffectExecutions } from "./case-effect-driver";
import { pendingCaseEffectRecoveries } from "./case-effect-recovery";
import {
  createHandoffNoticeDriver, enqueueHandoffNotice, enqueueHandoffNotices, HANDOFF_NOT_POSTED_RETRIES, pendingHandoffNoticeExecutions, runHandoffNoticePass,
} from "./case-handoff-notice-store";
import { HANDOFF_NOTICE_KEY_PREFIX, handoffNoticeKey, type HandoffCrmReading } from "./case-handoff-notice";
import { listCaseEvents, openCaseEvent, readCase, transitionCaseOwner } from "./case-store";
import { caseDedupeKey, caseRequestId, type CaseAdmissionQualification, type CaseRequestSubject, type CaseSnapshot, type KnowledgeRef } from "./case-types";
import { selectCaseKnowledge } from "./investigation-knowledge";
import { runCaseInvestigation, SAV_CASE_INVESTIGATION_MAX_CALLS, type CaseInvestigationModelRequest, type CaseInvestigationModelResult } from "./investigation-runner";
import { caseInvestigationStorePorts } from "./investigation-store-ports";

/*
 * The Slack handoff notice on the REAL pieces, SYN data only: B's real investigation runner and validator, pole A's real case store, the real effect ledger and the
 * real executor (`executeIntakePass`) with the notice driver, on PGlite. Doubles: the knowledge search, the model, the rules, the owner read, the CRM reading and Slack
 * (an in-memory channel behind a function-shaped network). Nothing reaches a provider; the channel, owner and portal are synthetic placeholders.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, policyId: string, policyHash: string, policy: ExecutionPolicy, ticketSeq = 9_500_000;
let slack = fakeSlack(), environment: Record<string, string | undefined> = {}, crmReading: () => HandoffCrmReading | Error = () => ({ ticket: null, contacts: [] }), crmCalls = 0;
const STAFF = "20000000-0000-4000-8000-000000000002", AT = "2026-11-04T09:00:00.000Z", ACCESS = "https://new.limova.ai", CUSTOMER = "customer@example.invalid";
const CHANNEL = "CSYNCHANNEL1", TOKEN = "xoxb-" + "TEST".repeat(4), PORTAL = "1234567", OWNER = "424242";
const POLICY = { revision: "policy-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT };
type Identity = CaseAdmissionQualification["identity"];
const CONFIRMED: Identity = { status: "confirmed", source: { type: "hubspot_object", id: "contact-syn" } };
const qualification = (requests: CaseAdmissionQualification["requests"], identity = CONFIRMED): CaseAdmissionQualification => ({ requests, identity, crmContext: "complete", teamSignals: [] });
const ruled = (requestId: string) => ({ requestId, family: "access" as const, provenance: { kind: "qualified_rule" as const, ruleId: "rule-access", revision: "r1", at: AT } });
const byRule = (...requestIds: string[]): CaseAdmissionInput => ({ policy: POLICY, qualification: qualification(requestIds.map(ruled)) });
const recent = () => new Date(Date.now() - 10 * 86_400_000).toISOString();
const card = (id: string, version: string): SavRetrievalCandidate => ({
  id, contentVersionId: version, title: `Fiche ${id}`, content: "Procédure synthétique.", source: "fixture", verifiedAt: recent(), semanticScore: null,
  resolution: { steps: ["Étape synthétique"] }, availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" },
});
const refOf = (row: SavRetrievalCandidate): KnowledgeRef => ({ knowledgeId: row.id, contentVersionId: row.contentVersionId });
const LOGIN = card("syn-login", "syn-login-v1");
const kb = { cards: [] as SavRetrievalCandidate[] };
const backend: SavRetrievalBackend = { readRevision: async () => "kb-r1", search: async queries => queries.map(() => kb.cards) };
const subject = (text: string): CaseRequestSubject => ({ status: "available", text, provenance: { source: "v1_accepted_analysis", field: "ticketSummary",
  runId: "30000000-0000-4000-8000-000000000001", runVersion: 1, resultHash: "result-hash", validatorRevision: "validator-r1", acceptedAt: AT } });

/** A mail relayed by V1 on a REAL thread row carrying the customer's address (what the CRM contact is matched against). */
async function mail(id: string, threadId: string, ticketId: string, admission: CaseAdmissionInput = byRule(caseRequestId(id, "r1"))) {
  await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `gmail-${threadId}`, customerEmail: CUSTOMER }).onConflictDoNothing();
  return (await openCaseEvent({ ticketId, threadId, admission, opens: [{ id: caseRequestId(id, "r1"), summary: `Demande « support » relevée par l'analyse V1 du mail ${id}.`, subject: subject("Connexion impossible à la plateforme.") }],
    kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(id), sourceRef: { type: "email", id }, occurredAt: new Date().toISOString() })).case;
}
async function newCase(gmail: string) {
  const ticketId = String(++ticketSeq), threadId = randomUUID();
  return { ticketId, threadId, c: await mail(gmail, threadId, ticketId) };
}
const secondMail = (id: string, threadId: string, ticketId: string) => mail(id, threadId, ticketId, byRule(caseRequestId(id, "r1")));

type Answer = (request: CaseInvestigationModelRequest) => CaseInvestigationModelResult;
const understood = (snapshot: CaseSnapshot) => ({ requests: snapshot.body.openRequests.filter(row => row.status === "open").map(row => ({ id: row.id, summary: "Connexion impossible.", family: "access", status: "open" })), newFacts: [] });
const handoff = (over: { reason?: string; need?: string; intervention?: string } = {}): Answer => request => {
  const u = understood(request.snapshot);
  return { status: "ok", output: { caseVersion: request.snapshot.version, understanding: u,
    nextAction: { kind: "handoff", reason: over.reason ?? "knowledge_missing", requestIds: [u.requests[0]!.id], report: { need: over.need ?? "Le client n'arrive plus à se connecter à la plateforme.", expected: null, observed: null,
      trialIds: [], hypotheses: [], missingInformation: [], expectedIntervention: over.intervention ?? "Vérifier le compte du client et le rappeler.", knowledge: [] } } } };
};
const answer: Answer = request => {
  const u = understood(request.snapshot), cited = refOf(LOGIN);
  return { status: "ok", output: { caseVersion: request.snapshot.version, understanding: u,
    nextAction: { kind: "answer", requestIds: [u.requests[0]!.id], steps: [{ text: "Suivre la fiche citée.", knowledge: cited }], expectedResult: "La connexion fonctionne." },
    reply: { text: `Bonjour, voici la marche à suivre depuis ${ACCESS} : suivre la fiche.`, citations: [cited], impossibilityClaims: [], accountAdvice: "none" } } };
};
const ask: Answer = request => {
  const u = understood(request.snapshot);
  return { status: "ok", output: { caseVersion: request.snapshot.version, understanding: u,
    nextAction: { kind: "ask", questions: [{ text: "Quel message s'affiche ?", requestId: u.requests[0]!.id, reducesUncertainty: "Précise le blocage.", seeks: [{ kind: "observed_result" }] }] },
    reply: { text: `Bonjour, depuis ${ACCESS}, quel message s'affiche ?`, citations: [], impossibilityClaims: [], accountAdvice: "none" } } };
};
const observeOnly: Answer = request => ({ status: "ok", output: { caseVersion: request.snapshot.version, understanding: understood(request.snapshot), nextAction: { kind: "observe_only" } } });

const enqueue = (caseId: string) => enqueueHandoffNotice({ caseId, policy: { id: policyId, hash: policyHash }, env: () => environment });
/** The hook the real runtime would wire: after the claim's decision is durable, admit the notice (an unwired hook is the sweep's case). */
let hookCalls = 0, testStart = new Date();
async function investigate(caseId: string, answers: Answer[], options: { identity?: Identity; hook?: boolean; callModel?: (request: CaseInvestigationModelRequest) => CaseInvestigationModelResult | Promise<CaseInvestigationModelResult> } = {}) {
  const now = () => new Date(Date.now() + 6 * 60_000);
  const ports = caseInvestigationStorePorts({
    readTicketOwner: async () => "v2", holder: "sav-v2-investigation", scope: { locale: "fr-FR", audience: "support" }, now,
    pauseState: async () => (await readSavAgentPause(f.db as never, "v2")).level,
    knowledge: snapshot => selectCaseKnowledge(snapshot, backend, { locale: "fr-FR", audience: "support", now: now() }),
    customerTexts: async (_caseId, refs) => Object.fromEntries(refs.map(row => [`${row.type}:${row.id}`, "Bonjour, je n'arrive plus à me connecter."])),
    revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" }),
    callModel: async request => options.callModel ? options.callModel(request) : (answers.shift()?.(request) ?? { status: "failed", uncertain: false }),
    admissionPolicyRevision: async () => "policy-r1",
    qualify: async (snapshot, events) => {
      const latest = events.filter(event => event.kind === "inbound_confirmed").at(-1);
      const requests = snapshot.body.openRequests.filter(row => row.status === "open").map(row => ruled(row.id));
      return latest ? { admission: { policy: POLICY, qualification: qualification(requests, options.identity ?? CONFIRMED) }, sourceRef: latest.sourceRef } : null;
    },
    ...(options.hook === false ? {} : { afterDecisionRecorded: async (id: string) => { hookCalls += 1; await enqueue(id); } }),
  });
  return runCaseInvestigation(caseId, "observe", ports);
}

const noticeRows = () => f.db.select().from(savCaseEffectExecutions).where(like(savCaseEffectExecutions.replyKey, `${HANDOFF_NOTICE_KEY_PREFIX}%`));
const effectsOf = (executionId: string) => f.db.select().from(savIntakeEffects).where(eq(savIntakeEffects.executionId, executionId));
const posts = () => slack.state.calls.filter(call => call.url.pathname === "/api/chat.postMessage");
const setPause = async (agent: "intake" | "v2", level: "actions_paused" | "fully_paused" | null) => {
  await f.db.delete(savSyncState).where(eq(savSyncState.key, `sav-agent-pause.v1:${agent}`));
  if (level) await f.db.insert(savSyncState).values({ key: `sav-agent-pause.v1:${agent}`, status: "installed",
    cursor: encryptSavPayload({ revision: "sav-agent-pause.v1", agent, level, setBy: "fixture@example.invalid", setAt: AT, reason: "pause fictive" }) });
};
const letReconcile = () => f.client.exec("UPDATE sav.intake_effects SET next_reconcile_at = NULL");
let options: ExecutionOptions;
const crm = async () => { crmCalls += 1; const reading = crmReading(); if (reading instanceof Error) throw reading; return reading; };
const pass = (over: Partial<Parameters<typeof runHandoffNoticePass>[0]> = {}) =>
  runHandoffNoticePass({ env: () => environment, network: slack.network, deadlineMs: Date.now() + 60_000, context: { runtime: options.runtime, policy: options.policy }, crm, ...over });
const goodCrm = (ticketId: string): HandoffCrmReading => ({ ticket: { id: ticketId, archived: false }, contacts: [{ id: "777", firstname: "Camille", lastname: "Synthétique", emails: [CUSTOMER], archived: false }] });
/** A case whose real investigation decided to hand over, with its notice queued by the real hook. */
async function handedOver(gmail: string, answers: Answer[] = [handoff()]) {
  const made = await newCase(gmail);
  crmReading = () => goodCrm(made.ticketId);
  const report = await investigate(made.c.caseId, answers);
  expect(report).toMatchObject({ status: "recorded", outcome: "accepted" });
  const [row] = await noticeRows().then(rows => rows.filter(r => r.caseId === made.c.caseId));
  return { ...made, report, execution: row };
}
const messageOf = () => slack.state.messages.at(-1)!.text;

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-handoff-encryption-key-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.spyOn(console, "info").mockImplementation(() => { });
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
  if (!policyId) {
    const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-admin", email: "contact@limova.ai", name: "Synthetic Admin", role: "admin", active: true }).returning();
    state.user = { id: admin!.clerkId, primaryEmailAddress: { emailAddress: admin!.email, verification: { status: "verified" } } };
    mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0]!.id;
    policy = {
      revision: "sav-intake-execution-2026-10-21.v1", mailboxId, codeRevision: "a".repeat(40), enginePolicyHash: "b".repeat(64), resourcesHash: "c".repeat(64),
      createdAfter: new Date(Date.now() - 10_000).toISOString(), receivedAfter: new Date(Date.now() - 3_600_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      maxDossiers: 10, mutations: ["notify_case_handoff"], admission: { kind: "automatic" },
    };
    const grant = await approveIntakeExecutionPolicy(policy);
    policyId = grant.id; policyHash = grant.policyHash;
  }
  options = { runtime: {} as never, policy, config: { policyId, policyHash, codeRevision: "a".repeat(40) }, env: () => environment, signal: AbortSignal.timeout(60_000), adapters: undefined as never };
  environment = { SAV_HANDOFF_NOTICE: "on", SAV_HANDOFF_SLACK_BOT_TOKEN: TOKEN, SAV_HANDOFF_SLACK_CHANNEL_ID: CHANNEL, SAV_HANDOFF_TEAM_OWNER_ID: OWNER, HUBSPOT_PORTAL_ID: PORTAL,
    SAV_INTAKE_EXECUTION_MODE: "execute", SAV_INTAKE_EXECUTION_POLICY_ID: policyId, SAV_INTAKE_EXECUTION_POLICY_SHA256: policyHash, SAV_CODE_REVISION: "a".repeat(40) };
  slack = fakeSlack(); testStart = new Date(); crmCalls = 0; hookCalls = 0; kb.cards = []; crmReading = () => ({ ticket: null, contacts: [] });
  // Every test starts without a notice left by the previous one.
  await f.client.exec("UPDATE sav.case_effect_executions SET state = 'refused' WHERE reply_key LIKE 'handoff-notice:%'");
});
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await setPause("v2", null); await setPause("intake", null); });

describe("the trigger: the real investigation's final handoff decision, once", () => {
  it("real raccord: handoff decision recorded -> hook -> one execution -> one Slack message with the template, then confirmed; nothing more on a second pass", async () => {
    const made = await handedOver("gm-ho-ok");
    expect(hookCalls).toBe(1);
    expect(made.execution).toMatchObject({ state: "pending", replyKey: handoffNoticeKey(made.c.caseId, made.report.status === "recorded" ? (await latestInputKey(made.c.caseId)) : "") });
    expect(slack.state.calls).toHaveLength(0);

    const first = await pass();
    expect(first).toMatchObject({ skipped: null, processed: [{ executionId: made.execution!.id, state: "confirmed" }] });
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.body).toMatchObject({ channel: CHANNEL, unfurl_links: false });
    const text = messageOf();
    expect(text.split("\n")[0]).toBe("*Nouveau ticket à transmettre à l'équipe*");
    expect(text).toContain(`Camille Synthétique — <https://app.hubspot.com/contacts/${PORTAL}/record/0-1/777|fiche contact HubSpot>`);
    expect(text).toContain("*Problème :* Le client n'arrive plus à se connecter à la plateforme.");
    expect(text).toContain("*Motif du relais :* aucune fiche de connaissance ne couvre la demande");
    expect(text).toContain(`<https://app.hubspot.com/contacts/${PORTAL}/record/0-5/${made.ticketId}|ticket ${made.ticketId}>`);
    expect(text).toContain("*Prochaine action proposée :* Vérifier le compte du client et le rappeler.");
    expect(text).toMatch(/_Réf\. HO-[0-9a-f]{12}_$/);
    const [done] = await noticeRows().then(rows => rows.filter(r => r.id === made.execution!.id));
    expect(done).toMatchObject({ state: "confirmed" });
    const [effect] = await effectsOf(made.execution!.id);
    expect(effect).toMatchObject({ kind: "handoff_notify", permission: "notify_case_handoff", state: "confirmed", businessKey: made.execution!.replyKey });

    expect(await pass()).toEqual({ skipped: "nothing_due" });
    expect(await enqueue(made.c.caseId)).toMatchObject({ ok: true, created: false });
    expect(await pass()).toEqual({ skipped: "nothing_due" });
    expect(posts()).toHaveLength(1);
  });

  it("every reason of the decision reaches the template with its own label; the case keeps its owner and nothing else is written to it", async () => {
    const made = await handedOver("gm-ho-reason", [handoff({ reason: "explicit_human_request" })]);
    const before = (await readCase(made.c.caseId))!;
    await pass();
    expect(messageOf()).toContain("*Motif du relais :* le client demande à parler à une personne");
    const after = (await readCase(made.c.caseId))!;
    expect({ owner: after.owner, phase: after.phase, version: after.version }).toEqual({ owner: before.owner, phase: before.phase, version: before.version });
  });

  it("dedupe: repeated and concurrent admissions give one execution; concurrent passes give one message", async () => {
    const made = await handedOver("gm-ho-dedupe");
    const again = await Promise.all([enqueue(made.c.caseId), enqueue(made.c.caseId), enqueue(made.c.caseId)]);
    expect(again.every(result => result.ok && result.executionId === made.execution!.id && !result.created)).toBe(true);
    expect((await noticeRows()).filter(row => row.caseId === made.c.caseId)).toHaveLength(1);
    await Promise.all([pass(), pass(), pass()]);
    expect(posts()).toHaveLength(1);
    expect(slack.state.messages).toHaveLength(1);
    expect((await effectsOf(made.execution!.id)).filter(effect => effect.kind === "handoff_notify")).toHaveLength(1);
  });

  it("the sweep admits what the hook missed, once, and counts what is not a handoff", async () => {
    const hooked = await handedOver("gm-ho-sweep-hooked");
    const missed = await newCase("gm-ho-sweep-missed");
    expect(await investigate(missed.c.caseId, [handoff()], { hook: false })).toMatchObject({ status: "recorded", outcome: "accepted" });
    const nothing = await newCase("gm-ho-sweep-answer");
    kb.cards = [LOGIN];
    expect(await investigate(nothing.c.caseId, [answer], { hook: false })).toMatchObject({ status: "recorded", outcome: "accepted" });
    kb.cards = [];
    const since = testStart;
    const swept = await enqueueHandoffNotices({ policy: { id: policyId, hash: policyHash }, env: () => environment, since });
    expect(swept.created).toBe(1);
    expect(swept.existing).toBeGreaterThanOrEqual(1);
    expect(swept.refused).toMatchObject({ not_handoff: expect.any(Number) });
    expect((await noticeRows()).filter(row => row.caseId === missed.c.caseId)).toHaveLength(1);
    expect((await noticeRows()).filter(row => row.caseId === nothing.c.caseId)).toHaveLength(0);
    const second = await enqueueHandoffNotices({ policy: { id: policyId, hash: policyHash }, env: () => environment, since });
    expect(second.created).toBe(0);
    expect(hooked.execution).toBeDefined();
  });
});

const latestInputKey = async (caseId: string) => ((await listCaseEvents(caseId)).filter(event => event.kind === "observation_recorded").at(-1)!.detail!.record as { inputKey: string }).inputKey;

describe("no notice for anything that is not a final handoff decision", () => {
  async function expectNoNotice(caseId: string, extra: () => void = () => { }) {
    expect(await enqueue(caseId)).toMatchObject({ ok: false, code: expect.stringMatching(/no_trigger|case_unknown/) });
    const swept = await enqueueHandoffNotices({ policy: { id: policyId, hash: policyHash }, env: () => environment, since: testStart });
    expect((await noticeRows()).filter(row => row.caseId === caseId)).toHaveLength(0);
    expect(swept.examined).toBeGreaterThan(0);
    expect(await pass()).toEqual({ skipped: "nothing_due" });
    expect(slack.state.calls).toHaveLength(0);
    extra();
  }
  const withKb = () => { kb.cards = [LOGIN]; };

  it("a draft to validate (accepted answer): no notice", async () => {
    withKb(); const made = await newCase("gm-no-answer");
    expect(await investigate(made.c.caseId, [answer])).toMatchObject({ status: "recorded", outcome: "accepted" });
    await expectNoNotice(made.c.caseId);
    expect(hookCalls).toBe(1);
  });

  it("a question to the customer (waiting for the customer): no notice", async () => {
    const made = await newCase("gm-no-ask");
    expect(await investigate(made.c.caseId, [ask])).toMatchObject({ status: "recorded", outcome: "accepted" });
    await expectNoNotice(made.c.caseId);
  });

  it("an observation-only decision: no notice", async () => {
    const made = await newCase("gm-no-observe");
    expect(await investigate(made.c.caseId, [observeOnly])).toMatchObject({ status: "recorded", outcome: "accepted" });
    await expectNoNotice(made.c.caseId);
  });

  it("a decision sent to review (the validator refused every attempt): no notice", async () => {
    const made = await newCase("gm-no-review");
    const report = await investigate(made.c.caseId, Array.from({ length: SAV_CASE_INVESTIGATION_MAX_CALLS }, () => answer));
    expect(report).toMatchObject({ status: "recorded", outcome: "needs_review" });
    await expectNoNotice(made.c.caseId);
  });

  it("a retry in progress (technical failure, no decision): no notice", async () => {
    const made = await newCase("gm-no-retry");
    expect(await investigate(made.c.caseId, [], { callModel: () => ({ status: "failed", uncertain: false }) })).toMatchObject({ status: expect.stringMatching(/technical_wait|technical_exhausted|usage_uncertain/) });
    await expectNoNotice(made.c.caseId);
  });

  it("a case V2 did not admit (ambiguous identity): no investigation, no notice", async () => {
    const ticketId = String(++ticketSeq), threadId = randomUUID(), id = "gm-no-admit", ambiguous = { status: "ambiguous" } as Identity;
    const c = await mail(id, threadId, ticketId, { policy: POLICY, qualification: qualification([ruled(caseRequestId(id, "r1"))], ambiguous) });
    expect(await investigate(c.caseId, [handoff()], { identity: ambiguous })).toMatchObject({ status: "skipped", modelCalls: 0 });
    await expectNoNotice(c.caseId);
  });

  it("a case a person owns from the start (never taken by V2): no notice", async () => {
    const ticketId = String(++ticketSeq), threadId = randomUUID(), id = "gm-no-human";
    await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `gmail-${threadId}`, customerEmail: CUSTOMER });
    const opened = (await openCaseEvent({ ticketId, threadId, admission: byRule(caseRequestId(id, "r1")), opens: [], kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(id), sourceRef: { type: "email", id }, occurredAt: new Date().toISOString() })).case;
    await expectNoNotice(opened.caseId);
  });

  it("an unknown case and a disabled notice: nothing", async () => {
    expect(await enqueue(randomUUID())).toEqual({ ok: false, code: "case_unknown" });
    const made = await handedOver("gm-no-off");
    await f.client.exec("UPDATE sav.case_effect_executions SET state = 'refused' WHERE reply_key LIKE 'handoff-notice:%'");
    environment = { ...environment, SAV_HANDOFF_NOTICE: undefined };
    expect(await enqueue(made.c.caseId)).toEqual({ ok: false, code: "notice_off", why: "disabled" });
    expect(await pass()).toEqual({ skipped: "notice_off" });
  });
});

describe("a decision that stops being the final word is not announced", () => {
  it("a customer follow-up after durable transfer keeps the one team notification and never restarts the agent", async () => {
    const made = await handedOver("gm-stale");
    await secondMail("gm-stale-2", made.threadId, made.ticketId);
    expect(await readCase(made.c.caseId)).toMatchObject({ owner: "human", phase: "handoff_pending" });
    expect(await investigate(made.c.caseId, [handoff()])).toMatchObject({ status: "skipped", modelCalls: 0 });
    expect(await enqueue(made.c.caseId)).toMatchObject({ ok: true, executionId: made.execution!.id, created: false });
    expect(await pass()).toMatchObject({ processed: [{ executionId: made.execution!.id, state: "confirmed" }] });
    await pass();
    expect((await noticeRows()).filter(row => row.caseId === made.c.caseId)).toHaveLength(1);
    expect(posts()).toHaveLength(1);
  });

  it("a person who takes the case before the message leaves cancels it; no message", async () => {
    const made = await handedOver("gm-taken");
    await secondMail("gm-taken-2", made.threadId, made.ticketId);
    await transitionCaseOwner({ caseId: made.c.caseId, expectedVersion: (await readCase(made.c.caseId))!.version, transition: "human_takeover",
      actor: { type: "human", staffUserId: "20000000-0000-4000-8000-000000000003" }, commandKey: `cmd-${randomUUID()}`, reason: "fixture" });
    const result = await pass();
    expect(result).toMatchObject({ processed: [{ state: "refused", reason: expect.stringMatching(/^SAV_HANDOFF_NOTICE_CANCELLED_(TAKEN_BY_PERSON|STALE_INPUT)$/) }] });
    expect(slack.state.calls).toHaveLength(0);
    expect(await enqueue(made.c.caseId)).toMatchObject({ ok: false, code: "no_trigger" });
  });
});

describe("holds: nothing leaves, nothing is lost", () => {
  it("a policy that does not grant notify_case_handoff plans and sends nothing, and keeps the execution open", async () => {
    const made = await handedOver("gm-hold-policy");
    // The authority is the approved policy the configuration points at: a grant without the notice permission.
    const narrow = await approveIntakeExecutionPolicy({ ...policy, mutations: ["append_case_note"], maxDossiers: 9 });
    const wide = environment;
    environment = { ...environment, SAV_INTAKE_EXECUTION_POLICY_ID: narrow.id, SAV_INTAKE_EXECUTION_POLICY_SHA256: narrow.policyHash };
    const result = await pass();
    environment = wide;
    expect(result).toMatchObject({ processed: [{ executionId: made.execution!.id, state: "waiting", reason: "SAV_HANDOFF_NOTICE_MUTATION_NOT_GRANTED" }] });
    expect(await effectsOf(made.execution!.id)).toHaveLength(0);
    expect(slack.state.calls).toHaveLength(0);
    await pass();
    expect(posts()).toHaveLength(1);
  });

  it("pauses (V2 actions paused, then fully paused, then intake paused): nothing is claimed or sent; resumed, the one message goes", async () => {
    const made = await handedOver("gm-hold-pause");
    for (const [agent, level] of [["v2", "actions_paused"], ["v2", "fully_paused"], ["intake", "actions_paused"]] as const) {
      await setPause(agent, level);
      expect(await pass()).toMatchObject({ skipped: expect.stringMatching(/^SAV_INTAKE_AGENT_/) });
      await setPause(agent, null);
    }
    expect(slack.state.calls).toHaveLength(0);
    expect((await noticeRows()).find(row => row.id === made.execution!.id)).toMatchObject({ state: "pending" });
    await pass();
    expect(posts()).toHaveLength(1);
  });

  it("a pause that arrives AFTER the marker and before Slack takes the marker back: no message, then the message goes once", async () => {
    const made = await handedOver("gm-hold-late-pause");
    const driver = createHandoffNoticeDriver({ env: () => environment, crm });
    const real = (await import("./case-handoff-slack")).createHandoffSlackAdapters({ network: slack.network, env: () => environment });
    const withAdapters: ExecutionOptions = { ...options, adapters: { ...real, readCrm: async () => { throw Error("FORBIDDEN"); }, gmailCurrent: async () => { throw Error("FORBIDDEN"); }, gmailPermissions: async () => { throw Error("FORBIDDEN"); }, scope: () => { throw Error("FORBIDDEN"); } } };
    const result = await executeIntakePass(made.execution!.id, withAdapters, { afterMarker: () => setPause("v2", "actions_paused") }, driver);
    expect(result).toMatchObject({ state: "waiting" });
    expect(slack.state.calls).toHaveLength(0);
    expect((await effectsOf(made.execution!.id))[0]).toMatchObject({ state: "planned" });
    await setPause("v2", null);
    await pass();
    expect(posts()).toHaveLength(1);
  });

  it("the notice mode off stops the pass before any claim", async () => {
    const made = await handedOver("gm-hold-off");
    environment = { ...environment, SAV_HANDOFF_NOTICE: "off" };
    expect(await pass()).toEqual({ skipped: "notice_off" });
    expect((await noticeRows()).find(row => row.id === made.execution!.id)).toMatchObject({ state: "pending", leaseToken: null });
    expect(slack.state.calls).toHaveLength(0);
  });

  it("the execution policy mode off (no V1 execution configuration) stops the pass", async () => {
    await handedOver("gm-hold-exec-off");
    environment = { ...environment, SAV_INTAKE_EXECUTION_MODE: undefined };
    expect(await pass()).toEqual({ skipped: "execution_off" });
  });
});

describe("the CRM links are verified before the plan, and a failed reading waits", () => {
  it("a contact that does not carry the customer's address, or several, or none: the notice goes with no contact link and says so", async () => {
    const made = await handedOver("gm-crm-mismatch");
    crmReading = () => ({ ticket: { id: made.ticketId, archived: false }, contacts: [{ id: "778", firstname: "Autre", lastname: "Personne", emails: ["other@example.invalid"], archived: false }] });
    await pass();
    const text = messageOf();
    expect(text).toContain("contact non vérifié (aucun contact du ticket ne porte l'adresse du client), aucun lien proposé");
    expect(text).not.toContain("/record/0-1/");
    expect(text).toContain(`/record/0-5/${made.ticketId}`);
    expect(text).not.toContain("Autre Personne");
  });

  it("a ticket the CRM does not find gets no ticket link", async () => {
    await handedOver("gm-crm-noticket");
    crmReading = () => ({ ticket: null, contacts: [] });
    await pass();
    expect(messageOf()).toContain("ticket non vérifié (ticket introuvable dans le CRM), aucun lien proposé");
    expect(messageOf()).not.toContain("app.hubspot.com");
  });

  it("a CRM reading that fails plans nothing and sends nothing; the next pass reads again and sends once", async () => {
    const made = await handedOver("gm-crm-down");
    crmReading = () => new Error("SAV_HANDOFF_CRM_UNREADABLE");
    const down = await pass();
    expect(down).toMatchObject({ processed: [{ state: "waiting", reason: "SAV_HANDOFF_CRM_UNREADABLE" }] });
    expect(await effectsOf(made.execution!.id)).toHaveLength(0);
    expect(slack.state.calls).toHaveLength(0);
    crmReading = () => goodCrm(made.ticketId);
    await pass();
    expect(posts()).toHaveLength(1);
    expect(crmCalls).toBe(2);
  });

  it("the CRM is read once per notice: a verification pass never reads it again", async () => {
    await handedOver("gm-crm-once");
    slack.state.mode = "lose";
    await pass();
    expect(crmCalls).toBe(1);
    slack.state.mode = "ok"; await letReconcile();
    await pass();
    expect(crmCalls).toBe(1);
  });
});

describe("an uncertain Slack result is only verified, never posted again", () => {
  it("the answer is lost after Slack stored the message: the next pass finds it by its marker and confirms; exactly one message", async () => {
    const made = await handedOver("gm-uncertain-found");
    slack.state.mode = "lose";
    const first = await pass();
    expect(first).toMatchObject({ processed: [{ executionId: made.execution!.id, state: "uncertain" }] });
    expect(slack.state.messages).toHaveLength(1);
    expect((await effectsOf(made.execution!.id))[0]).toMatchObject({ state: expect.stringMatching(/^(dispatched|acked|uncertain)$/) });
    // Not due yet: the verification is scheduled, not immediate.
    expect(await pass()).toEqual({ skipped: "nothing_due" });
    slack.state.mode = "ok"; await letReconcile();
    const second = await pass();
    expect(second).toMatchObject({ processed: [{ executionId: made.execution!.id, state: "confirmed" }] });
    expect(posts()).toHaveLength(1);
    expect(slack.state.messages).toHaveLength(1);
    expect(slack.state.calls.filter(call => call.url.pathname === "/api/conversations.history")).not.toHaveLength(0);
  });

  it("the answer is lost and Slack never stored it: only reads follow (five at most), nothing is posted again, a person is left to look", async () => {
    const made = await handedOver("gm-uncertain-absent");
    slack.state.mode = "lose_before";
    await pass();
    expect(posts()).toHaveLength(1);
    slack.state.mode = "ok";
    for (let read = 0; read < 7; read++) { await letReconcile(); await pass(); }
    expect(posts()).toHaveLength(1);
    expect(slack.state.messages).toHaveLength(0);
    const [effect] = await effectsOf(made.execution!.id);
    expect(effect!.reconcileAttempts).toBeLessThanOrEqual(5);
    expect(effect!.state).not.toBe("planned");
    await letReconcile();
    expect(await pendingHandoffNoticeExecutions()).toEqual([]);
    expect((await noticeRows()).find(row => row.id === made.execution!.id)).toMatchObject({ state: "uncertain" });
  });

  it("a Slack that cannot be read for the verification leaves it uncertain without posting", async () => {
    const made = await handedOver("gm-uncertain-unreadable");
    slack.state.mode = "lose";
    await pass();
    slack.state.mode = "ok"; slack.state.historyBroken = true; await letReconcile();
    expect(await pass()).toMatchObject({ processed: [{ state: "uncertain" }] });
    expect(posts()).toHaveLength(1);
    expect((await effectsOf(made.execution!.id))[0]).not.toMatchObject({ state: "confirmed" });
  });
});

describe("a refusal by Slack itself (nothing posted) goes back to planned, a bounded number of times", () => {
  it("channel not found: the marker is taken back, no message, execution open; fixed, the message goes once", async () => {
    const made = await handedOver("gm-refused");
    slack.state.mode = "refuse"; slack.state.refusal = "channel_not_found";
    const first = await pass();
    expect(first).toMatchObject({ processed: [{ executionId: made.execution!.id, state: "waiting" }] });
    expect((await effectsOf(made.execution!.id))[0]).toMatchObject({ state: "planned" });
    expect(slack.state.messages).toHaveLength(0);
    slack.state.mode = "ok";
    await pass();
    expect(slack.state.messages).toHaveLength(1);
    expect((await noticeRows()).find(row => row.id === made.execution!.id)).toMatchObject({ state: "confirmed" });
  });

  it(`after ${HANDOFF_NOT_POSTED_RETRIES} refusals the effect is no longer taken back: it is verified and left to a person`, async () => {
    const made = await handedOver("gm-refused-many");
    slack.state.mode = "refuse"; slack.state.refusal = "not_in_channel";
    for (let attempt = 0; attempt <= HANDOFF_NOT_POSTED_RETRIES; attempt++) await pass();
    const [effect] = await effectsOf(made.execution!.id);
    expect(effect!.state).not.toBe("planned");
    expect(slack.state.messages).toHaveLength(0);
    const withdrawn = await f.db.select().from(savIntakeEffectJournal).where(and(eq(savIntakeEffectJournal.executionId, made.execution!.id), eq(savIntakeEffectJournal.kind, "dispatch_withdrawn")));
    expect(withdrawn).toHaveLength(HANDOFF_NOT_POSTED_RETRIES);
  });
});

describe("what is stored: no secret, no copy of a mail, no address", () => {
  it("the sealed payload, the ledger intent and the journal hold no token, no customer address and no owner id beyond the injected placeholder", async () => {
    const made = await handedOver("gm-privacy");
    await pass();
    const [row] = (await noticeRows()).filter(r => r.id === made.execution!.id);
    const payload = decryptSavPayload<Record<string, unknown>>(row!.payloadCiphertext);
    const sealed = JSON.stringify(payload);
    for (const forbidden of [TOKEN, CUSTOMER, "example.invalid", CHANNEL, "Bonjour, je n'arrive plus"]) expect(sealed).not.toContain(forbidden);
    expect(payload).toMatchObject({ contract: "sav-v2-handoff-notice.v1", teamOwnerId: OWNER });
    const [effect] = await effectsOf(made.execution!.id);
    const intent = JSON.stringify(decryptSavPayload(effect!.intentCiphertext));
    for (const forbidden of [TOKEN, CUSTOMER, "example.invalid", "Bonjour, je n'arrive plus"]) expect(intent).not.toContain(forbidden);
    const journal = await f.db.select().from(savIntakeEffectJournal).where(eq(savIntakeEffectJournal.executionId, made.execution!.id));
    expect(journal.map(entry => entry.kind)).toEqual(expect.arrayContaining(["handoff_notice_admitted", "effect_planned"]));
    const journalText = journal.map(entry => JSON.stringify(decryptSavPayload(entry.payloadCiphertext))).join("\n");
    for (const forbidden of [TOKEN, CUSTOMER, "Bonjour, je n'arrive plus"]) expect(journalText).not.toContain(forbidden);
    expect(JSON.stringify(slack.state.calls.map(call => call.body))).not.toContain(CUSTOMER);
    expect(messageOf()).not.toContain(OWNER);
  });

  it("the hostile model text is cleaned before it is sealed: no address, no link, no code reaches the channel", async () => {
    const made = await newCase("gm-hostile");
    crmReading = () => goodCrm(made.ticketId);
    await investigate(made.c.caseId, [handoff({ need: "Écrire à voleur@example.invalid via https://evil.example.invalid/x ou le code ABCD1234EFGH5678IJKL9", intervention: "Appeler le 06 12 34 56 78 <!channel>" })]);
    await pass();
    expect(messageOf()).not.toMatch(/voleur|evil\.example|ABCD1234|06 12 34|<!channel>/);
    expect(messageOf()).toContain("[adresse masquée]");
  });
});

describe("the other drivers never touch a notice", () => {
  it("the reply and recovery listings skip the notice executions", async () => {
    const made = await handedOver("gm-isolation");
    await f.client.exec(`UPDATE sav.case_effect_executions SET lease_until = NULL WHERE id = '${made.execution!.id}'`);
    expect((await pendingCaseEffectExecutions(20)).map(row => (row as { id: string }).id)).not.toContain(made.execution!.id);
    expect((await pendingCaseEffectRecoveries(20, new Date(Date.now() + 86_400_000))).map(row => JSON.stringify(row))).not.toContain(made.execution!.id);
    expect((await pendingHandoffNoticeExecutions(20)).map(row => row.id)).toContain(made.execution!.id);
  });
});

describe("review A10: the hostile model text through the real driver", () => {
  it("a one-time code, an address, a link, a phone number and a mention in the decision never reach the POST; the internal links and the reference stay", async () => {
    const made = await newCase("gm-a10");
    crmReading = () => goodCrm(made.ticketId);
    await investigate(made.c.caseId, [handoff({ need: `Écrire à voleur@example.invalid via https://evil.example.invalid/x ou le code de connexion 718236, mot de passe : Azerty123, jeton xoxb-${"1234".repeat(3)}-${"TEST".repeat(4)}`,
      intervention: "Appeler le 06 12 34 56 78 <!channel> avec le code 4455" })]);
    await pass();
    expect(posts()).toHaveLength(1);
    const posted = String(posts()[0]!.body?.text);
    expect(posted).not.toMatch(/voleur|evil\.example|718236|Azerty123|xoxb-1234|06 12 34|<!channel>|4455/);
    expect(posted).toContain("[adresse masquée]");
    expect(posted).toContain(`<https://app.hubspot.com/contacts/${PORTAL}/record/0-1/777|fiche contact HubSpot>`);
    expect(posted).toContain(`<https://app.hubspot.com/contacts/${PORTAL}/record/0-5/${made.ticketId}|ticket ${made.ticketId}>`);
    expect(posted).toMatch(/_Réf\. HO-[0-9a-f]{12}_$/);
  });
});
