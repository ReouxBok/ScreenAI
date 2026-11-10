import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
import { eq } from "drizzle-orm";
import { savMailboxes, savMessages, savThreads } from "@/db/schema";
import { encryptSavPayload } from "../crypto";
import { openCaseEvent, readCase } from "./case-store";
import { caseDedupeKey } from "./case-types";
import { caseReplyPayloadHash, type CaseReplyProposal } from "./case-effects";
import { finalizeCaseReplyProposal, prepareCaseReplyText } from "./case-reply-outbound";
import { renderSavOutboundReply, savReplyFooter } from "../reply-format";
import { getCaseReplyEffect } from "./case-reply-registry";
import { decideCaseReply, submitCaseReplyProposal } from "./case-reply-store";
import { savCaseReplyValidations } from "./case-reply-validation-table";

// PROPOSED TO POLE C (owner of case-reply-store.ts), not applied by UX: the store refuses, before any row or hash is written, a proposal whose text breaks
// the UX outbound contract sav-v2-reply-outbound.v1; a finalized proposal is stored, shown and approved exactly as it will be sent.
// UX (V2 outbound format) on pole C's REAL store and reader, A's migrations through 0051 (PGlite): the text a person reads in the single-reply view is the
// text they approve, the text that is hashed and the MIME body that would be sent, mention included. Synthetic data only; no Gmail call, no model, no
// network. The approval uses a test-only authorizer (no permissive port exists in application code); the store and reader are not modified.
const STAFF = "20000000-0000-4000-8000-000000000003", AT = "2026-10-27T09:00:00.000Z";
const ADMITTED = {
  policy: { revision: "policy-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT },
  qualification: { requests: [{ requestId: "r1", family: "access" as const, provenance: { kind: "human" as const, staffUserId: STAFF, at: AT } }],
    identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-1" } }, crmContext: "complete" as const, teamSignals: [] },
};
const deps = { env: () => ({ SAV_CASE_EFFECTS: "supervised" }), readTicketOwner: async () => "v2" as const, currentPolicyRevision: async () => "policy-r1" };
const allow = () => ({ allowed: true as const, basis: "fixture.allow" });

async function seed(f: Awaited<ReturnType<typeof createSavTestDb>>) {
  const mailboxId = (await f.db.insert(savMailboxes).values({ email: `support-${randomUUID()}@example.invalid` }).returning())[0]!.id;
  const gmailMessageId = `gm-${randomUUID()}`;
  const thread = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: `t-${randomUUID()}`, customerEmail: "customer@example.invalid" }).returning())[0]!;
  const message = (await f.db.insert(savMessages).values({ threadId: thread.id, mailboxId, direction: "inbound", gmailMessageId, fromEmail: "customer@example.invalid", toEmails: ["support@example.invalid"],
    subject: "Synthetic", bodyCiphertext: encryptSavPayload({ text: "Synthetic.", headers: { "message-id": "<in@example.invalid>" }, attachments: [] }), receivedAt: new Date("2026-10-28T07:00:00.000Z") }).returning())[0]!;
  const { case: opened } = await openCaseEvent({ ticketId: String(9_500_000 + Math.floor(Math.random() * 1000)), threadId: thread.id, admission: ADMITTED, kind: "inbound_confirmed",
    dedupeKey: caseDedupeKey.inbound(gmailMessageId), sourceRef: { type: "email", id: gmailMessageId }, occurredAt: "2026-10-28T07:00:00.000Z" });
  const version = (await readCase(opened.caseId))!.version;
  const proposal = (text: string): CaseReplyProposal => ({ caseId: opened.caseId, caseVersion: version, triggerEventId: `inbound:${gmailMessageId}`, inboundMessageId: message.id, purpose: "answer",
    recipient: "customer@example.invalid", subject: "Synthetic", text });
  const context = { mailboxEmail: "support@example.invalid", gmailThreadId: thread.gmailThreadId, priorRfcMessageId: "<in@example.invalid>", inboundFromEmail: "customer@example.invalid" };
  return { caseId: opened.caseId, proposal, context };
}

