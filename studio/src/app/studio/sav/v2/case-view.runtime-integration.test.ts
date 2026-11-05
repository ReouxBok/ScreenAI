import { randomUUID } from "node:crypto";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../../test/sav-db";
const state = vi.hoisted(() => ({ db: null as unknown, dbReads: 0, decrypted: [] as string[], staff: vi.fn() }));
vi.mock("@/db", () => ({ requireDb: () => { state.dbReads += 1; if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("@/lib/sav/crypto", async importOriginal => {
  const real = await importOriginal<typeof import("@/lib/sav/crypto")>();
  return { ...real, decryptSavPayload: (ciphertext: string) => { state.decrypted.push(ciphertext); return real.decryptSavPayload(ciphertext); } };
});
vi.mock("@/lib/sav/intake/console-auth", () => ({ requireIntakeConsoleStaff: state.staff }));
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => createElement("a", props) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw Error("NOT_FOUND"); }, usePathname: () => "/studio/sav/v2/1", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ back: vi.fn(), refresh: vi.fn() }) }));
import { savMailboxes, savMessages, savThreads } from "@/db/schema";
import { encryptSavPayload } from "@/lib/sav/crypto";
import { caseReplyPayloadHash, type CaseReplyProposal } from "@/lib/sav/cases/case-effects";
import { finalizeCaseReplyProposal } from "@/lib/sav/cases/case-reply-outbound";
import { submitCaseReplyProposal } from "@/lib/sav/cases/case-reply-store";
import { claimCaseForDecision, listCaseEvents, openCaseEvent, readCase, recordCaseObservation, transitionCaseOwner } from "@/lib/sav/cases/case-store";
import { caseDedupeKey, SAV_CASE_AWAITING_V2_ATTRIBUTION } from "@/lib/sav/cases/case-types";
import { caseInvestigationStorePorts } from "@/lib/sav/cases/investigation-store-ports";
import { latestInvestigationInput } from "@/lib/sav/cases/investigation-runner";
import CasePage from "./[ticketId]/page";

// UX lot 4 (I1) on the PRIVATE composition 67fc219 (A 7e03a3b + B a0e2773 + C 2160ea3 + UX c7d6e7d), PGlite with the real migrations. Pole B's progress is
// written by B's REAL store ports (claim -> progress.save -> release, i.e. caseInvestigationObservationRecord + pole A's recordCaseObservation) and read back
// by the page through B's REAL readCaseInvestigationProgress; nothing in that path is replaced. Only the staff check, the db handle (counted) and the
// decryption (spied) are doubles. Synthetic data only; fetch throws; no SDK, provider or model; C's send path and driver are not run.
type Db = Awaited<ReturnType<typeof createSavTestDb>>;
const STAFF = "20000000-0000-4000-8000-000000000003", AT = "2026-10-27T09:00:00.000Z", SINCE = "2026-10-31T09:30:00.000Z";
const ADMITTED = {
  policy: { revision: "policy-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT },
  qualification: { requests: [{ requestId: "r1", family: "access" as const, provenance: { kind: "human" as const, staffUserId: STAFF, at: AT } }],
    identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-1" } }, crmContext: "complete" as const, teamSignals: [] },
};
// Pole C 5820159: proposing a reply reads the ticket's current CRM owner through a required port (a double here, as in ROOT's composition fixture).
const replyDeps = { env: () => ({ SAV_CASE_EFFECTS: "supervised" }), readTicketOwner: async () => "v2" as const, currentPolicyRevision: async () => "policy-r1" };
// The claim's quiet period runs from the inbound's recording: B's injected clock is set after it (no domain change).
const later = () => new Date(Date.now() + 24 * 3600_000);
let ticket = 9_900_000;

async function seed(f: Db) {
  const mailboxId = (await f.db.insert(savMailboxes).values({ email: `support-${randomUUID()}@example.invalid` }).returning())[0]!.id;
  const gmailMessageId = `gm-${randomUUID()}`, ticketId = String(ticket++);
  const thread = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: `t-${randomUUID()}`, customerEmail: "customer@example.invalid" }).returning())[0]!;
  const message = (await f.db.insert(savMessages).values({ threadId: thread.id, mailboxId, direction: "inbound", gmailMessageId, fromEmail: "customer@example.invalid", toEmails: ["support@example.invalid"],
    subject: "Synthetic", bodyCiphertext: encryptSavPayload({ text: "Synthetic.", headers: { "message-id": "<in@example.invalid>" }, attachments: [] }), receivedAt: new Date("2026-10-28T07:00:00.000Z") }).returning())[0]!;
  const { case: opened } = await openCaseEvent({ ticketId, threadId: thread.id, admission: ADMITTED, kind: "inbound_confirmed",
    dedupeKey: caseDedupeKey.inbound(gmailMessageId), sourceRef: { type: "email", id: gmailMessageId }, occurredAt: "2026-10-28T07:00:00.000Z" });
  return { caseId: opened.caseId, ticketId, gmailMessageId, messageId: message.id };
}
const unused = () => { throw Error("NOT_USED_IN_THIS_TEST"); };
/** B's real store ports, used exactly as B's runner does at the end of a claim. Ports this path never calls throw. */
const portsOf = () => caseInvestigationStorePorts({ holder: "ux-i1-fixture", admissionPolicyRevision: async () => "policy-r1", qualify: async () => null, now: later,
  scope: unused as never, pauseState: unused as never, knowledge: unused as never, customerTexts: unused as never, revisions: unused as never, callModel: unused as never });
