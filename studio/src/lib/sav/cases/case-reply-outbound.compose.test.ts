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
import { caseReplyKey, caseReplyPayloadHash, type CaseReplyApproval, type CaseReplyProposal } from "./case-effects";
import { buildReplySendIntent } from "./case-effect-intents";
import { finalizeCaseReplyProposal, prepareCaseReplyText } from "./case-reply-outbound";
import { getCaseReplyEffect } from "./case-reply-registry";
import { decideCaseReply, submitCaseReplyProposal } from "./case-reply-store";
import { savCaseReplyValidations } from "./case-reply-validation-table";

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

/** Submit, read the single-reply view, approve what that view showed, and rebuild the approval from the stored row as the executor's driver does. */
async function validate(s: Awaited<ReturnType<typeof seed>>, text: string) {
  const submitted = await submitCaseReplyProposal(s.proposal(text), deps);
  if (!submitted.ok) throw Error(submitted.code);
  const view = (await getCaseReplyEffect({ validationId: submitted.id, caseId: s.caseId }, deps))!;
  const decided = await decideCaseReply({ action: "approve", validationId: submitted.id, approverId: STAFF, authorizer: allow, deps,
    seen: { payloadHash: view.payloadHash, caseVersion: view.caseVersion, recipient: view.recipient } });
  if (!decided.ok) throw Error(decided.code);
  const [row] = await (state.db as Awaited<ReturnType<typeof createSavTestDb>>["db"]).select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, submitted.id));
  const approval: CaseReplyApproval = { payloadHash: row!.payloadHash, caseVersion: row!.caseVersion, recipient: row!.recipient, approvedBy: row!.decidedBy!, approvedAt: row!.decidedAt!.toISOString() };
  return { view, approval };
}

beforeEach(() => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-execution-encryption-key-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on"); vi.stubEnv("SAV_CASE_EFFECTS", "supervised");
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); })); });

describe("V2 reply: preview = approved = hashed = sent, mention included (C's real store and reader)", () => {
  let f: Awaited<ReturnType<typeof createSavTestDb>>;
  beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
  afterAll(async () => { state.db = null; await f.client.close(); });

  it("FR and EN: the view shows the final text with its mention; the MIME body is that text byte for byte, to the recipient shown", async () => {
    for (const language of ["fr", "en"] as const) {
      const s = await seed(f);
      // The producer's single entry point: the draft becomes the final proposal before C stores, shows or hashes anything.
      const { text } = finalizeCaseReplyProposal(s.proposal(language === "fr" ? "Bonjour,\n\nVoici la marche synthétique." : "Hello,\n\nSynthetic steps."), { language, validation: "human" });
      const { view, approval } = await validate(s, text);
      expect(view.proposal.text).toBe(text);
      expect(view.payloadHash).toBe(caseReplyPayloadHash(s.proposal(text)));
      const intent = buildReplySendIntent(s.proposal(view.proposal.text), approval, s.context);
      expect(Buffer.from(intent.raw.split("\r\n\r\n")[1]!, "base64").toString("utf8")).toBe(view.proposal.text);
      expect(intent.recipient).toBe(view.recipient);
      expect(intent.caseEffect.payloadHash).toBe(view.payloadHash);
    }
  });

  it("a row approved WITHOUT a mention (stored before the contract, written here directly, not through the store) is shown as stored and never sent", async () => {
    const s = await seed(f);
    const proposal = s.proposal("Bonjour,\n\nTexte synthétique sans mention.");
    // A historical row as an older store could leave it: the reader shows what is stored, the intent refuses it whatever the store does today.
    // The table's own guard makes a row start as a proposal: it is inserted as one, then decided, as the older store did.
    const [inserted] = await f.db.insert(savCaseReplyValidations).values({ caseId: s.caseId, replyKey: caseReplyKey(proposal.caseId, proposal.triggerEventId),
      payloadHash: caseReplyPayloadHash(proposal), caseVersion: proposal.caseVersion, recipient: proposal.recipient, proposalCiphertext: encryptSavPayload(proposal) }).returning();
    const [row] = await f.db.update(savCaseReplyValidations).set({ state: "approved", decidedBy: STAFF, decidedAt: new Date("2026-10-31T09:00:00.000Z"), authorizationBasis: "fixture.allow" })
      .where(eq(savCaseReplyValidations.id, inserted!.id)).returning();
    const view = (await getCaseReplyEffect({ validationId: row!.id, caseId: s.caseId }, deps))!;
    expect(view.proposal.text).toBe(proposal.text);
    const approval: CaseReplyApproval = { payloadHash: row!.payloadHash, caseVersion: row!.caseVersion, recipient: row!.recipient, approvedBy: row!.decidedBy!, approvedAt: row!.decidedAt!.toISOString() };
    expect(() => buildReplySendIntent(s.proposal(view.proposal.text), approval, s.context)).toThrow("SAV_CASE_EFFECT_AI_NOTICE_MISSING");
  });

  it("an edit is a new proposal: the edited text needs its own approval, and the earlier approval does not send it", async () => {
    const s = await seed(f);
    const first = prepareCaseReplyText("Bonjour,\n\nPremière version.", "fr", "manual_reviewed");
    const { approval } = await validate(s, first);
    const edited = prepareCaseReplyText("Bonjour,\n\nVersion corrigée.", "fr", "manual_reviewed");
    expect(() => buildReplySendIntent(s.proposal(edited), approval, s.context)).toThrow("SAV_CASE_EFFECT_PAYLOAD_CHANGED");
  });
});
