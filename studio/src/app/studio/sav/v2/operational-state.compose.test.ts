import { randomUUID } from "node:crypto";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../../test/sav-db";
const state = vi.hoisted(() => ({ db: null as unknown, dbReads: 0, decrypted: [] as string[], staff: vi.fn(), calls: [] as unknown[][], redirect: null as null | { caseId: string; validationId: string }, breakDb: false, fixtureAdmin: null as null | Record<string, unknown> }));
vi.mock("@/db", () => ({ requireDb: () => { state.dbReads += 1; if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("@/lib/sav/crypto", async importOriginal => {
  const real = await importOriginal<typeof import("@/lib/sav/crypto")>();
  return { ...real, decryptSavPayload: (ciphertext: string) => { state.decrypted.push(ciphertext); return real.decryptSavPayload(ciphertext); } };
});
// The REAL C9 reader runs. The wrapper records its arguments (and the access verdict), can ask it about forged ids, or give it a database that fails.
vi.mock("@/lib/sav/cases/case-operational-read", async importOriginal => {
  const real = await importOriginal<typeof import("@/lib/sav/cases/case-operational-read")>();
  return { ...real, readCaseReplyOperationalState: async (input: { caseId: string; validationId: string }, deps: Parameters<typeof real.readCaseReplyOperationalState>[1]) => {
    state.calls.push([input, await deps?.access?.()]);
    if (!state.breakDb) return real.readCaseReplyOperationalState(state.redirect ?? input, deps);
    const held = state.db;
    state.db = new Proxy(held as object, { get: (target, key) => key === "transaction" ? () => { throw Error("SYN_DB_DOWN"); } : (target as Record<string | symbol, unknown>)[key] });
    try { return await real.readCaseReplyOperationalState(input, deps); } finally { state.db = held; }
  } };
});
// Only the page's guard is a double; the other exports some of C's entry-point modules import are inert (never reached here).
// The policy grant of the fixture needs an administrator, as in C9's own tests: granted only while the fixture is set up, refused afterwards.
vi.mock("@/lib/sav/intake/console-auth", () => ({ requireIntakeConsoleStaff: state.staff, savRequestUser: async () => (state.fixtureAdmin ? { id: "synthetic-admin" } : null),
  authorizeSavStaffUser: async () => { if (!state.fixtureAdmin) throw Error("NOT_USED_IN_THIS_TEST"); return state.fixtureAdmin; },
  withSavRequestUser: <T,>(_user: unknown, work: () => Promise<T>) => work() }));
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => createElement("a", props) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw Error("NOT_FOUND"); }, usePathname: () => "/studio/sav/v2/1", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ back: vi.fn(), refresh: vi.fn() }) }));
import { eq } from "drizzle-orm";
import { savMailboxes, savMessages, savThreads, staffUsers } from "@/db/schema";
import { encryptSavPayload } from "@/lib/sav/crypto";
import { approveIntakeExecutionPolicy, type ExecutionPolicy } from "@/lib/sav/intake/execution-policy";
import { caseNoteAssociationKey, caseNoteKey, inboundInteractionId } from "@/lib/sav/cases/case-effects";
import { getCaseReplyEffect } from "@/lib/sav/cases/case-reply-registry";
import { decideCaseReply } from "@/lib/sav/cases/case-reply-store";
import { savCaseReplyValidations } from "@/lib/sav/cases/case-reply-validation-table";
import { proposeCaseReplyFromDraft, queueValidatedCaseReply } from "@/lib/sav/cases/case-runtime-effects";
import { openCaseEvent, readCase } from "@/lib/sav/cases/case-store";
import { caseDedupeKey } from "@/lib/sav/cases/case-types";
import CasePage from "./[ticketId]/page";