async function persistWithB(caseId: string, modelCalls: number, waiting: Record<string, unknown>) {
  const ports = portsOf(), version = (await readCase(caseId))!.version, inputKey = latestInvestigationInput(await listCaseEvents(caseId))!;
  await ports.admissionPolicyRevision();
  const claim = await ports.claim(caseId, version);
  if (!("token" in claim)) throw Error(`CLAIM_REFUSED:${claim.refused}`);
  await ports.progress.save(caseId, inputKey, { modelCalls, attempts: [], waiting: waiting as never, proposal: null, last: null, closure: null, recordedOn: null });
  await ports.release(caseId, claim.token);
  return inputKey;
}
/** A record B's writer refuses (legacy cadc971 detail, unknown problem) written as an older writer could have: through pole A's store only. */
async function persistRaw(caseId: string, record: Record<string, unknown>) {
  const claim = await claimCaseForDecision({ caseId, expectedVersion: (await readCase(caseId))!.version, holder: "ux-i1-legacy", currentPolicyRevision: "policy-r1", ttlSeconds: 300, now: later() });
  if (!claim.claimed) throw Error(`CLAIM_REFUSED:${claim.reason}`);
  await recordCaseObservation({ caseId, claimToken: claim.claim.token, currentPolicyRevision: "policy-r1", observation: { record } });
}
const render = async (ticketId: string, search: Record<string, string> = {}) => renderToStaticMarkup(await CasePage({ params: Promise.resolve({ ticketId }), searchParams: Promise.resolve(search) }));
/** Every row of every sav table, as text: equal before and after a render means the page wrote nothing (not a row count). */
const snapshotAll = async (f: Db) => {
  const tables = (await f.client.query<{ name: string }>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'sav' AND table_type = 'BASE TABLE' ORDER BY 1")).rows;
  const out: Record<string, string> = {};
  for (const { name } of tables) out[name] = JSON.stringify((await f.client.query(`SELECT * FROM sav."${name}" ORDER BY 1`)).rows);
  return out;
};
const readOnlyRender = async (f: Db, ticketId: string, search: Record<string, string> = {}) => {
  const before = await snapshotAll(f), html = await render(ticketId, search);
  expect(await snapshotAll(f)).toEqual(before);
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  expect(html).not.toMatch(/<form|<button|type="submit"/);
  return html;
};

beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-execution-encryption-key-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on"); vi.stubEnv("SAV_CASE_EFFECTS", "supervised");
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
  state.staff.mockReset(); state.staff.mockResolvedValue({ id: STAFF, email: "operateur@example.test", role: "member" });
});

