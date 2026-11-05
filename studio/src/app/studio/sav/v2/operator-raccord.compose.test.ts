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
import { decideCaseReply, submitCaseReplyProposal } from "@/lib/sav/cases/case-reply-store";
import { openCaseEvent, readCase, transitionCaseOwner } from "@/lib/sav/cases/case-store";
import { caseDedupeKey } from "@/lib/sav/cases/case-types";
import CasePage from "./[ticketId]/page";

// UX night: the operator's V2 case page on the REAL readers (poles A/B/C) and A's migrations through 0051 (PGlite). Synthetic data only; the test
// itself seeds through the real store (as a producer would), the PAGE only reads. No network, no provider, no model: fetch throws.
type Db = Awaited<ReturnType<typeof createSavTestDb>>;
const STAFF = "20000000-0000-4000-8000-000000000003", AT = "2026-10-27T09:00:00.000Z";
const ADMITTED = {
  policy: { revision: "policy-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT },
  qualification: { requests: [{ requestId: "r1", family: "access" as const, provenance: { kind: "human" as const, staffUserId: STAFF, at: AT } }],
    identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-1" } }, crmContext: "complete" as const, teamSignals: [] },
};
// Pole C 5820159: proposing a reply reads the ticket's current CRM owner through a required port (a double here, as in ROOT's composition fixture).
const deps = { env: () => ({ SAV_CASE_EFFECTS: "supervised" }), readTicketOwner: async () => "v2" as const, currentPolicyRevision: async () => "policy-r1" };
let ticket = 9_800_000;

async function seed(f: Db) {
  const mailboxId = (await f.db.insert(savMailboxes).values({ email: `support-${randomUUID()}@example.invalid` }).returning())[0]!.id;
  const gmailMessageId = `gm-${randomUUID()}`, ticketId = String(ticket++);
  const thread = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: `t-${randomUUID()}`, customerEmail: "customer@example.invalid" }).returning())[0]!;
  const message = (await f.db.insert(savMessages).values({ threadId: thread.id, mailboxId, direction: "inbound", gmailMessageId, fromEmail: "customer@example.invalid", toEmails: ["support@example.invalid"],
    subject: "Synthetic", bodyCiphertext: encryptSavPayload({ text: "Synthetic.", headers: { "message-id": "<in@example.invalid>" }, attachments: [] }), receivedAt: new Date("2026-10-28T07:00:00.000Z") }).returning())[0]!;
  const { case: opened } = await openCaseEvent({ ticketId, threadId: thread.id, admission: ADMITTED, kind: "inbound_confirmed",
    dedupeKey: caseDedupeKey.inbound(gmailMessageId), sourceRef: { type: "email", id: gmailMessageId }, occurredAt: "2026-10-28T07:00:00.000Z" });
  const version = (await readCase(opened.caseId))!.version;
  const proposal = (text: string): CaseReplyProposal => finalizeCaseReplyProposal({ caseId: opened.caseId, caseVersion: version, triggerEventId: `inbound:${gmailMessageId}`, inboundMessageId: message.id,
    purpose: "answer", recipient: "customer@example.invalid", subject: "Synthetic", text }, { language: "fr", validation: "human" });
  return { caseId: opened.caseId, ticketId, proposal };
}
const render = async (ticketId: string, search: Record<string, string> = {}) => renderToStaticMarkup(await CasePage({ params: Promise.resolve({ ticketId }), searchParams: Promise.resolve(search) }));
/** Every row of every sav table, as text: equal before and after a render means the page wrote nothing. */
const fingerprint = async (f: Db) => {
  const tables = (await f.client.query<{ name: string }>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'sav' AND table_type = 'BASE TABLE' ORDER BY 1")).rows;
  const out: Record<string, string> = {};
  for (const { name } of tables) out[name] = JSON.stringify((await f.client.query(`SELECT * FROM sav."${name}" ORDER BY 1`)).rows);
  return out;
};

beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-execution-encryption-key-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on"); vi.stubEnv("SAV_CASE_EFFECTS", "supervised");
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
  state.staff.mockReset(); state.staff.mockResolvedValue({ email: "operateur@example.test", role: "member" });
});

