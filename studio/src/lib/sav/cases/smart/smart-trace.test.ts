import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../../test/sav-db";
const state = vi.hoisted(() => ({ db: null as unknown, detail: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
// get_dossier's intake part is not under test here: a minimal console detail and dossier view, so the tool's own output can be read.
vi.mock("@/lib/sav/intake/console-detail", () => ({ readIntakeConsoleDetail: async () => state.detail }));
vi.mock("@/lib/sav/intake/dossier-view", () => ({
  intakeDossierView: () => ({ current: null, plan: null, disposition: null, target: null, contacts: [], tickets: [], question: null, handoff: null, dirty: false, blocked: false, currentEffects: false }),
  intakeDossierActions: () => ({ administrator: false, operatorBinding: null, manualOther: null, closeHandledOutside: false, completionPrecheck: null, completionBlockers: [], classifyInvalidSource: false,
    releaseHold: false, recordChoice: false, administratorVerifications: false, noteReceipt: false }),
  readIntakeManualOther: async () => null, intakeEffectLabels: {}, intakeEffectStateLabels: {}, intakeRouteLabel: () => "", intakeEffectsTitle: () => "",
}));
import { savCaseEffectExecutions, savCases, savIntakeEffects, savIntakeExecutionPolicies, savMailboxes, savSyncState, savThreads, staffUsers } from "@/db/schema";
import { studioMcpTools, type StudioMcpContext } from "@/lib/mcp/tools";
import type { SavRetrievalCandidate } from "../../request-retrieval";
import { decryptSavPayload, encryptSavPayload } from "../../crypto";
import { emptyCaseBody, SAV_CASE_CONTRACT_REVISION, type CaseSnapshot } from "../case-types";
import type { CaseInvestigationModelRequest } from "../investigation-runner";
import { SAV_SMART_TRACE_WAIT_MS, smartCaseDecisionProvider } from "./smart-case-provider";
import { SMART_CONFORME, SMART_GOOD_REPLY, smartGoodDecision, smartReading, smartScriptedModel, type SmartScript } from "./smart-test-doubles";
import { buildSmartCaseTrace, fitSmartCaseTrace, SAV_SMART_TRACE_MAX_BYTES, type SmartCaseTrace } from "./smart-trace";
import { readSmartTracesForThread, SAV_SMART_TRACE_PREFIX, SAV_SMART_TRACE_PRUNE_KEY, smartCaseTraceStore } from "./smart-trace-store";

/*
 * Trace of the real smart turns (22/11), on the real store (PGlite), FICTIONAL data only, no network, no key. Proves: a turn records its needs,
 * searches and ranks, decision, texts, codes, calls and cost, encrypted; `get_dossier` and `list_v2_cases` return it; a failing recorder leaves
 * the turn's result unchanged; no customer text reaches a log.
 */
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId = "", policyId = "";
const AT = new Date("2026-11-21T08:00:00.000Z");
const MAIL = "Bonjour, le code de connexion fictif n'arrive pas. Merci";
// V2's approved prices (fictional): 0.3 USD / M input tokens, 2.5 USD / M output tokens → 1000 in + 200 out = 800 µUSD per call.
const POLICY = JSON.stringify({ revision: "syn", approvedBy: "00000000-0000-4000-8000-000000000001", approvedAt: "2026-11-01T00:00:00Z",
  embedding: { dailyCapMicroUsd: 1_000_000, reserveMicroUsdPerCall: 100, microUsdPerMillionInputTokens: 10 },
  model: { dailyCapMicroUsd: 1_000_000, reserveMicroUsdPerCall: 5_000, microUsdPerMillionInputTokens: 300_000, microUsdPerMillionOutputTokens: 2_500_000 } });
const ENV = { SAV_V2_ENTRY_SMART: "on", SAV_V2_SPEND_POLICY_JSON: POLICY };
const CARD = { id: "fiche-connexion", contentVersionId: "v3", title: "Se connecter", source: "fixture", verifiedAt: "2026-11-10T00:00:00Z", semanticScore: null,
  content: "Pour vous connecter, utilisez l'adresse e-mail de votre invitation. Si le code n'arrive pas, vérifiez le dossier des indésirables.", resolution: { steps: ["Ouvrir la page"] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } } as SavRetrievalCandidate;
const CARD2 = { ...CARD, id: "fiche-indesirables", contentVersionId: "v1", title: "Dossier des indésirables" } as SavRetrievalCandidate;

const requestOf = (caseId: string, patch: Partial<CaseInvestigationModelRequest> = {}): CaseInvestigationModelRequest => ({
  purpose: "decision", caseId, caseVersion: 4, inputKey: "in:e2", call: 1, subjectKey: "s", callKey: "s:call1", caseBudgetKey: `sav-case:${caseId}`,
  snapshot: { contractRevision: SAV_CASE_CONTRACT_REVISION, caseId, ticketId: "t-1", threadIds: [], version: 4, owner: "agent", phase: "queued", sensitivity: "none",
    createdAt: AT.toISOString(), updatedAt: AT.toISOString(), admissionInputVersion: 1, admission: { admission: "smart_support" },
    body: { ...emptyCaseBody(), openRequests: [{ id: "r1", family: "other", status: "open", openedAt: AT.toISOString() }] } } as unknown as CaseSnapshot,
  events: [], knowledge: [CARD, CARD2], coverage: null, feedback: [], closure: [],
  customerContext: { latestMessage: { at: AT.toISOString(), from: "customer", text: MAIL, truncated: false, subject: "Connexion", instructionLikeText: false }, thread: [] } as unknown as CaseInvestigationModelRequest["customerContext"],
  ...patch,
});
const provider = (script: SmartScript, trace?: Parameters<typeof smartCaseDecisionProvider>[0]["trace"]) =>
  smartCaseDecisionProvider({ model: smartScriptedModel(script).model, env: () => ENV, now: () => AT, maxInputBytes: () => 100_000, ...(trace ? { trace } : {}) });
const GOOD: SmartScript = { understand: { output: smartReading() }, decide: { output: smartGoodDecision() }, verify: { output: SMART_CONFORME } };
const logs: unknown[][] = [];
const store = () => smartCaseTraceStore({ env: () => ENV, now: () => AT, log: (event, fields) => logs.push([event, fields]) });

async function caseFixture() {
  const [thread] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "client@exemple.invalid" }).returning();
  const [row] = await f.db.insert(savCases).values({ ticketId: String(Math.floor(Math.random() * 1e9)), threadIds: [thread!.id], owner: "agent", phase: "queued", admissionTarget: "agent",
    contractRevision: SAV_CASE_CONTRACT_REVISION, payloadCiphertext: encryptSavPayload(emptyCaseBody()), createdAt: AT }).returning();
  return { caseId: row!.id, threadId: thread!.id };
}
async function storedTraces(caseId: string): Promise<SmartCaseTrace[]> {
  const rows = await f.db.select().from(savSyncState).where(like(savSyncState.key, `${SAV_SMART_TRACE_PREFIX}:${caseId}:%`));
  return rows.map(row => decryptSavPayload<SmartCaseTrace>(row.cursor!));
}
const allLogs = () => JSON.stringify([logs, ...[console.log, console.info, console.warn, console.error].map(fn => vi.mocked(fn).mock.calls)]);

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "smart-trace-fixture-key-32-chars!!!!!");
  f = await createSavTestDb(); state.db = f.db;
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-trace-admin", email: "trace-admin@exemple.invalid", role: "admin" }).returning();
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "support@exemple.invalid" }).returning();
  const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "fixture", state: "approved", administratorId: admin!.id, policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) }).returning();
  mailboxId = mailbox!.id; policyId = policy!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "smart-trace-fixture-key-32-chars!!!!!");
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
  for (const level of ["log", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  logs.length = 0; state.db = f.db;
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("trace des tours réels de l'agent SAV", () => {
  it("un tour enregistre besoins, recherches et rangs, décision, textes, contrôles, contre-lecture, appels et coût (chiffré)", async () => {
    const { caseId } = await caseFixture();
    const out = await provider(GOOD, store())(requestOf(caseId));
    expect(out.result.status).toBe("ok");
    const rows = await f.db.select().from(savSyncState).where(like(savSyncState.key, `${SAV_SMART_TRACE_PREFIX}:${caseId}:%`));
    expect(rows.map(row => row.key)).toEqual([`${SAV_SMART_TRACE_PREFIX}:${caseId}:in:e2:call1`]);
    // Stored encrypted: no customer text in clear in the row.
    expect(rows[0]!.cursor).not.toContain("connexion");
    const [trace] = await storedTraces(caseId);
    expect(trace).toMatchObject({
      v: 1, caseId, inputKey: "in:e2", call: 1, caseVersion: 4, kind: "turn", outcome: "reply",
      needs: [{ id: "n1", ask: "se connecter à son espace", search: "connexion code non reçu", theme: "connexion" }],
      searches: [{ kind: "initial", status: "ok", codes: ["circuit_cards"], found: [{ needId: "n1", cards: [
        { rank: 1, id: "fiche-connexion", version: "v3", title: "Se connecter" }, { rank: 2, id: "fiche-indesirables", version: "v1", title: "Dossier des indésirables" }] }] }],
      decision: { kind: "answer", handoffReason: null, brainOutcome: "reply" },
      cited: [{ id: "fiche-connexion", version: "v3", title: "Se connecter" }],
      replyProposed: SMART_GOOD_REPLY.trim(), question: null,
      checks: { first: [], second: null }, verdicts: { first: { verdict: "conforme", problems: [] }, second: null }, corrected: false, serverRefusals: [],
      modelCalls: 3, tokens: { input: 3_000, output: 600 }, costMicroUsd: 2_400,
    });
    expect(trace!.calls.map(call => call.kind)).toEqual(["understand", "decide", "verify"]);
  });

  it("une contre-lecture qui refuse puis une correction : codes, verdicts et appels enregistrés ; la seconde refus du validateur aussi", async () => {
    const { caseId } = await caseFixture();
    const refusing = { verdict: "non_conforme", problems: [{ code: "source_mismatch", sentence: "x" }] };
    await provider({ ...GOOD, verify: { output: refusing }, correct: { output: { decision: smartGoodDecision() } }, reverify: { output: SMART_CONFORME } }, store())(requestOf(caseId));
    const feedback = [{ code: "knowledge_not_valid" as const, label: "Fiche non valide.", path: "p", kind: "missing_information" as const }];
    await provider({}, store())(requestOf(caseId, { call: 3, feedback }));
    const traces = (await storedTraces(caseId)).sort((a, b) => a.call - b.call);
    expect(traces[0]).toMatchObject({ corrected: true, verdicts: { first: { verdict: "non_conforme", problems: ["source_mismatch"] }, second: { verdict: "conforme" } }, modelCalls: 5, costMicroUsd: 4_000 });
    expect(traces[1]).toMatchObject({ kind: "refused_twice", call: 3, outcome: null, decision: { kind: "handoff", handoffReason: "repeated_failure" }, serverRefusals: ["knowledge_not_valid"], modelCalls: 0, costMicroUsd: 0 });
    expect(traces[1]!.teamNote).toContain("knowledge_not_valid");
  });

  it("un enregistreur en échec (exception, base absente, lenteur) ne change jamais le résultat du tour", async () => {
    const { caseId } = await caseFixture();
    const reference = await provider(GOOD)(requestOf(caseId));
    expect(await provider(GOOD, () => { throw Error("BOOM"); })(requestOf(caseId))).toEqual(reference);
    expect(await provider(GOOD, async () => { throw Error("BOOM"); })(requestOf(caseId))).toEqual(reference);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let settled = false;
      const slow = provider(GOOD, () => new Promise<void>(() => undefined))(requestOf(caseId)).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(1_400);
      expect(settled).toBe(false);
      // Never delayed past the 1.5 s cap.
      await vi.advanceTimersByTimeAsync(SAV_SMART_TRACE_WAIT_MS - 1_400);
      expect(settled).toBe(true);
      expect(await slow).toEqual(reference);
    } finally { vi.useRealTimers(); }
    // The real store without a database: it logs a closed code with the case id only, and the turn is the same.
    state.db = null;
    expect(await provider(GOOD, store())(requestOf(caseId))).toEqual(reference);
    expect(logs).toEqual([["sav_smart_trace_write_failed", { caseId, call: 1, code: "NO_DB_ALLOWED" }]]);
    state.db = f.db;
    expect(await storedTraces(caseId)).toEqual([]);
  });

  it("aucun texte client dans les journaux (tour réussi, tour en échec d'écriture)", async () => {
    const { caseId } = await caseFixture();
    await provider(GOOD, store())(requestOf(caseId));
    state.db = null;
    await provider(GOOD, store())(requestOf(caseId));
    state.db = f.db;
    const text = allLogs();
    for (const secret of [MAIL, "code de connexion fictif", "se connecter à son espace", "connexion code non reçu", "Vous n'arrivez pas", "Se connecter"]) expect(text).not.toContain(secret);
  });

  it("get_dossier renvoie la trace des tours et la réponse confirmée ; list_v2_cases un résumé sans texte client", async () => {
    const { caseId, threadId } = await caseFixture();
    await provider(GOOD, store())(requestOf(caseId));
    const [execution] = await f.db.insert(savCaseEffectExecutions).values({ caseId, threadId, replyKey: randomUUID(), policyId, policyHash: "fixture",
      payloadCiphertext: encryptSavPayload({ validationId: randomUUID(), proposal: { text: "Texte fictif envoyé au client." } }) }).returning();
    await f.db.insert(savIntakeEffects).values({ executionId: execution!.id, businessKey: randomUUID(), kind: "reply_send", permission: "fixture", state: "confirmed", confirmedAt: AT,
      intentHash: "fixture", intentCiphertext: encryptSavPayload({}), dispatchedAt: AT, dispatchToken: randomUUID() });
    state.detail = { thread: { id: threadId, subject: "Connexion", paused: false }, latestMessageId: null, current: null, projection: { view: "processing", status: "processing", reason: null, epoch: 0 },
      uncertainty: null, humanHeld: false, handledExternally: false, progress: null, choices: [], completionBlockers: [], completionPrecheck: null, confirmedCurrent: false,
      messages: [], historyTruncated: false, executionAuthority: "valid" };
    const context = { user: {} as never, staff: { id: "s", email: "trace-admin@exemple.invalid", role: "admin", name: null } } as StudioMcpContext;
    const tool = (name: string) => studioMcpTools.find(row => row.name === name)!;
    const dossier = await tool("get_dossier").run(context, { threadId } as never) as { outcome: string; data: { smartTrace: Awaited<ReturnType<typeof readSmartTracesForThread>> } };
    expect(dossier.outcome).toBe("done");
    expect(dossier.data.smartTrace).toMatchObject({ available: true, cases: [{ caseId,
      summary: { turns: 1, lastDecision: "answer", handoffReason: null, cited: [{ id: "fiche-connexion", title: "Se connecter" }], checkCodes: [], modelCalls: 3, costMicroUsd: 2_400 },
      turns: [{ needs: [{ search: "connexion code non reçu" }], replyProposed: SMART_GOOD_REPLY.trim() }],
      sentReplies: [{ executionId: execution!.id, confirmedAt: AT.toISOString(), text: "Texte fictif envoyé au client." }] }] });
    const listed = await tool("list_v2_cases").run(context, { from: "2026-11-21T00:00:00Z", until: "2026-11-22T00:00:00Z", limit: 100 } as never) as { data: { rows: Array<{ caseId: string; smart: unknown }> } };
    const row = listed.data.rows.find(entry => entry.caseId === caseId)!;
    expect(row.smart).toMatchObject({ turns: 1, lastDecision: "answer", fiches: [{ id: "fiche-connexion", title: "Se connecter" }, { id: "fiche-indesirables", title: "Dossier des indésirables" }] });
    expect(JSON.stringify(row.smart)).not.toMatch(/connecter à son espace|connexion code non reçu|Vous n'arrivez pas/);
    // A non-admin staff member gets the dossier, with the field present but null (it holds customer text).
    for (const role of ["agent", "support", "viewer"]) {
      const other = await tool("get_dossier").run({ ...context, staff: { ...context.staff, role } }, { threadId } as never) as { outcome: string; data: Record<string, unknown> };
      expect(other.outcome).toBe("done");
      expect(other.data).toHaveProperty("smartTrace", null);
      expect(JSON.stringify(other.data)).not.toMatch(/connexion code non reçu|Vous n'arrivez pas|Texte fictif envoyé/);
    }
  });

  it("purge des traces de plus de 30 jours : au plus une fois par heure", async () => {
    await f.db.delete(savSyncState).where(like(savSyncState.key, "sav-v2-smart-trace%"));
    const old = (id: string) => f.db.insert(savSyncState).values({ key: `${SAV_SMART_TRACE_PREFIX}:${id}:in:x:call1`, status: "done", cursor: "x", startedAt: new Date(AT.getTime() - 31 * 86_400_000) });
    const at = (ms: number) => smartCaseTraceStore({ env: () => ENV, now: () => new Date(AT.getTime() + ms), log: (event, fields) => logs.push([event, fields]) });
    const trace = buildSmartCaseTrace({ request: requestOf(randomUUID()), result: null, proposal: null, searches: [], at: AT });
    const deletes = vi.spyOn(f.db, "delete");
    const oldIds = () => f.db.select().from(savSyncState).where(like(savSyncState.key, `${SAV_SMART_TRACE_PREFIX}:old-%`));
    await old("old-1");
    await at(0)(trace);
    expect(await oldIds()).toEqual([]);
    expect(deletes).toHaveBeenCalledTimes(1);
    // Within the hour: the marker refuses the slot, no delete runs, the old row stays.
    await old("old-2");
    await at(30 * 60_000)(trace);
    await at(59 * 60_000)(trace);
    expect(deletes).toHaveBeenCalledTimes(1);
    expect((await oldIds()).length).toBe(1);
    // After the hour: one prune again.
    await at(61 * 60_000)(trace);
    expect(deletes).toHaveBeenCalledTimes(2);
    expect(await oldIds()).toEqual([]);
    const [marker] = await f.db.select().from(savSyncState).where(like(savSyncState.key, SAV_SMART_TRACE_PRUNE_KEY));
    expect(marker!.completedAt).toEqual(new Date(AT.getTime() + 61 * 60_000));
    expect(logs).toEqual([]);
  });

  it("taille bornée : une trace énorme reste sous la limite", () => {
    const base = buildSmartCaseTrace({ request: requestOf(randomUUID()), result: null, proposal: null, searches: [], at: AT });
    const huge: SmartCaseTrace = { ...base, replyProposed: "x".repeat(6_000), teamNote: "y".repeat(3_000), reasons: Array(40).fill("r".repeat(80)),
      searches: Array(6).fill({ kind: "tool", status: "ok", codes: Array(12).fill("c".repeat(60)), found: Array(9).fill({ needId: "n1", cards: Array(6).fill({ rank: 1, id: "i".repeat(80), version: "v".repeat(80), title: "t".repeat(160) }) }) }) };
    expect(Buffer.byteLength(JSON.stringify(fitSmartCaseTrace(huge)))).toBeLessThanOrEqual(SAV_SMART_TRACE_MAX_BYTES);
  });
});