describe("I1: the investigation wait written by pole B's real store and read back by its real reader", () => {
  let f: Db;
  beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
  afterAll(async () => { state.db = null; await f.client.close(); });

  it("context_invalid, problem event_duplicate, 2 embeddings, 0 generation call: persisted in B's format, read back, safe sentence and true counts", async () => {
    const s = await seed(f);
    const inputKey = await persistWithB(s.caseId, 0, { reason: "context_invalid", since: SINCE, caseVersion: 1, problem: "event_duplicate", embeddingCalls: 2 });
    const stored = (await listCaseEvents(s.caseId)).filter(e => e.kind === "observation_recorded").at(-1)!.detail as { record: { inputKey: string; progress: { waiting: Record<string, unknown> } } };
    expect(stored.record.inputKey).toBe(inputKey);
    expect(stored.record.progress.waiting).toEqual({ reason: "context_invalid", since: SINCE, caseVersion: 1, problem: "event_duplicate", embeddingCalls: 2 });
    const html = await readOnlyRender(f, s.ticketId);
    expect(html).toContain("Contexte de décision impossible à construire depuis le dossier : aucun appel de génération (modèle) de décision.");
    expect(html).toContain("Motif : le journal contient deux fois le même événement.");
    expect(html).toContain("Appels de génération (modèle) enregistrés : 0. Embeddings envoyés pendant ce passage : 2.");
    expect(html).not.toMatch(/event_duplicate|aucun appel fait|aucun embedding/);
  });

  it("B5 knowledge_changed (problem revision_moved, 1 embedding) through B's real writer and reader: operator sentence, closed motive, true counts, no revision id", async () => {
    const s = await seed(f);
    await persistWithB(s.caseId, 0, { reason: "knowledge_changed", since: SINCE, caseVersion: 1, problem: "revision_moved", embeddingCalls: 1 });
    const html = await readOnlyRender(f, s.ticketId);
    expect(html).toContain("Les connaissances ont changé, une nouvelle vérification est nécessaire.");
    expect(html).toContain("Motif : une fiche a été publiée, archivée ou désactivée pendant l’investigation.");
    expect(html).toContain("Appels de génération (modèle) enregistrés : 0. Embeddings envoyés pendant ce passage : 1.");
    expect(html).not.toMatch(/revision_moved|kb-rev/);
  });

  it("embeddings 0 is shown as 0; an absent count is 'non enregistré', never 0", async () => {
    const zero = await seed(f);
    await persistWithB(zero.caseId, 0, { reason: "context_invalid", since: SINCE, caseVersion: 1, problem: "body_invalid", embeddingCalls: 0 });
    expect(await readOnlyRender(f, zero.ticketId)).toContain("Appels de génération (modèle) enregistrés : 0. Embeddings envoyés pendant ce passage : 0.");
    const absent = await seed(f);
    await persistWithB(absent.caseId, 0, { reason: "context_invalid", since: SINCE, caseVersion: 1, problem: "body_invalid" });
    const html = await readOnlyRender(f, absent.ticketId);
    expect(html).toContain("Embeddings envoyés pendant ce passage : non enregistré.");
    expect(html).toContain("Motif : le contenu enregistré du dossier ne respecte pas son format.");
  });

  it("B's writer refuses a legacy detail or an unknown problem; such a record written by an older writer is read 'unreadable' by B's reader, nothing raw shown", async () => {
    const legacy = await seed(f);
    await expect(persistWithB(legacy.caseId, 0, { reason: "context_invalid", since: SINCE, caseVersion: 1, detail: "body_invalid: Expected string, received number at body.facts.0.id e-7f3a" }))
      .rejects.toThrow("SAV_CASE_INVESTIGATION_RECORD_INVALID");
    // That refused release leaves B's claim held on this case (B's behaviour, not changed here): the older-writer record goes on a fresh case.
    const older = await seed(f);
    const inputKey = latestInvestigationInput(await listCaseEvents(older.caseId))!;
    await persistRaw(older.caseId, { kind: "sav-case-investigation.v1", inputKey, decision: null, progress: { modelCalls: 0, attempts: [], proposal: null, last: null, closure: null, recordedOn: null,
      waiting: { reason: "context_invalid", since: SINCE, caseVersion: 1, detail: "body_invalid: Expected string, received number at body.facts.0.id e-7f3a" } } });
    const legacyHtml = await readOnlyRender(f, older.ticketId);
    expect(legacyHtml).toContain("Dernier enregistrement d’investigation illisible : problème technique, pas un nouveau départ.");
    expect(legacyHtml).not.toMatch(/Expected string|received number|body\.facts|e-7f3a/);
    const unknown = await seed(f);
    await persistRaw(unknown.caseId, { kind: "sav-case-investigation.v1", inputKey: latestInvestigationInput(await listCaseEvents(unknown.caseId))!, decision: null,
      progress: { modelCalls: 0, attempts: [], proposal: null, last: null, closure: null, recordedOn: null, waiting: { reason: "context_invalid", since: SINCE, caseVersion: 1, problem: "zz_private_code" } } });
    const unknownHtml = await readOnlyRender(f, unknown.ticketId);
    expect(unknownHtml).toContain("Dernier enregistrement d’investigation illisible");
    expect(unknownHtml).not.toContain("zz_private_code");
  });
});