describe("operator page on the real readers (A's migrations through 0051)", () => {
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

  it("the stored final text: mention read (not added), stored fingerprint, validation only when recorded; another case's reply is neither read nor decrypted", async () => {
    const a = await seed(f), b = await seed(f);
    const final = a.proposal("Bonjour,\n\nVoici la marche synthétique."), other = b.proposal("Bonjour,\n\nAutre dossier.");
    const mine = await submitCaseReplyProposal(final, deps), theirs = await submitCaseReplyProposal(other, deps);
    if (!mine.ok || !theirs.ok) throw Error("SUBMIT");
    const proposed = await render(a.ticketId, { reply: mine.id });
    expect(proposed).toContain("Mention IA présente (français)");
    expect(proposed).toContain(`Empreinte enregistrée du texte et de son destinataire : ${caseReplyPayloadHash(final).slice(0, 12)}…`);
    expect(proposed).toContain("Aucune validation enregistrée : proposition en attente.");
    expect(proposed).toContain("Pas en file d’envoi : aucune exécution enregistrée.");
    expect(proposed).toContain("Voici la marche synthétique.");
    const [theirCipher] = (await f.client.query<{ c: string }>("SELECT proposal_ciphertext AS c FROM sav.case_reply_validations WHERE id = $1", [theirs.id])).rows;
    state.decrypted = [];
    const cross = await render(a.ticketId, { reply: theirs.id });
    expect(cross).toContain("Aucune réponse avec cet identifiant pour ce dossier.");
    expect(cross).not.toContain("Autre dossier.");
    expect(state.decrypted).not.toContain(theirCipher!.c);
    expect(await decideCaseReply({ action: "approve", validationId: mine.id, approverId: STAFF, authorizer: () => ({ allowed: true, basis: "fixture.allow" }), deps,
      seen: { payloadHash: caseReplyPayloadHash(final), caseVersion: final.caseVersion, recipient: final.recipient } })).toMatchObject({ ok: true });
    const approved = await render(a.ticketId, { reply: mine.id });
    expect(approved).toContain("Validation enregistrée le");
    expect(approved).toContain("Validée, pas encore en file");
    expect(approved).toContain("Rien n’est parti vers le client.");
    expect(approved).not.toMatch(/Reçu Gmail confirmé|<form|<button|type="submit"/);
  });

  it("a ticket a person took: informative notice; the render writes nothing in any sav table and calls no provider", async () => {
    const s = await seed(f);
    await transitionCaseOwner({ caseId: s.caseId, expectedVersion: (await readCase(s.caseId))!.version, transition: "human_takeover", actor: { type: "human", staffUserId: STAFF }, commandKey: `night-take-${s.caseId}`, reason: "fixture" });
    const before = await fingerprint(f);
    const html = await render(s.ticketId);
    expect(html).toContain("Ticket pris par une personne de l’équipe le");
    expect(html).toContain("Une personne de l’équipe");
    expect(await fingerprint(f)).toEqual(before);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(html).not.toMatch(/<form|<button|type="submit"/);
  });
});

describe("without the 0051 table: the registry is unavailable, never an empty list", () => {
  let f: Db;
  beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
  afterAll(async () => { state.db = null; await f.client.close(); });
  it("the case page reads 'unavailable' for the list and the selected reply", async () => {
    const s = await seed(f);
    await f.client.exec("DROP TABLE sav.case_reply_validations CASCADE");
    const html = await render(s.ticketId, { reply: randomUUID() });
    expect(html).toContain("Registre des réponses indisponible : la lecture a échoué, ce n’est pas une liste vide.");
    expect(html).toContain("Lecture de la réponse impossible : problème technique, rien n’est présenté comme envoyé.");
    expect(html).not.toContain("Aucune réponse préparée enregistrée");
  });
});
