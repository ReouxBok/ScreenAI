import { describe, expect, it } from "vitest";
import { intakeAutomatedMessage, intakeAutomationAdapters } from "./automated-message";
import { planSavIntake } from "./engine";
import type { EngineInput, EnginePolicy, IntakeMessage } from "./engine-types";

// Synthetic witnesses only: no real mailbox, sender, campaign or Message-ID.
const at = "2026-11-03T10:00:00.000Z";
const mid = "30000000-0000-4000-8000-000000000001";
const supportId = "<sav-synthetic-action@studio.example.invalid>";
const campaignId = "<synthetic-campaign@marketing.example.invalid>";
const message = (properties: Partial<IntakeMessage> = {}): IntakeMessage => ({ id: mid, threadId: "30000000-0000-4000-8000-000000000002",
  receivedAt: at, fromEmail: "synthetic-customer@example.invalid", toEmails: ["support@example.invalid"],
  currentText: "Réponse automatique : je suis absent jusqu'au 10 novembre.", contentComplete: true, direction: "inbound", ...properties });
const detect = (headers: unknown, options: { message?: Partial<IntakeMessage>; attachments?: unknown; support?: string[] } = {}) =>
  intakeAutomatedMessage({ message: message(options.message), headers, attachments: options.attachments ?? [], supportMessageIds: options.support ?? [supportId] });
const absence = { "x-studio-automation-headers": "singleton-v1", "auto-submitted": "auto-replied", "content-type": "text/plain; charset=UTF-8", "in-reply-to": campaignId, references: campaignId };
const report = { "x-studio-automation-headers": "singleton-v1", "auto-submitted": "auto-replied", "content-type": 'multipart/report; report-type=delivery-status; boundary="synthetic"', "in-reply-to": supportId, references: supportId };

describe("V1 automation gate before any reservation or model call", () => {
  it("excludes a marketing absence reply proven by its Gmail headers", () => {
    expect(detect(absence)).toEqual({ revision: "sav-intake-automation-gate.v2", kind: "automatic_reply", code: "SAV_INTAKE_AUTOMATED_REPLY",
      signals: ["auto-submitted:auto-replied", "in-reply-to:present"] });
    expect(detect({ ...absence, "auto-submitted": "Auto-Replied; owner-email=\"synthetic@example.invalid\"" })?.kind).toBe("automatic_reply");
  });
  it("never decides from the subject or text: a human reply with the same subject stays normal", () => {
    expect(detect({ "content-type": "text/plain", "in-reply-to": campaignId })).toBeNull();
    expect(detect({ ...absence, "auto-submitted": "no" })).toBeNull();
    expect(detect({ ...absence, "auto-submitted": "" })).toBeNull();
  });
  it("leaves mixed or ambiguous messages to the normal SAV", () => {
    expect(detect(absence, { message: { currentText: "Je suis absent. Je souhaite résilier." } })).toBeNull();
    expect(detect(absence, { message: { contentComplete: false } })).toBeNull();
    expect(detect({ ...absence, "x-studio-automation-headers": "ambiguous" })).toBeNull();
    expect(detect({ ...absence, "x-studio-automation-headers": "" })).toBeNull();
    expect(detect(absence, { attachments: [{ filename: "synthetic.pdf" }] })).toBeNull();
    expect(detect(absence, { message: { unreadAttachments: [{ sourceId: "file-1", reason: "unsupported_type" }] } })).toBeNull();
    expect(detect({ ...absence, "content-type": "multipart/mixed; boundary=x" })).toBeNull();
    expect(detect({ ...absence, "content-type": "message/rfc822" })).toBeNull();
    expect(detect({ ...absence, "auto-submitted": "auto-replied, auto-generated" })).toBeNull();
    expect(detect({ ...absence, "auto-submitted": "auto-notified" })).toBeNull();
    expect(detect({ ...absence, "in-reply-to": "" })).toBeNull();
    // auto-generated alone (forms, notifications) may carry a need: only a response to a support mail is qualified.
    expect(detect({ ...absence, "auto-submitted": "auto-generated" })).toBeNull();
    expect(detect({ ...absence, "auto-submitted": "auto-generated", "in-reply-to": supportId })?.signals).toEqual(["auto-submitted:auto-generated", "in-reply-to:support-message"]);
  });
  it("never hides a forward that carries a need, nor information added by a person", () => {
    expect(detect({ ...absence, "auto-submitted": "auto-forwarded" })).toBeNull();
    expect(detect(absence, { message: { operatorInformation: { id: "30000000-0000-4000-8000-000000000003", revision: 1, messageId: mid,
      actorId: "30000000-0000-4000-8000-000000000004", at, text: "Le client attend une réponse.", contentHash: "0".repeat(64) } } })).toBeNull();
    expect(detect(absence, { message: { direction: "outbound" } })).toBeNull();
  });
  it("keeps a delivery report about a support mail apart, without classifying it", () => {
    const failure = detect(report);
    expect(failure).toMatchObject({ kind: "support_delivery_failure", code: "SAV_INTAKE_SUPPORT_DELIVERY_FAILURE" });
    expect(JSON.stringify(failure)).not.toMatch(/example|@|</);
    expect(detect({ ...report, "in-reply-to": "", references: `<other@example.invalid> ${supportId}` })?.kind).toBe("support_delivery_failure");
    // A report that names no support mail of this thread is not qualified here: normal path.
    expect(detect(report, { support: [] })).toBeNull();
    expect(detect({ ...report, "in-reply-to": campaignId, references: campaignId })).toBeNull();
    // Delivery reports carry the original as a part: the attachment rule does not apply to them.
    expect(detect(report, { attachments: [{ filename: "original.eml" }] })?.kind).toBe("support_delivery_failure");
  });
  it("treats missing, malformed or old metadata as unknown, never as an automation", () => {
    for (const headers of [undefined, null, "auto-replied", [], {}, { "auto-submitted": 1, "in-reply-to": campaignId }, { "auto-submitted": "auto-replied" }])
      expect(detect(headers)).toBeNull();
    expect(detect({ ...absence, "in-reply-to": `${campaignId} ${campaignId}` })?.kind).toBe("automatic_reply");
  });
  it("plans the engine's own human question without a model or CRM read", async () => {
    const adapters = intakeAutomationAdapters(mid);
    await expect(adapters.findContactsByEmail("synthetic-customer@example.invalid", AbortSignal.timeout(1000))).rejects.toThrow("SAV_INTAKE_AUTOMATION_NO_EXTERNAL_READ");
    const input: EngineInput = { message: message(), conversation: { status: "complete", data: [message()], observedAt: at },
      latestInboundMessageId: mid, now: at, mode: "current", identificationAttemptId: mid };
    const policy: EnginePolicy = { relationRevision: "synthetic-relation-v1", admittedRelations: [], resources: {} };
    const plan = await planSavIntake(input, adapters, policy, { timeoutMs: 1000 });
    expect(plan.decision.classification).toBe("unknown");
    expect(plan.decision.requests).toEqual([]);
    expect(plan.decision.disposition).toMatchObject({ kind: "collect_context", reasons: ["classification_incomplete"] });
    expect(plan.progress).toMatchObject({ kind: "human_choice", questionCode: "request_scope_uncertain", view: "to_validate" });
    expect(plan.steps).toEqual([]);
    expect(plan.readCalls).toBe(1);
  });
});