describe("page guards on the composition: access, SQL case binding, team custody, language provenance", () => {
  let f: Db;
  beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
  afterAll(async () => { state.db = null; await f.client.close(); });

  it("a refused access reads nothing: no database access, no decryption", async () => {
    const s = await seed(f);
    state.dbReads = 0; state.decrypted = [];
    state.staff.mockRejectedValueOnce(Error("FORBIDDEN"));
    await expect(render(s.ticketId)).rejects.toThrow("FORBIDDEN");
    expect(state.dbReads).toBe(0); expect(state.decrypted).toEqual([]);
  });

  it("another case's reply id is neither read nor decrypted; the selected reply shows its language provenance as not recorded", async () => {
    const proposal = (s: Awaited<ReturnType<typeof seed>>, text: string): CaseReplyProposal => finalizeCaseReplyProposal({ caseId: s.caseId, caseVersion: 1, triggerEventId: `inbound:${s.gmailMessageId}`,
      inboundMessageId: s.messageId, purpose: "answer", recipient: "customer@example.invalid", subject: "Synthetic", text }, { language: "fr", validation: "human" });
    const a = await seed(f), b = await seed(f);
    const pa = { ...proposal(a, "Bonjour,\n\nTexte A."), caseVersion: (await readCase(a.caseId))!.version }, pb = { ...proposal(b, "Bonjour,\n\nTexte B."), caseVersion: (await readCase(b.caseId))!.version };
    const mine = await submitCaseReplyProposal(pa, replyDeps), theirs = await submitCaseReplyProposal(pb, replyDeps);
    if (!mine.ok || !theirs.ok) throw Error(`SUBMIT:${!mine.ok ? mine.code : ""}:${!theirs.ok ? theirs.code : ""}`);
    const own = await readOnlyRender(f, a.ticketId, { reply: mine.id });
    expect(own).toContain(`Empreinte enregistrée du texte et de son destinataire : ${caseReplyPayloadHash(pa).slice(0, 12)}…`);
    expect(own).toContain("Provenance de la langue : non enregistrée par cette version");
    const [cipher] = (await f.client.query<{ c: string }>("SELECT proposal_ciphertext AS c FROM sav.case_reply_validations WHERE id = $1", [theirs.id])).rows;
    state.decrypted = [];
    const cross = await readOnlyRender(f, a.ticketId, { reply: theirs.id });
    expect(cross).toContain("Aucune réponse avec cet identifiant pour ce dossier.");
    expect(cross).not.toContain("Texte B.");
    expect(state.decrypted).not.toContain(cipher!.c);
  });

  it("UX1 on the real store: a handoff nobody took and a case awaiting its V2 attribution never read 'taken by a person'; a recorded takeover does", async () => {
    const team = await seed(f);
    await transitionCaseOwner({ caseId: team.caseId, expectedVersion: (await readCase(team.caseId))!.version, transition: "handoff", actor: { type: "agent" }, commandKey: `ux4-handoff-${team.caseId}`, reason: "out_of_scope" });
    const teamHtml = await readOnlyRender(f, team.ticketId);
    expect(teamHtml).toContain("Dossier confié à l’équipe, pas encore pris par une personne");
    expect(teamHtml).not.toContain("pris par une personne de l’équipe le");
    const waiting = await seed(f);
    await transitionCaseOwner({ caseId: waiting.caseId, expectedVersion: (await readCase(waiting.caseId))!.version, transition: "handoff", actor: { type: "agent" }, commandKey: `ux4-attr-${waiting.caseId}`, reason: SAV_CASE_AWAITING_V2_ATTRIBUTION });
    const waitingHtml = await readOnlyRender(f, waiting.ticketId);
    expect(waitingHtml).toContain("En attente du propriétaire V2");
    expect(waitingHtml).not.toMatch(/pris par une personne de l’équipe le|Dossier confié à l’équipe/);
    await transitionCaseOwner({ caseId: team.caseId, expectedVersion: (await readCase(team.caseId))!.version, transition: "human_takeover", actor: { type: "human", staffUserId: STAFF }, commandKey: `ux4-take-${team.caseId}`, reason: "fixture" });
    expect(await readOnlyRender(f, team.ticketId)).toContain("Ticket pris par une personne de l’équipe le");
  });
});