// UX lot 10, vertical probe on the local merge of pole C9 1c28928 into UX 06b4761 (base: proof 0131 ad9744a), PGlite with the real migrations. The reply is
// proposed, decided and queued by pole C's REAL entry points (proposeCaseReplyFromDraft, decideCaseReply, queueValidatedCaseReply); the ledger rows at the
// verification limit are written with SQL exactly as C9's own fixtures do (`putEffect`), since the executor cannot produce them on demand. The page reads them
// through C9's REAL reader. Doubles: the staff check, the db handle (counted), decryption (spied), the ticket-owner port. Synthetic data; fetch throws; no send.
type Db = Awaited<ReturnType<typeof createSavTestDb>>;
const STAFF = "20000000-0000-4000-8000-000000000003", AT = "2026-10-27T09:00:00.000Z", POLICY = "policy-r1";
const ADMITTED = {
  policy: { revision: POLICY, admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT },
  qualification: { requests: [{ requestId: "r1", family: "access" as const, provenance: { kind: "human" as const, staffUserId: STAFF, at: AT } }],
    identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-1" } }, crmContext: "complete" as const, teamSignals: [] },
};
const deps = { env: () => ({ SAV_CASE_EFFECTS: "supervised" }), readTicketOwner: async () => "v2" as const, currentPolicyRevision: async () => POLICY };
let f: Db, mailboxId = "", policy = { id: "", hash: "" }, ticket = 9_970_000;
const PERSON = "Vérification arrivée à sa limite : une personne doit regarder. Aucun renvoi ni remise à zéro automatique.";

/** A case, its stored mail, a reply proposed by C's entry point, decided through C's store (fixture authorizer) and queued with a note. */
async function queuedReply() {
  const gmailMessageId = `gm-${randomUUID()}`, ticketId = String(ticket++);
  const thread = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: `t-${randomUUID()}`, customerEmail: "customer@example.invalid" }).returning())[0]!;
  await f.db.insert(savMessages).values({ threadId: thread.id, mailboxId, direction: "inbound", gmailMessageId, fromEmail: "customer@example.invalid", toEmails: ["support@example.invalid"],
    subject: "Synthetic", bodyCiphertext: encryptSavPayload({ text: "Synthetic.", headers: { "message-id": "<in@example.invalid>" }, attachments: [] }), receivedAt: new Date("2026-10-28T07:00:00.000Z") });
  const { case: opened } = await openCaseEvent({ ticketId, threadId: thread.id, admission: ADMITTED, kind: "inbound_confirmed",
    dedupeKey: caseDedupeKey.inbound(gmailMessageId), sourceRef: { type: "email", id: gmailMessageId }, occurredAt: "2026-10-28T07:00:00.000Z" });
  const proposed = await proposeCaseReplyFromDraft({ caseId: opened.caseId, triggerEventId: `inbound:${gmailMessageId}`, decidedOn: (await readCase(opened.caseId))!.version,
    language: { code: "fr", proven: true }, reply: { purpose: "answer", text: "Bonjour,\n\nVoici la marche synthétique." } }, deps);
  if (!proposed.ok) throw Error(`PROPOSE:${proposed.code}`);
  const seen = (await getCaseReplyEffect({ validationId: proposed.validationId, caseId: opened.caseId }, deps))!;
  const decided = await decideCaseReply({ action: "approve", validationId: proposed.validationId, approverId: STAFF, authorizer: () => ({ allowed: true, basis: "fixture.allow" }), deps,
    seen: { payloadHash: seen.payloadHash, caseVersion: seen.caseVersion, recipient: seen.recipient } });
  if (!decided.ok) throw Error(`DECIDE:${decided.code}`);
  const interactionId = inboundInteractionId(gmailMessageId);
  const queued = await queueValidatedCaseReply({ validationId: proposed.validationId, policy, note: { interactionId, text: "Synthetic interaction note.", at: "2026-10-30T10:00:00.000Z" }, deps });
  if (!queued.ok) throw Error(`QUEUE:${queued.code}`);
  const [row] = await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, proposed.validationId));
  return { caseId: opened.caseId, ticketId, validationId: proposed.validationId, executionId: queued.executionId, replyKey: row!.replyKey,
    noteKey: caseNoteKey(opened.caseId, interactionId), associateKey: caseNoteAssociationKey(opened.caseId, interactionId) };
}
/** C9's own fixture shape: a ledger row under the parent, with marker when engaged. */
const putEffect = (executionId: string, kind: "reply_send" | "note_create" | "note_associate", key: string, effectState: string, attempts = 0) => f.client.query(
  `INSERT INTO sav.intake_effects (business_key, execution_id, kind, permission, state, intent_hash, intent_ciphertext, reconcile_attempts, dispatched_at)
   VALUES ($1, $2, $3, $4, $5, 'x', 'x', $6, ${effectState === "planned" ? "NULL" : "now()"})`, [key, executionId, kind, kind === "reply_send" ? "send_case_reply" : "append_case_note", effectState, attempts]);
