import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { auditLogs, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown, detail: vi.fn(), complete: vi.fn(), invalid: vi.fn(), manualBinding: vi.fn(), manual: vi.fn(), release: vi.fn(),
  choice: vi.fn(), reinvestigate: vi.fn(), identification: vi.fn(), note: vi.fn(), panel: vi.fn(), operator: vi.fn(), seen: [] as unknown[], gate: null as null | (() => Promise<void>) }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => { throw Error("NO_SESSION_ON_MCP"); }, clerkClient: async () => { throw Error("NO_REAL_CLERK"); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/sav/intake/console-detail", () => ({ readIntakeConsoleDetail: state.detail }));
// Console server functions: replaced to observe exactly what the MCP passes and as whom they run.
const { as } = vi.hoisted(() => ({ as: (fn: (...args: unknown[]) => unknown) => async (...args: unknown[]) => {
  const { savRequestUser } = await import("@/lib/sav/intake/console-auth");
  state.seen.push((await savRequestUser())?.id); return fn(...args); } }));
vi.mock("@/lib/sav/external-completion", () => ({ completeSavDossierManually: as(state.complete) }));
vi.mock("@/lib/sav/intake/invalid-source-classification", () => ({ classifyInvalidSourceAsOther: as(state.invalid) }));
// SAV-71 eligibility: state.manualBinding gives the binding, or null for a bounded "not waiting" reason.
vi.mock("@/lib/sav/intake/manual-other-classification", () => ({ classifyValidSourceAsOther: as(state.manual),
  readManualOtherEligibility: as(async (...args: unknown[]) => { const binding = await state.manualBinding(...args); return binding ? { binding, reason: null } : { binding: null, reason: "not_waiting" }; }),
  manualOtherUnavailableLabels: { not_waiting: "Ce dossier n’attend pas un classement humain.", paused: "Une pause humaine protège ce dossier.", effects_engaged: "Une action engagée ou son résultat reste à vérifier." } }));
vi.mock("@/lib/sav/intake/human-hold-release", () => ({ releaseIntakeHumanHold: as(state.release) }));
vi.mock("@/lib/sav/intake/human-commands", () => ({ recordIntakeHumanCommand: as(state.choice) }));
vi.mock("@/lib/sav/intake/operator-recovery", () => ({ requestIntakeReinvestigation: as(state.reinvestigate), reconcileThreadIdentification: as(state.identification) }));
vi.mock("@/lib/sav/intake/note-recovery", () => ({ reconcileIntakeNoteForClosure: as(state.note) }));
vi.mock("@/lib/sav/intake-ux/operator-commands", () => ({ readOperatorPanel: as(state.panel), recordOperatorCommand: as(state.operator) }));
vi.mock("@/lib/sav/intake/agent-pause", async (original) => {
  const actual = await original<typeof import("@/lib/sav/intake/agent-pause")>();
  return { ...actual, readSavAgentPause: async (...args: Parameters<typeof actual.readSavAgentPause>) => {
    const result = await actual.readSavAgentPause(...args);
    if (state.gate) await state.gate();
    return result;
  } };
});
import { handleStudioMcpRequest, resetStudioMcpRateLimit } from "./server";
import { intakeVersionToken } from "./tools";
import { intakeRuntimeHash } from "@/lib/sav/intake/runtime-contract";

/** SAV-27/28/29/30/34: writes go through the console's own server functions, as the key's staff
 * member, on the exact version read, once per idempotency key, audited with channel mcp. Synthetic. */
let f: Awaited<ReturnType<typeof createSavTestDb>>;
const threadId = "10000000-0000-4000-8000-000000000001", messageId = "10000000-0000-4000-8000-000000000002", runId = "10000000-0000-4000-8000-000000000003";
const at = new Date("2026-10-21T10:00:00Z"), sourceHash = "a".repeat(64);
type User = { id: string; primaryEmailAddress: { emailAddress: string; verification: { status: string } } };
const user = (id: string, email: string): User => ({ id, primaryEmailAddress: { emailAddress: email, verification: { status: "verified" } } });
const ugo = user("user_ugo", "ugo@limova.ai"), reouven = user("user_reouven", "reouven@limova.ai"), contact = user("user_contact", "contact@limova.ai");
let current: User = ugo;
const base = () => ({ thread: { id: threadId, subject: "Synthétique", paused: false, ticketId: null }, projection: { epoch: 4, projectedEpoch: 4, view: "to_validate", status: "human_choice", reason: null },
  latestMessageId: messageId, handledExternally: false, humanHeld: false, confirmedCurrent: false, historyTruncated: false, diagnostics: null, choices: [] as unknown[],
  current: { id: runId, messageId, state: "observed", candidateContactIds: ["101", "102"], sourceHash, version: 7, sourceMatches: true, sourceInvalid: false,
    payload: { plan: { candidateContactIds: ["101", "102"], decision: { classification: "support", disposition: { kind: "ticket", target: { operation: "link", contactId: "101", ticketId: "201" } },
      evidence: [{ id: "t", source: "crm_ticket", sourceId: "201", observedAt: at.toISOString() }] } } } },
  messages: [{ id: messageId, direction: "inbound", fromEmail: "fiction@example.invalid", receivedAt: at, createdAt: at, body: { text: "Synthétique.", attachments: [] } }],
  progress: null as unknown });
let detail = base();
const token = () => intakeVersionToken(detail as never);
const key = () => crypto.randomUUID();
const env = { STUDIO_MCP_ENABLED: "true", STUDIO_MCP_WRITES_ENABLED: "true" };
async function call(name: string, args: Record<string, unknown>, flags: Record<string, string> = env) {
  const response = await handleStudioMcpRequest(new Request("https://studio.example.invalid/api/mcp", { method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer synthetic-token-0123456789" } }),
  { env: flags, resolveUser: async () => current as never });
  const body = await response.json() as { result?: { structuredContent?: { outcome: string; code: string; data?: unknown }; isError?: boolean } };
  return body.result?.structuredContent ?? { outcome: "error", code: "MCP_PROTOCOL", isError: body.result?.isError };
}
const writes = async () => (await f.db.select().from(auditLogs)).filter(a => a.action === "studio_mcp_write");
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  await f.client.exec("TRUNCATE public.staff_users, public.audit_logs, sav.sync_state CASCADE");
  await f.db.insert(staffUsers).values([{ clerkId: "user_ugo", email: "ugo@limova.ai", name: "Ugo", role: "admin" },
    { clerkId: "user_reouven", email: "reouven@limova.ai", name: "Reouven", role: "owner" }, { clerkId: "user_contact", email: "contact@limova.ai", name: "Contact", role: "member" }]);
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-mcp-writes-encryption-key");
  current = ugo; detail = base(); state.seen = []; state.gate = null; resetStudioMcpRateLimit();
  for (const fn of [state.complete, state.invalid, state.manualBinding, state.manual, state.release, state.choice, state.reinvestigate, state.identification, state.note, state.panel, state.operator]) fn.mockReset();
  state.detail.mockImplementation(async () => structuredClone(detail));
  state.complete.mockResolvedValue({ batchId: "b", requested: 1, marked: 1, alreadyCompleted: 0, skipped: {} });
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("SAV-24 write tools are absent while STUDIO_MCP_WRITES_ENABLED is off, and refused if called", async () => {
  const list = await (await handleStudioMcpRequest(new Request("https://studio.example.invalid/api/mcp", { method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer x-synthetic-key-0001" } }),
  { env: { STUDIO_MCP_ENABLED: "true" }, resolveUser: async () => current as never })).json() as { result: { tools: { name: string }[] } };
  expect(list.result.tools.map(t => t.name)).toEqual(expect.arrayContaining(["get_agent_pause", "get_dossier"]));
  expect(list.result.tools.map(t => t.name)).not.toContain("close_handled_outside");
  expect(await call("close_handled_outside", { threadId, versionToken: token(), idempotencyKey: key(), attestHandled: true }, { STUDIO_MCP_ENABLED: "true" })).toMatchObject({ outcome: "error" });
  expect(state.complete).not.toHaveBeenCalled();
});
it("SAV-28 close_handled_outside runs the console function as the key's staff member, on the version read", async () => {
  const idem = key();
  expect(await call("close_handled_outside", { threadId, versionToken: token(), idempotencyKey: idem, attestHandled: true })).toMatchObject({ outcome: "done" });
  expect(state.complete).toHaveBeenCalledExactlyOnceWith({ requestKey: idem, threadId, messageId, confirmed: true }, expect.any(Function));
  expect(state.seen).toEqual(["user_ugo"]);
  expect(await writes()).toMatchObject([{ actorEmail: "ugo@limova.ai", entityId: idem, technicalMetadata: { channel: "mcp", tool: "close_handled_outside", outcome: "done", threadId } }]);
});
it("SAV-27 a changed dossier, a token of another dossier or garbage are refused before any console function", async () => {
  const stale = token(); detail.projection.epoch = 5;
  expect(await call("close_handled_outside", { threadId, versionToken: stale, idempotencyKey: key(), attestHandled: true })).toMatchObject({ outcome: "refused", code: "SAV_MCP_DOSSIER_CHANGED" });
  const other = Buffer.from(JSON.stringify({ v: 1, threadId: "10000000-0000-4000-8000-000000000099" })).toString("base64url");
  for (const versionToken of [other, "not-a-token"]) expect(await call("release_hold", { threadId, versionToken, idempotencyKey: key(), reason: "Reprise synthétique demandée." })).toMatchObject({ code: "SAV_MCP_VERSION_TOKEN_INVALID" });
  expect(state.complete).not.toHaveBeenCalled(); expect(state.release).not.toHaveBeenCalled();
});
it("SAV-27 same key and request returns the first outcome without running twice; same key, other request is refused", async () => {
  const idem = key(), args = { threadId, versionToken: token(), idempotencyKey: idem, attestHandled: true };
  await call("close_handled_outside", args);
  expect(await call("close_handled_outside", args)).toMatchObject({ outcome: "already_done" });
  expect(state.complete).toHaveBeenCalledTimes(1);
  detail.humanHeld = true; detail.projection.status = "human_hold";
  expect(await call("release_hold", { threadId, versionToken: token(), idempotencyKey: idem, reason: "Une autre demande synthétique." })).toMatchObject({ outcome: "refused", code: "SAV_MCP_IDEMPOTENCY_CONFLICT" });
  current = contact;
  expect(await call("close_handled_outside", args)).toMatchObject({ outcome: "refused", code: "SAV_MCP_IDEMPOTENCY_CONFLICT" });
  expect(state.release).not.toHaveBeenCalled();
});
it("SAV-28 the console's restrictions hold: owner operator only, explicit attestation, real outcomes", async () => {
  for (const who of [reouven, contact]) { current = who; expect(await call("close_handled_outside", { threadId, versionToken: token(), idempotencyKey: key(), attestHandled: true })).toMatchObject({ code: "SAV_MCP_ACTION_UNAVAILABLE" }); }
  current = ugo;
  expect(await call("close_handled_outside", { threadId, versionToken: token(), idempotencyKey: key(), attestHandled: false })).toMatchObject({ outcome: "error" });
  state.complete.mockResolvedValueOnce({ batchId: "b", requested: 1, marked: 0, alreadyCompleted: 0, skipped: { active_worker: 1 } });
  expect(await call("close_handled_outside", { threadId, versionToken: token(), idempotencyKey: key(), attestHandled: true })).toMatchObject({ code: "SAV_MCP_ACTIVE_WORKER" });
  state.complete.mockResolvedValueOnce({ batchId: "b", requested: 1, marked: 0, alreadyCompleted: 0, skipped: { unsettled_action: 1 } });
  expect(await call("close_handled_outside", { threadId, versionToken: token(), idempotencyKey: key(), attestHandled: true })).toMatchObject({ code: "SAV_MCP_UNSETTLED_ACTION" });
  state.complete.mockResolvedValueOnce({ batchId: "b", requested: 1, marked: 0, alreadyCompleted: 1, skipped: {} });
  expect(await call("close_handled_outside", { threadId, versionToken: token(), idempotencyKey: key(), attestHandled: true })).toMatchObject({ outcome: "already_done" });
  state.complete.mockRejectedValueOnce(Error("SAV_EXTERNAL_COMPLETION_V0_ONLY"));
  expect(await call("close_handled_outside", { threadId, versionToken: token(), idempotencyKey: key(), attestHandled: true })).toMatchObject({ outcome: "refused", code: "SAV_EXTERNAL_COMPLETION_V0_ONLY" });
});
it("SAV-30 release_hold passes the epoch read and the reason, administrators only, replay is already_done", async () => {
  detail.humanHeld = true; detail.projection.status = "human_hold";
  state.release.mockResolvedValueOnce({ released: true, replayed: false }).mockResolvedValueOnce({ released: false, replayed: true });
  const idem = key();
  expect(await call("release_hold", { threadId, versionToken: token(), idempotencyKey: idem, reason: "Reprise synthétique demandée." })).toMatchObject({ outcome: "done" });
  expect(state.release).toHaveBeenCalledWith({ requestKey: idem, threadId, messageId, expectedEpoch: 4, reason: "Reprise synthétique demandée." });
  expect(await call("release_hold", { threadId, versionToken: token(), idempotencyKey: key(), reason: "Reprise synthétique demandée." })).toMatchObject({ outcome: "already_done" });
  current = contact;
  expect(await call("release_hold", { threadId, versionToken: token(), idempotencyKey: key(), reason: "Reprise synthétique demandée." })).toMatchObject({ code: "SAV_MCP_ACTION_UNAVAILABLE" });
  detail.humanHeld = false; current = ugo;
  expect(await call("release_hold", { threadId, versionToken: token(), idempotencyKey: key(), reason: "Reprise synthétique demandée." })).toMatchObject({ code: "SAV_MCP_ACTION_UNAVAILABLE" });
  expect(state.release).toHaveBeenCalledTimes(2);
});
it("SAV-30 record_choice binds the run, version, source and candidates read; refuses non-candidates and malformed kinds", async () => {
  state.choice.mockResolvedValue({ eventId: "e1", status: "recorded" });
  const idem = key();
  expect(await call("record_choice", { threadId, versionToken: token(), idempotencyKey: idem, kind: "select", contactId: "102", ticketId: "201", reason: "Choix synthétique justifié." })).toMatchObject({ outcome: "done" });
  expect(state.choice).toHaveBeenCalledWith({ commandKey: idem, threadId, messageId, runId, version: 7, sourceHash, candidatesHash: intakeRuntimeHash(["101", "102"]),
    kind: "select", contactId: "102", ticketId: "201", reason: "Choix synthétique justifié." });
  for (const bad of [{ kind: "select", contactId: "999" }, { kind: "select", contactId: "101", ticketId: "999" }]) expect(await call("record_choice", { threadId, versionToken: token(), idempotencyKey: key(), reason: "Choix synthétique justifié.", ...bad })).toMatchObject({ code: "SAV_MCP_NOT_A_CANDIDATE" });
  for (const bad of [{ kind: "classify" }, { kind: "refuse", contactId: "101" }, { kind: "select" }]) expect(await call("record_choice", { threadId, versionToken: token(), idempotencyKey: key(), reason: "Choix synthétique justifié.", ...bad })).toMatchObject({ outcome: "refused" });
  expect(await call("record_choice", { threadId, versionToken: token(), idempotencyKey: key(), kind: "classify", classification: "other", reason: "Classification synthétique." })).toMatchObject({ outcome: "done" });
  state.choice.mockRejectedValueOnce(Error("SAV_INTAKE_HUMAN_CONFLICT"));
  expect(await call("record_choice", { threadId, versionToken: token(), idempotencyKey: key(), kind: "refuse", reason: "Refus synthétique justifié." })).toMatchObject({ code: "SAV_INTAKE_HUMAN_CONFLICT" });
  detail.choices = [{ kind: "x", state: "pending" }];
  expect(await call("record_choice", { threadId, versionToken: token(), idempotencyKey: key(), kind: "refuse", reason: "Refus synthétique justifié." })).toMatchObject({ code: "SAV_MCP_ACTION_UNAVAILABLE" });
  expect(state.choice).toHaveBeenCalledTimes(3);
});
it("SAV-29 reinvestigation, note and identification reconciliation go to the console functions, administrators only", async () => {
  state.reinvestigate.mockResolvedValue({ eventId: "e2", runId }); state.identification.mockResolvedValue({ confirmed: 1 }); state.note.mockResolvedValue({});
  const idem = key();
  expect(await call("request_reinvestigation", { threadId, versionToken: token(), idempotencyKey: idem, reason: "Nouvelle analyse synthétique." })).toMatchObject({ outcome: "done" });
  expect(state.reinvestigate).toHaveBeenCalledWith({ threadId, messageId, reason: "Nouvelle analyse synthétique.", commandKey: idem }, { threadId, messageId, runId, version: 7, sourceHash, epoch: 4 });
  expect(await call("reconcile_identification", { threadId, versionToken: token() })).toMatchObject({ outcome: "done", data: { confirmed: 1 } });
  expect(state.identification).toHaveBeenCalledWith(threadId);
  expect(await call("reconcile_note", { threadId, versionToken: token() })).toMatchObject({ code: "SAV_MCP_ACTION_UNAVAILABLE" });
  detail.progress = { runId, effects: [{ id: "n", kind: "note_create", state: "uncertain", confirmedAt: null, ack: { id: "301" } }] };
  expect(await call("reconcile_note", { threadId, versionToken: token() })).toMatchObject({ outcome: "done" });
  expect(state.note).toHaveBeenCalledWith({ threadId, messageId });
  state.note.mockRejectedValueOnce(Error("SAV_INTAKE_NOTE_RECONCILIATION_REQUIRED"));
  expect(await call("reconcile_note", { threadId, versionToken: token() })).toMatchObject({ code: "SAV_INTAKE_NOTE_RECONCILIATION_REQUIRED" });
  current = contact;
  for (const [name, extra] of [["request_reinvestigation", { idempotencyKey: key(), reason: "Nouvelle analyse synthétique." }], ["reconcile_identification", {}]] as const)
    expect(await call(name, { threadId, versionToken: token(), ...extra })).toMatchObject({ code: "SAV_MCP_ACTION_UNAVAILABLE" });
});
it("continue_dossier follows the operator panel's allowances and binding", async () => {
  state.panel.mockResolvedValue({ allowResume: false, allowReanalysis: true, allowInformation: true, unavailableReason: "Protégé (synthétique).", information: { id: "10000000-0000-4000-8000-000000000050" } });
  state.operator.mockResolvedValue({ status: "recorded" });
  expect(await call("continue_dossier", { threadId, versionToken: token(), idempotencyKey: key(), kind: "resume", reason: "Reprise synthétique demandée." })).toMatchObject({ code: "SAV_MCP_ACTION_UNAVAILABLE" });
  const idem = key();
  expect(await call("continue_dossier", { threadId, versionToken: token(), idempotencyKey: idem, kind: "information", reason: "Information synthétique ajoutée.", information: "Version 4.2" })).toMatchObject({ outcome: "done" });
  expect(state.operator).toHaveBeenCalledWith({ requestKey: idem, threadId, messageId, runId, version: 7, sourceHash, kind: "information", reason: "Information synthétique ajoutée.",
    information: "Version 4.2", expectedInformationId: "10000000-0000-4000-8000-000000000050" });
  expect(await call("continue_dossier", { threadId, versionToken: token(), idempotencyKey: key(), kind: "reanalyse", reason: "Nouvelle analyse synthétique.", information: "x" })).toMatchObject({ code: "SAV_MCP_INVALID_INPUT" });
  expect(state.operator).toHaveBeenCalledTimes(1);
});
it("classify_other uses the console's manual-Other binding, owner operator only; invalid sources have their own tool", async () => {
  const binding = { revision: "r", threadId, messageId, runId, version: 7, runSourceHash: sourceHash, sourceHash, expectedEpoch: 4, attachmentCount: 0 };
  state.manualBinding.mockResolvedValue(binding); state.manual.mockResolvedValue({ batchId: "b", requested: 1, marked: 1, alreadyCompleted: 0, skipped: {} });
  const idem = key();
  expect(await call("classify_other", { threadId, versionToken: token(), idempotencyKey: idem, reason: "Notification automatique synthétique.", attest: true })).toMatchObject({ outcome: "done" });
  expect(state.manual).toHaveBeenCalledWith({ ...binding, requestKey: idem, reason: "Notification automatique synthétique.", confirmed: true });
  current = reouven;
  expect(await call("classify_other", { threadId, versionToken: token(), idempotencyKey: key(), reason: "Notification automatique synthétique.", attest: true })).toMatchObject({ code: "SAV_MCP_ACTION_UNAVAILABLE" });
  current = ugo;
  expect(await call("classify_invalid_source_other", { threadId, versionToken: token(), idempotencyKey: key(), attest: true })).toMatchObject({ code: "SAV_MCP_ACTION_UNAVAILABLE" });
  detail.current.sourceInvalid = true; state.invalid.mockResolvedValue({ batchId: "b", requested: 1, marked: 1, alreadyCompleted: 0, skipped: {} });
  expect(await call("classify_invalid_source_other", { threadId, versionToken: token(), idempotencyKey: key(), attest: true })).toMatchObject({ outcome: "done" });
  expect(state.manual).toHaveBeenCalledTimes(1); expect(state.invalid).toHaveBeenCalledTimes(1);
});
it("SAV-34 pause runs the real console function and guard: administrators only, expected level, audited", async () => {
  expect(await call("get_agent_pause", {})).toMatchObject({ outcome: "done", data: { state: { level: "running" } } });
  expect(await call("set_agent_pause", { level: "actions_paused", expectedLevel: "fully_paused", reason: "Test synthétique", idempotencyKey: key() })).toMatchObject({ code: "SAV_MCP_PAUSE_CHANGED" });
  expect(await call("set_agent_pause", { level: "actions_paused", expectedLevel: "running", reason: "Test synthétique", idempotencyKey: key() })).toMatchObject({ outcome: "done", data: { level: "actions_paused" } });
  expect(await call("get_agent_pause", {})).toMatchObject({ data: { state: { level: "actions_paused" }, history: [{ actor: "ugo@limova.ai", nextLevel: "actions_paused" }] } });
  expect(await call("set_agent_pause", { level: "actions_paused", expectedLevel: "actions_paused", reason: "Test synthétique", idempotencyKey: key() })).toMatchObject({ outcome: "already_done" });
  current = contact;
  expect(await call("set_agent_pause", { level: "fully_paused", expectedLevel: "actions_paused", reason: "Test synthétique", idempotencyKey: key() })).toMatchObject({ outcome: "refused", code: "SAV_AGENT_PAUSE_UNAUTHORIZED" });
  expect(await call("get_agent_pause", {})).toMatchObject({ outcome: "refused", code: "SAV_AGENT_PAUSE_UNAUTHORIZED" });
  await f.db.update(staffUsers).set({ active: false }).where(eq(staffUsers.clerkId, "user_ugo")); current = ugo;
  expect((await handleStudioMcpRequest(new Request("https://studio.example.invalid/api/mcp", { method: "POST", body: "{}", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer x" } }),
    { env, resolveUser: async () => current as never })).status).toBe(403);
  expect((await f.db.select().from(auditLogs)).filter(a => a.action === "sav_agent_pause_set")).toMatchObject([{ actorEmail: "ugo@limova.ai" }]);
});
it("get_dossier lists the actions available to this staff member with the page's conditions", async () => {
  state.panel.mockResolvedValue({ allowResume: true, allowReanalysis: false, allowInformation: false, unavailableReason: "x", information: null });
  state.manualBinding.mockResolvedValue(null);
  const actions = (await call("get_dossier", { threadId }) as { data: { availableActions: { tool: string; available: boolean }[] } }).data.availableActions;
  const available = Object.fromEntries(actions.map(a => [a.tool, a.available]));
  expect(available).toMatchObject({ close_handled_outside: true, release_hold: false, record_choice: true, continue_dossier: true, classify_other: false, reconcile_note: false });
  current = contact;
  const member = Object.fromEntries((await call("get_dossier", { threadId }) as { data: { availableActions: { tool: string; available: boolean }[] } }).data.availableActions.map(a => [a.tool, a.available]));
  expect(member).toMatchObject({ close_handled_outside: false, continue_dossier: false, record_choice: true, request_reinvestigation: false });
});
it("SAV-23 the request identity is scoped to one call: concurrent calls never see each other's staff member, and nothing leaks outside", async () => {
  const { withSavRequestUser, requireIntakeConsoleStaff } = await import("@/lib/sav/intake/console-auth");
  const { executionAdministrator } = await import("@/lib/sav/intake/execution-policy");
  const slow = (who: User) => withSavRequestUser(who as never, async () => { await new Promise(r => setTimeout(r, 5)); return (await requireIntakeConsoleStaff()).email; });
  expect(await Promise.all([slow(ugo), slow(contact), slow(reouven)])).toEqual(["ugo@limova.ai", "contact@limova.ai", "reouven@limova.ai"]);
  await expect(withSavRequestUser(contact as never, () => executionAdministrator())).rejects.toThrow("SAV_INTAKE_EXECUTION_UNAUTHORIZED");
  expect((await withSavRequestUser(ugo as never, () => executionAdministrator())).email).toBe("ugo@limova.ai");
  await expect(requireIntakeConsoleStaff()).rejects.toThrow("NO_SESSION_ON_MCP");
});

// REVIEW776: only the initial outside-transaction reads are synchronized. The actual
// console setter, its real budget lock, writes and audits remain unmodified.
function twoInitialPauseReads() {
  let arrived = 0; let open!: () => void;
  const barrier = new Promise<void>(r => { open = r; });
  state.gate = async () => {
    arrived++;
    if (arrived === 2) { state.gate = null; open(); }
    await barrier;
  };
}
it("REVIEW776 expectedLevel must reject one of two writes decided on the same old level", async () => {
  twoInitialPauseReads();
  const results = await Promise.all([
    call("set_agent_pause", { level: "actions_paused", expectedLevel: "running", reason: "Pause synthétique A", idempotencyKey: key() }),
    call("set_agent_pause", { level: "fully_paused", expectedLevel: "running", reason: "Pause synthétique B", idempotencyKey: key() }),
  ]);
  expect(results.filter(r => r.outcome === "done")).toHaveLength(1);
  expect(results.filter(r => r.code === "SAV_MCP_PAUSE_CHANGED")).toHaveLength(1);
});
it("REVIEW776 concurrent retries with the same key perform one real pause change", async () => {
  twoInitialPauseReads();
  const args = { level: "fully_paused", expectedLevel: "running", reason: "Pause synthétique unique", idempotencyKey: key() };
  const results = await Promise.all([call("set_agent_pause", args), call("set_agent_pause", args)]);
  const changes = (await f.db.select().from(auditLogs)).filter(a => a.action === "sav_agent_pause_set");
  expect(changes).toHaveLength(1);
  expect(results.map(r => r.outcome).sort()).toEqual(["already_done", "done"]);
});
it("REVIEW776 concurrent different payloads with the same key must conflict", async () => {
  twoInitialPauseReads(); const idem = key();
  const results = await Promise.all([
    call("set_agent_pause", { level: "actions_paused", expectedLevel: "running", reason: "Pause synthétique A", idempotencyKey: idem }),
    call("set_agent_pause", { level: "fully_paused", expectedLevel: "running", reason: "Pause synthétique B", idempotencyKey: idem }),
  ]);
  expect(results.filter(r => r.code === "SAV_MCP_IDEMPOTENCY_CONFLICT")).toHaveLength(1);
  expect((await writes())).toHaveLength(1);
});
it("REVIEW776 no-op pause commands enforce the same administrator permission", async () => {
  // Adapted after SAV-34 (running is UI-only): the same no-op, on a pausing level set by the console.
  const { setSavAgentPause } = await import("@/lib/sav/intake/agent-pause-admin");
  const { withSavRequestUser } = await import("@/lib/sav/intake/console-auth");
  await withSavRequestUser(ugo as never, () => setSavAgentPause({ agent: "intake", level: "actions_paused", reason: "Fixture synthétique console" }));
  current = contact;
  expect(await call("set_agent_pause", { level: "actions_paused", expectedLevel: "actions_paused", reason: "Contrôle synthétique", idempotencyKey: key() }))
    .toMatchObject({ outcome: "refused", code: "SAV_AGENT_PAUSE_UNAUTHORIZED" });
});
it("REVIEW776 an audit failure after a committed pause must not assert no action was attempted", async () => {
  await f.client.exec(`CREATE OR REPLACE FUNCTION public.review_reject_mcp_audit() RETURNS trigger AS $$
    BEGIN IF NEW.action = 'studio_mcp_write' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER review_mcp_audit_failure BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.review_reject_mcp_audit();`);
  try {
    const result = await call("set_agent_pause", { level: "fully_paused", expectedLevel: "running", reason: "Pause synthétique audit", idempotencyKey: key() });
    const changes = (await f.db.select().from(auditLogs)).filter(a => a.action === "sav_agent_pause_set");
    expect(changes).toHaveLength(1);
    expect(result).not.toMatchObject({ outcome: "refused", code: "MCP_INTERNAL_ERROR" });
  } finally { await f.client.exec("DROP TRIGGER review_mcp_audit_failure ON public.audit_logs; DROP FUNCTION public.review_reject_mcp_audit()"); }
});

// REVIEW776 witnesses: the guarantees around the reproductions, on the real pause setter and audit.
it("REVIEW776 witness: a sequential retry with the same key replays without a second change; a member cannot probe or replay", async () => {
  const args = { level: "fully_paused", expectedLevel: "running", reason: "Pause synthétique unique", idempotencyKey: key() };
  expect(await call("set_agent_pause", args)).toMatchObject({ outcome: "done" });
  expect(await call("set_agent_pause", args)).toMatchObject({ outcome: "already_done" });
  expect(await call("set_agent_pause", { ...args, level: "actions_paused" })).toMatchObject({ code: "SAV_MCP_IDEMPOTENCY_CONFLICT" });
  current = contact;
  for (const attempt of [args, { ...args, expectedLevel: "actions_paused", idempotencyKey: key() }, { ...args, level: "fully_paused", expectedLevel: "fully_paused", idempotencyKey: key() }])
    expect(await call("set_agent_pause", attempt)).toMatchObject({ outcome: "refused", code: "SAV_AGENT_PAUSE_UNAUTHORIZED" });
  expect((await f.db.select().from(auditLogs)).filter(a => a.action === "sav_agent_pause_set")).toHaveLength(1);
  expect(await writes()).toHaveLength(1);
});
it("REVIEW776 witness: expectedSetAt refuses an intermediate change back to the same level (ABA)", async () => {
  const { setSavAgentPause } = await import("@/lib/sav/intake/agent-pause-admin");
  const { withSavRequestUser } = await import("@/lib/sav/intake/console-auth");
  const first = await call("set_agent_pause", { level: "fully_paused", expectedLevel: "running", expectedSetAt: null, reason: "Pause synthétique", idempotencyKey: key() }) as { data: { setAt: string } };
  // The resume in between happens on the console (running is UI-only since SAV-34).
  const second = await withSavRequestUser(ugo as never, () => setSavAgentPause({ agent: "intake", level: "running", reason: "Reprise synthétique console" }));
  expect(await call("set_agent_pause", { level: "fully_paused", expectedLevel: "running", expectedSetAt: second.setAt, reason: "Pause synthétique", idempotencyKey: key() })).toMatchObject({ outcome: "done" });
  expect(await call("set_agent_pause", { level: "actions_paused", expectedLevel: "fully_paused", expectedSetAt: first.data.setAt, reason: "Décision ancienne", idempotencyKey: key() }))
    .toMatchObject({ outcome: "refused", code: "SAV_MCP_PAUSE_CHANGED" });
  await expect(withSavRequestUser(ugo as never, () => setSavAgentPause({ agent: "intake", level: "running", reason: "Contrôle synthétique", expectedLevel: "running" }))).rejects.toThrow("SAV_AGENT_PAUSE_CHANGED");
  // The console page passes no precondition: unchanged behaviour.
  expect(await withSavRequestUser(ugo as never, () => setSavAgentPause({ agent: "intake", level: "running", reason: "Console synthétique" }))).toMatchObject({ level: "running" });
});
it("REVIEW776 witness: after a lost receipt the same key answers uncertain and never re-runs; an error after the claim is uncertain", async () => {
  await f.client.exec(`CREATE OR REPLACE FUNCTION public.review_reject_mcp_audit() RETURNS trigger AS $$
    BEGIN IF NEW.action = 'studio_mcp_write' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER review_mcp_audit_failure BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.review_reject_mcp_audit();`);
  const args = { level: "fully_paused", expectedLevel: "running", reason: "Pause synthétique audit", idempotencyKey: key() };
  const { STUDIO_MCP_CLAIM } = await import("./writes");
  try {
    expect(await call("set_agent_pause", args)).toMatchObject({ outcome: "done", data: { level: "fully_paused" } });
  } finally { await f.client.exec("DROP TRIGGER review_mcp_audit_failure ON public.audit_logs; DROP FUNCTION public.review_reject_mcp_audit()"); }
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + STUDIO_MCP_CLAIM.staleMs + 1);
  expect(await call("set_agent_pause", args)).toMatchObject({ outcome: "uncertain", code: "SAV_MCP_RESULT_UNCERTAIN" });
  vi.mocked(Date.now).mockRestore();
  expect((await f.db.select().from(auditLogs)).filter(a => a.action === "sav_agent_pause_set")).toHaveLength(1);
  state.complete.mockRejectedValueOnce(Error("synthetic network failure after commit"));
  const idem = key(), close = { threadId, versionToken: token(), idempotencyKey: idem, attestHandled: true };
  expect(await call("close_handled_outside", close)).toMatchObject({ outcome: "uncertain", code: "SAV_MCP_RESULT_UNCERTAIN" });
  expect(await call("close_handled_outside", close)).toMatchObject({ outcome: "uncertain" });
  expect(state.complete).toHaveBeenCalledTimes(1);
  expect(await writes()).toMatchObject([{ entityId: idem, technicalMetadata: { outcome: "uncertain" } }]);
});
it("REVIEW776 witness: refusals before any action claim nothing, and classify_other refuses a binding of another version", async () => {
  const stale = token(); detail.projection.epoch = 5;
  const idem = key();
  expect(await call("close_handled_outside", { threadId, versionToken: stale, idempotencyKey: idem, attestHandled: true })).toMatchObject({ code: "SAV_MCP_DOSSIER_CHANGED" });
  expect(await call("close_handled_outside", { threadId, versionToken: token(), idempotencyKey: idem, attestHandled: true })).toMatchObject({ outcome: "done" });
  state.manualBinding.mockResolvedValue({ revision: "r", threadId, messageId, runId, version: 8, runSourceHash: sourceHash, sourceHash, expectedEpoch: 5 });
  expect(await call("classify_other", { threadId, versionToken: token(), idempotencyKey: key(), reason: "Notification automatique synthétique.", attest: true })).toMatchObject({ code: "SAV_MCP_DOSSIER_CHANGED" });
  expect(state.manual).not.toHaveBeenCalled();
  state.detail.mockRejectedValueOnce(Error("synthetic read failure"));
  expect(await call("close_handled_outside", { threadId, versionToken: token(), idempotencyKey: key(), attestHandled: true })).toMatchObject({ outcome: "refused", code: "MCP_INTERNAL_ERROR" });
});
it("SAV-71 composition: get_dossier and classify_other give the page's manual-Other eligibility and its bounded reason", async () => {
  state.manualBinding.mockResolvedValue(null); state.panel.mockResolvedValue({ allowResume: false, allowReanalysis: false, allowInformation: false, unavailableReason: "x", information: null });
  const other = async () => (await call("get_dossier", { threadId }) as { data: { availableActions: { tool: string; available: boolean; unavailableReason?: string | null }[] } }).data.availableActions.find(a => a.tool === "classify_other");
  expect(await other()).toMatchObject({ available: false, unavailableReason: "Ce dossier n’attend pas un classement humain." });
  expect(await call("classify_other", { threadId, versionToken: token(), idempotencyKey: key(), reason: "Notification automatique synthétique.", attest: true }))
    .toMatchObject({ outcome: "refused", code: "SAV_MCP_ACTION_UNAVAILABLE", message: "Ce dossier n’attend pas un classement humain." });
  detail.humanHeld = true; state.manualBinding.mockClear();
  expect(await other()).toMatchObject({ available: false, unavailableReason: "Une pause humaine protège ce dossier." });
  expect(state.manualBinding).not.toHaveBeenCalled(); expect(state.manual).not.toHaveBeenCalled();
});

it("REVIEW-AE running remains UI-only and cannot be activated through the MCP", async () => {
  const { withSavRequestUser } = await import("@/lib/sav/intake/console-auth");
  const { setSavAgentPause } = await import("@/lib/sav/intake/agent-pause-admin");
  const { readSavAgentPause } = await import("@/lib/sav/intake/agent-pause");
  await withSavRequestUser(ugo as never, () => setSavAgentPause({ agent: "intake", level: "fully_paused", reason: "Synthetic fixture via console authority" }));
  const result = await call("set_agent_pause", { level: "running", expectedLevel: "fully_paused", reason: "Synthetic MCP resume must remain UI-only", idempotencyKey: key() });
  const after = await readSavAgentPause(f.db);
  expect({ applied: result.outcome === "done", level: after.level }).toEqual({ applied: false, level: "fully_paused" });
});
it.each(["close_handled_outside", "classify_invalid_source_other", "classify_other", "release_hold", "request_reinvestigation", "continue_dossier", "reconcile_note", "reconcile_identification"])("REVIEW-AE member cannot invoke restricted %s", async name => {
  current = contact; detail.humanHeld = name === "release_hold";
  state.panel.mockResolvedValue({ allowResume: true, allowReanalysis: true, allowInformation: true, information: null });
  const args: Record<string, unknown> = { threadId, versionToken: token(), idempotencyKey: key(), reason: "Synthetic explicit reviewer reason" };
  if (name === "close_handled_outside") { args.attestHandled = true; delete args.reason; }
  if (name === "classify_invalid_source_other") { args.attest = true; delete args.reason; }
  if (name === "classify_other") args.attest = true;
  if (name === "continue_dossier") args.kind = "resume";
  if (["reconcile_note", "reconcile_identification"].includes(name)) { delete args.idempotencyKey; delete args.reason; }
  expect(await call(name, args)).toMatchObject({ outcome: "refused", code: "SAV_MCP_ACTION_UNAVAILABLE" });
  for (const fn of [state.complete, state.invalid, state.manual, state.release, state.reinvestigate, state.operator, state.note, state.identification]) expect(fn).not.toHaveBeenCalled();
  if (["reconcile_note", "reconcile_identification"].includes(name)) expect((await writes()).every(row => row.technicalMetadata.outcome === "refused")).toBe(true);
  else expect(await writes()).toHaveLength(0);
});
it("REVIEW-AE read-only reconciliation keeps the member permission on a fresh request", async () => {
  current = contact;
  expect(await call("get_agent_pause", {})).toMatchObject({ outcome: "refused", code: "SAV_AGENT_PAUSE_UNAUTHORIZED" });
  expect(await call("get_diagnostics", { threadId })).toMatchObject({ outcome: "refused", code: "SAV_INTAKE_DIAGNOSTICS_FORBIDDEN" });
  expect(await writes()).toHaveLength(0);
});
it("SAV-34 witness: running is not offered by the MCP schema; pausing and reading every level remain", async () => {
  const list = await (await handleStudioMcpRequest(new Request("https://studio.example.invalid/api/mcp", { method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer x-synthetic-key-0001" } }),
  { env, resolveUser: async () => current as never })).json() as { result: { tools: { name: string; title: string; inputSchema: { properties: Record<string, { enum?: string[] }> } }[] } };
  const tool = list.result.tools.find(t => t.name === "set_agent_pause")!;
  expect(tool.inputSchema.properties.level.enum).toEqual(["actions_paused", "fully_paused"]);
  expect(tool.inputSchema.properties.expectedLevel.enum).toContain("running");
  expect(tool.title).not.toMatch(/relanc/i);
  expect(await call("set_agent_pause", { level: "running", expectedLevel: "running", reason: "Reprise interdite", idempotencyKey: key() })).not.toMatchObject({ outcome: "done" });
  expect(await call("set_agent_pause", { level: "actions_paused", expectedLevel: "running", reason: "Pause synthétique", idempotencyKey: key() })).toMatchObject({ outcome: "done" });
  expect(await call("get_agent_pause", {})).toMatchObject({ data: { state: { level: "actions_paused" } } });
  expect((await f.db.select().from(auditLogs)).filter(a => a.action === "sav_agent_pause_set")).toHaveLength(1);
});