const count = async (f: Awaited<ReturnType<typeof createSavTestDb>>, caseId: string) => (await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.caseId, caseId))).length;

beforeEach(() => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-execution-encryption-key-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on"); vi.stubEnv("SAV_CASE_EFFECTS", "supervised");
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); })); });

describe("C's store and the UX outbound contract: refused before creation or hash, stored final text = shown = approved", () => {
  let f: Awaited<ReturnType<typeof createSavTestDb>>;
  beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
  afterAll(async () => { state.db = null; await f.client.close(); });

  it("a raw text, a human-only signature or a stacked mention is refused (ai_notice_missing): no row written (the automated format is stored; the RIGHT to send under it is judged at the approval, see the next tests)", async () => {
    const s = await seed(f);
    for (const text of ["Bonjour,\n\nTexte brut.", renderSavOutboundReply("Bonjour, signé équipe.", "fr", "manual_authored"),
      `${prepareCaseReplyText("Bonjour.", "en", "manual_reviewed")}\n\n${savReplyFooter("fr", "manual_reviewed")}`]) {
      expect(await submitCaseReplyProposal(s.proposal(text), deps)).toEqual({ ok: false, code: "proposal_invalid", detail: "ai_notice_missing" });
    }
    expect(await count(f, s.caseId)).toBe(0);
  });

  it("an empty text keeps its own refusal (text), checked first", async () => {
    const s = await seed(f);
    expect(await submitCaseReplyProposal(s.proposal("   "), deps)).toEqual({ ok: false, code: "proposal_invalid", detail: "text" });
  });

  it("a finalized proposal is stored as finalized, shown and approved as is; finalizing it again is the same row (same hash, idempotent submit)", async () => {
    for (const language of ["fr", "en"] as const) {
      const s = await seed(f);
      const final = finalizeCaseReplyProposal(s.proposal(language === "fr" ? "Bonjour,\n\nMarche synthétique." : "Hello,\n\nSynthetic steps."), { language, validation: "human" });
      const first = await submitCaseReplyProposal(final, deps), again = await submitCaseReplyProposal(finalizeCaseReplyProposal(final, { language, validation: "human" }), deps);
      if (!first.ok || !again.ok) throw Error("SUBMIT");
      expect(again).toMatchObject({ id: first.id, created: false });
      const view = (await getCaseReplyEffect({ validationId: first.id, caseId: s.caseId }, deps))!;
      expect(view.proposal.text).toBe(final.text);
      expect(view.payloadHash).toBe(caseReplyPayloadHash(final));
      expect(await decideCaseReply({ action: "approve", validationId: first.id, approverId: STAFF, authorizer: allow, deps,
        seen: { payloadHash: view.payloadHash, caseVersion: view.caseVersion, recipient: view.recipient } })).toMatchObject({ ok: true });
    }
  });

  it("an edit after the approval is a new text: refused for this trigger, the approval stays on the text the person read", async () => {
    const s = await seed(f);
    const final = finalizeCaseReplyProposal(s.proposal("Bonjour,\n\nPremière version."), { language: "fr", validation: "human" });
    const first = await submitCaseReplyProposal(final, deps);
    if (!first.ok) throw Error("SUBMIT");
    await decideCaseReply({ action: "approve", validationId: first.id, approverId: STAFF, authorizer: allow, deps, seen: { payloadHash: caseReplyPayloadHash(final), caseVersion: final.caseVersion, recipient: final.recipient } });
    const edited = finalizeCaseReplyProposal(s.proposal("Bonjour,\n\nVersion modifiée."), { language: "fr", validation: "human" });
    expect(await submitCaseReplyProposal(edited, deps)).toEqual({ ok: false, code: "trigger_already_approved" });
    expect((await getCaseReplyEffect({ validationId: first.id, caseId: s.caseId }, deps))!).toMatchObject({ validation: "approved", proposal: { text: final.text } });
  });
});