const render = async (ticketId: string, reply?: string) => renderToStaticMarkup(await CasePage({ params: Promise.resolve({ ticketId }), searchParams: Promise.resolve(reply ? { reply } : {}) }));
const snapshotAll = async () => {
  const tables = (await f.client.query<{ name: string }>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'sav' AND table_type = 'BASE TABLE' ORDER BY 1")).rows;
  const out: Record<string, string> = {};
  for (const { name } of tables) out[name] = JSON.stringify((await f.client.query(`SELECT * FROM sav."${name}" ORDER BY 1`)).rows);
  return out;
};
async function readOnly(ticketId: string, reply?: string) {
  const before = await snapshotAll(), html = await render(ticketId, reply);
  expect(await snapshotAll()).toEqual(before);
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  expect(html).not.toMatch(/<form|<button|type="submit"|SAV_CASE_EFFECT_/);
  return html;
}
const block = (html: string) => { const at = html.indexOf('id="v2-operational"'); return at < 0 ? "" : html.slice(at, html.indexOf("</div>", at)); };

beforeAll(async () => {
  f = await createSavTestDb(); state.db = f.db;
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-execution-encryption-key-32-characters");
  mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0]!.id;
  const executionPolicy: ExecutionPolicy = { revision: "sav-intake-execution-2026-10-21.v1", mailboxId, codeRevision: "a".repeat(40), enginePolicyHash: "b".repeat(64), resourcesHash: "c".repeat(64),
    createdAfter: new Date(Date.now() - 10_000).toISOString(), receivedAfter: new Date(Date.now() - 3_600_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    maxDossiers: 10, mutations: ["send_case_reply", "append_case_note"], admission: { kind: "automatic" } };
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-admin", email: "contact@limova.ai", name: "Synthetic Admin", role: "admin", active: true }).returning();
  state.fixtureAdmin = admin as unknown as Record<string, unknown>;
  const grant = await approveIntakeExecutionPolicy(executionPolicy).finally(() => { state.fixtureAdmin = null; });
  policy = { id: grant.id, hash: grant.policyHash };
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-execution-encryption-key-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on"); vi.stubEnv("SAV_CASE_EFFECTS", "supervised");
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
  state.staff.mockReset(); state.staff.mockResolvedValue({ id: STAFF, email: "operateur@example.test", role: "member", active: true });
  state.calls = []; state.redirect = null; state.breakDb = false;
});

describe("C9 operational state on the V2 case page (real writers and reader → mapper → page)", () => {
  it("a refused staff check reads nothing: 0 database access, 0 decryption, no C9 call", async () => {
    const s = await queuedReply();
    state.dbReads = 0; state.decrypted = [];
    state.staff.mockRejectedValueOnce(Error("SAV_INTAKE_CONSOLE_UNAUTHORIZED"));
    await expect(render(s.ticketId, s.validationId)).rejects.toThrow("SAV_INTAKE_CONSOLE_UNAUTHORIZED");
    expect(state.dbReads).toBe(0); expect(state.decrypted).toEqual([]); expect(state.calls).toEqual([]);
  });

  it("reply uncertain at C's limit, note created + association uncertain: the person sentence and the note sentence; access from the staff result; 0 write", async () => {
    const s = await queuedReply();
    await putEffect(s.executionId, "reply_send", s.replyKey, "uncertain", 5);
    await putEffect(s.executionId, "note_create", s.noteKey, "confirmed");
    await putEffect(s.executionId, "note_associate", s.associateKey, "uncertain");
    const o = block(await readOnly(s.ticketId, s.validationId));
    expect(state.calls).toEqual([[{ caseId: s.caseId, validationId: s.validationId }, true]]);
    expect(o).toContain(PERSON);
    expect(o).toContain("Envoi incertain : vérification seule, aucun renvoi.");
    expect(o).toContain("Note interne créée, rattachement au ticket à vérifier.");
    expect(o).toContain("D’après le registre des effets seulement : ni la demande d’une note, ni son absence dans HubSpot ne sont prouvées.");
    expect(o).not.toMatch(/prochaine vérification|\b5 vérifications\b/);
  });

  it("queued without any effect: no recorded step (not 'no note in HubSpot'); below the limit no person is asked", async () => {
    const s = await queuedReply();
    const o = block(await readOnly(s.ticketId, s.validationId));
    expect(o).toContain("Envoi : aucune étape enregistrée.");
    expect(o).toContain("Note interne : aucune étape de note enregistrée.");
    expect(o).not.toContain("une personne doit regarder");
  });

  it("forged ids: another case's reply in the URL never reaches C9; C9 asked about another case's validation answers not_found, shown as such", async () => {
    const a = await queuedReply(), b = await queuedReply();
    await readOnly(a.ticketId, b.validationId);
    expect(state.calls).toEqual([]); // the page's own reply read refused it first, for this case
    state.redirect = { caseId: a.caseId, validationId: b.validationId };
    expect(block(await readOnly(a.ticketId, a.validationId))).toContain("Aucun suivi d’effets pour cette réponse dans ce dossier.");
  });

  it("a failing database under C9's real reader reads 'indisponible', never an empty list nor 'en ordre'", async () => {
    const s = await queuedReply();
    state.breakDb = true;
    const o = block(await readOnly(s.ticketId, s.validationId));
    expect(o).toContain("Suivi des effets indisponible : la lecture a échoué. Ce n’est pas une liste vide.");
  });

  it("no reply chosen in the link: C9 is called once, only for the latest reply the page itself read for this case", async () => {
    const s = await queuedReply();
    await readOnly(s.ticketId);
    expect(state.calls).toHaveLength(1);
  });
});
