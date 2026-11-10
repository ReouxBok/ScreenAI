import { describe, expect, it } from "vitest";
import { planSavIntake, savIntakeActiveRequestSignal } from "./engine";
import type { EngineInput, EnginePolicy, IntakeAdapters, IntakeContact, MessageAnalysis, ReadResult } from "./engine-types";

/* Night V1 (D), inside the EXISTING V1 reader (no third reader, no model call). Synthetic texts only, shaped on
 * production feedback: a thanks that still waits for an answer is not a pure acknowledgement; an identification
 * request is never sent automatically to an address that declares it cannot receive replies. */
const at = "2026-11-09T10:00:00.000Z", mid = "10000000-0000-4000-8000-000000000001";
const resource = { resourceId: "synthetic-private-resource", revisionId: "fixture-v1", sha256: "0".repeat(64) };
const read = <T>(data: T): ReadResult<T> => ({ status: "complete", data, observedAt: at, reconstructedAsOf: at });

describe("night V1 D: a thanks that still waits for an answer is not a pure acknowledgement", () => {
  it.each([
    "Merci, je vais essayer mais j'attends votre retour pour la prolongation.",
    "C'est noté merci. J’attends toujours votre réponse concernant la facture.",
    "Merci beaucoup, dans l'attente de votre retour.",
    "Ok merci, nous attendons votre retour sur la prolongation.",
    "Thanks, I am waiting for your reply about the extension.",
  ])("keeps an open expectation: %s", text => expect(savIntakeActiveRequestSignal(text)).toBe(true));
  it.each([
    "C'est noté, merci.",
    "Merci, j'ai retrouvé mon accès.",
    "Merci pour votre retour, tout fonctionne.",
    "Merci pour votre réponse rapide.",
  ])("a plain thanks or a confirmed resolution stays inactive: %s", text => expect(savIntakeActiveRequestSignal(text)).toBe(false));
});

function fixture(fromEmail: string) {
  const input: EngineInput = {
    message: { id: mid, threadId: "20000000-0000-4000-8000-000000000001", fromEmail, toEmails: ["support@example.test"],
      currentText: "Synthetic notification text", contentComplete: true, direction: "inbound", receivedAt: at },
    conversation: read([]), latestInboundMessageId: mid, now: at, mode: "current", identificationAttemptId: "fixture-attempt",
  };
  const policy: EnginePolicy = { relationRevision: "synthetic-relation-v1", admittedRelations: [{ typeId: 449, category: "HUBSPOT_DEFINED" }],
    resources: { identification: resource, registrationNotFound: resource } };
  const analysis: MessageAnalysis = { messageId: mid, requests: [{ id: "r0", kind: "support", currentMessageId: mid }],
    ticketSummary: { title: "Synthetic", description: "Synthetic description", requestIds: ["r0"] } };
  const none = async () => read([] as never[]);
  const adapters: IntakeAdapters = { analyseMessage: async () => analysis, findContactsByEmail: async () => read([] as IntakeContact[]),
    directAssociations: none, getContact: async () => read(undefined as never), ticketsForContact: none, ticketHistory: none,
    assessIssues: async () => ({ investigationComplete: true, tickets: [] }) };
  return planSavIntake(input, adapters, policy);
}
describe("night V1 D: no automatic identification request to a no-reply system address", () => {
  it.each(["chat-noreply@example.test", "noreply@example.test", "no-reply@notifications.example.test", "do_not_reply@example.test",
    "mailer-daemon@example.test", "postmaster@example.test", "notifications.noreply@example.test"])("%s goes to a person, nothing is sent", async address => {
    const plan = await fixture(address);
    expect(plan.decision.disposition).toMatchObject({ kind: "collect_context", reasons: ["classification_incomplete"] });
    expect(plan.steps).toEqual([]);
  });
  it.each(["customer@example.test", "noreplyco@example.test", "reply@example.test", "replynow.team@example.test"])("an ordinary sender keeps the existing identification request: %s", async address => {
    const plan = await fixture(address);
    expect(plan.decision.disposition).toMatchObject({ kind: "request_identification", reason: "sender_contact_absent" });
    expect(plan.steps.map(step => step.mutation)).toEqual(["send_identity_template"]);
  });
});
