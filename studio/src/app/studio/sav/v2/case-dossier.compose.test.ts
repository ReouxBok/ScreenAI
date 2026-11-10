import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
vi.mock("next/navigation", () => ({ notFound: () => { throw Error("NOT_FOUND"); }, usePathname: () => "/studio/sav/v2/1", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ back: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));
import { savCaseEffectExecutions, savIntakeEffects, savIntakeExecutionPolicies, savMailboxes, savMessages, savThreads, staffUsers } from "@/db/schema";
import { handoffNoticeKey } from "@/lib/sav/cases/case-handoff-notice";
import { encryptSavPayload } from "@/lib/sav/crypto";
import { caseReplyHelpLine, finalizeCaseReplyProposal } from "@/lib/sav/cases/case-reply-outbound";
import { submitCaseReplyProposal } from "@/lib/sav/cases/case-reply-store";
import { openCaseEvent, readCase, transitionCaseOwner } from "@/lib/sav/cases/case-store";
import { caseDedupeKey } from "@/lib/sav/cases/case-types";
import CasePage from "./[ticketId]/page";

// The V2 case page on the REAL readers (PGlite with the real migrations): stored mail, reply registry, case store. Only the staff check is a double. Synthetic data; fetch throws.
type Db = Awaited<ReturnType<typeof createSavTestDb>>;
const STAFF = "20000000-0000-4000-8000-000000000003", AT = "2026-10-27T09:00:00.000Z";
const ADMITTED = {
  policy: { revision: "policy-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT },
  qualification: { requests: [{ requestId: "r1", family: "access" as const, provenance: { kind: "human" as const, staffUserId: STAFF, at: AT } }],
    identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-1" } }, crmContext: "complete" as const, teamSignals: [] },
};
const replyDeps = { env: () => ({ SAV_CASE_EFFECTS: "supervised" }), readTicketOwner: async () => "v2" as const, currentPolicyRevision: async () => "policy-r1" };
let ticket = 9_800_000;
async function seed(f: Db, body: string | Record<string, unknown> = "Bonjour, je ne reçois pas le code SYN.") {
  const mailboxId = (await f.db.insert(savMailboxes).values({ email: `support-${randomUUID()}@example.invalid` }).returning())[0]!.id;
  const gmailMessageId = `gm-${randomUUID()}`, ticketId = String(ticket++);
  const thread = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: `t-${randomUUID()}`, customerEmail: "customer@example.invalid" }).returning())[0]!;
  const message = (await f.db.insert(savMessages).values({ threadId: thread.id, mailboxId, direction: "inbound", gmailMessageId, fromEmail: "customer@example.invalid", toEmails: ["support@example.invalid"],
    subject: "Accès SYN", bodyCiphertext: typeof body === "string" ? encryptSavPayload({ text: body, headers: {}, attachments: [] }) : encryptSavPayload(body), receivedAt: new Date("2026-10-28T07:00:00.000Z") }).returning())[0]!;
  const { case: opened } = await openCaseEvent({ ticketId, threadId: thread.id, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmailMessageId), sourceRef: { type: "email", id: gmailMessageId }, occurredAt: "2026-10-28T07:00:00.000Z" });
  return { caseId: opened.caseId, ticketId, gmailMessageId, messageId: message.id, threadId: thread.id };
}
const render = async (ticketId: string, search: Record<string, string> = {}) => renderToStaticMarkup(await CasePage({ params: Promise.resolve({ ticketId }), searchParams: Promise.resolve(search) }));
const snapshotAll = async (f: Db) => {
  const tables = (await f.client.query<{ name: string }>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'sav' AND table_type = 'BASE TABLE' ORDER BY 1")).rows;
  const out: Record<string, string> = {};
  for (const { name } of tables) out[name] = JSON.stringify((await f.client.query(`SELECT * FROM sav."${name}" ORDER BY 1`)).rows);
  return out;
};
const readOnly = async (f: Db, ticketId: string) => {
  const before = await snapshotAll(f), html = await render(ticketId);
  expect(await snapshotAll(f)).toEqual(before);
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  expect(html).not.toMatch(/<form|<button|type="submit"/);
  return html;
};

describe("V2 case page on the real readers", () => {
  let f: Db;
  beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
  afterAll(async () => { state.db = null; await f.client.close(); });
  beforeEach(() => {
    vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-execution-encryption-key-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on"); vi.stubEnv("SAV_CASE_EFFECTS", "supervised");
    vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
    state.staff.mockReset(); state.staff.mockResolvedValue({ id: STAFF, email: "operateur@example.test", role: "member" });
  });

  it("scenario: prepared reply on an open case: the stored mail, the exact final text with help line and AI mention, nothing shown as sent, nothing written", async () => {
    const s = await seed(f);
    const proposal = finalizeCaseReplyProposal({ caseId: s.caseId, caseVersion: (await readCase(s.caseId))!.version, triggerEventId: `inbound:${s.gmailMessageId}`, inboundMessageId: s.messageId, purpose: "answer",
      recipient: "customer@example.invalid", subject: "Accès SYN", text: "Bonjour,\n\nVoici la marche à suivre SYN." }, { language: "fr", validation: "human" });
    const submitted = await submitCaseReplyProposal(proposal, replyDeps);
    if (!submitted.ok) throw Error(`SUBMIT:${submitted.code}`);
    const html = await readOnly(f, s.ticketId);
    expect(html).toContain("Bonjour, je ne reçois pas le code SYN."); expect(html).toContain("customer@example.invalid");
    expect(html).toContain("Dernière réponse : En attente de validation humaine."); expect(html).toContain("Rien n’est parti vers le client.");
    expect(html).toContain(caseReplyHelpLine("fr")); expect(html).toContain("Mention IA présente (français)"); expect(html).toContain("L’équipe Limova");
    expect(html).not.toContain("Partie chez le client");
    expect(html).toContain("Aucune preuve de relais V1 enregistrée pour ce mail.");
  });

  it("scenario: transmitted to the team, then taken by a person, on the real store; the mail stays readable", async () => {
    const s = await seed(f);
    await transitionCaseOwner({ caseId: s.caseId, expectedVersion: (await readCase(s.caseId))!.version, transition: "handoff", actor: { type: "agent" }, commandKey: `ux-handoff-${s.caseId}`, reason: "out_of_scope" });
    const sent = await readOnly(f, s.ticketId);
    expect(sent).toContain("Équipe requise"); expect(sent).toContain("Aucune notification préparée"); expect(sent).not.toContain("Transmis à Ugo"); expect(sent).toContain("Bonjour, je ne reçois pas le code SYN.");
    expect(sent).toContain("L’agent V2 n’est pas responsable de ce dossier");
    // The notice on the real ledger tables: engaged is uncertain, and only the confirmed effect with Slack's answer gives the link. Read-only (readOnly compares every table).
    const administrator = (await f.db.insert(staffUsers).values({ clerkId: `syn-${randomUUID()}`, email: `syn-${randomUUID()}@example.invalid`, name: "Synthetic", role: "admin", active: true }).returning())[0]!;
    const grant = (await f.db.insert(savIntakeExecutionPolicies).values({ revision: "syn", state: "approved", administratorId: administrator.id, policyHash: "e".repeat(64), payloadCiphertext: encryptSavPayload({}) }).returning())[0]!;
    const key = handoffNoticeKey(s.caseId, `in:${s.gmailMessageId}`);
    const execution = (await f.db.insert(savCaseEffectExecutions).values({ caseId: s.caseId, replyKey: key, threadId: s.threadId, policyId: grant.id, policyHash: grant.policyHash, state: "uncertain", payloadCiphertext: encryptSavPayload({}) }).returning())[0]!;
    const effect = (await f.db.insert(savIntakeEffects).values({ businessKey: key, executionId: execution.id, kind: "handoff_notify", permission: "notify_case_handoff", state: "uncertain", intentHash: "d".repeat(64), intentCiphertext: encryptSavPayload({}) }).returning())[0]!;
    const unclear = await readOnly(f, s.ticketId);
    expect(unclear).toContain("Notification incertaine"); expect(unclear).not.toContain("slack.com/archives");
    await f.db.update(savIntakeEffects).set({ state: "confirmed", ackCiphertext: encryptSavPayload({ id: "1730000000.000100", ts: "1730000000.000100", channel: "CSYNTHETIC1" }), verificationCiphertext: encryptSavPayload({ confirmed: true }), confirmedAt: new Date() }).where(eq(savIntakeEffects.id, effect.id));
    const receipt = await readOnly(f, s.ticketId);
    expect(receipt).toContain("Notification confirmée"); expect(receipt).toContain('href="https://slack.com/archives/CSYNTHETIC1/p1730000000000100"'); expect(receipt).toContain("Cela ne prouve ni qu’Ugo l’a lue");
    await transitionCaseOwner({ caseId: s.caseId, expectedVersion: (await readCase(s.caseId))!.version, transition: "human_takeover", actor: { type: "human", staffUserId: STAFF }, commandKey: `ux-take-${s.caseId}`, reason: "fixture" });
    const taken = await readOnly(f, s.ticketId);
    expect(taken).toContain("Pris en charge par une personne"); expect(taken).not.toContain("Équipe requise");
  });

  it("an undecryptable mail is unreadable, a body without text is unreadable too: never an empty mail, and no raw ciphertext is shown", async () => {
    const s = await seed(f);
    await f.client.query("UPDATE sav.messages SET body_ciphertext = 'not-a-ciphertext' WHERE id = $1", [s.messageId]);
    const html = await readOnly(f, s.ticketId);
    expect(html).toContain("Texte illisible : le déchiffrement a échoué, ce n’est pas un mail vide."); expect(html).not.toContain("not-a-ciphertext");
    const noText = await seed(f, { headers: {}, attachments: [] });
    expect(await readOnly(f, noText.ticketId)).toContain("Texte illisible");
  });

  it("the mail is read only inside the case's threads: the same Gmail id elsewhere is not shown", async () => {
    const s = await seed(f);
    const mailboxId = (await f.db.insert(savMailboxes).values({ email: `other-${randomUUID()}@example.invalid` }).returning())[0]!.id;
    const other = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: `t-${randomUUID()}`, customerEmail: "other@example.invalid" }).returning())[0]!;
    await f.db.insert(savMessages).values({ threadId: other.id, mailboxId, direction: "inbound", gmailMessageId: s.gmailMessageId, fromEmail: "other@example.invalid", toEmails: ["x@example.invalid"], subject: "Autre", bodyCiphertext: encryptSavPayload({ text: "Texte d’un autre dossier.", headers: {}, attachments: [] }), receivedAt: new Date("2026-10-28T07:00:00.000Z") });
    const html = await readOnly(f, s.ticketId);
    expect(html).toContain("Bonjour, je ne reçois pas le code SYN."); expect(html).not.toContain("Texte d’un autre dossier.");
  });

  it("a refused access reads nothing: no database access, no decryption", async () => {
    const s = await seed(f);
    state.dbReads = 0; state.decrypted = [];
    state.staff.mockRejectedValueOnce(Error("FORBIDDEN"));
    await expect(render(s.ticketId)).rejects.toThrow("FORBIDDEN");
    expect(state.dbReads).toBe(0); expect(state.decrypted).toEqual([]);
  });
});
