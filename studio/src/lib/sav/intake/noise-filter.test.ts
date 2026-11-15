import { describe, expect, it } from "vitest";
import { planSavIntake } from "./engine";
import { intakeAutomationAdapters } from "./automated-message";
import { savIntakeDecisionSchema } from "./contract";
import type { EngineInput, EnginePolicy, IntakeMessage } from "./engine-types";
import { SAV_INTAKE_NOISE_GUARDS, SAV_INTAKE_NOISE_REASONS, SAV_INTAKE_NOISE_RESOURCE, savIntakeNoiseFilterMode, savIntakeNoiseLogLine,
  savIntakeNoiseSignals, savIntakeNoiseVerdict, summarizeSavIntakeNoiseReplay, type SavIntakeNoiseInput } from "./noise-filter";

// Synthetic witnesses only: no real mailbox, sender, list or Message-ID.
const mid = "40000000-0000-4000-8000-000000000001", tid = "40000000-0000-4000-8000-000000000002", at = "2026-11-15T10:00:00.000Z";
const parsed = { "x-studio-automation-headers": "singleton-v1", "x-studio-noise-headers": "v1", "content-type": "text/plain; charset=UTF-8" };
const newsletterHeaders = { ...parsed, "list-id": "present", "list-unsubscribe": "present", precedence: "bulk" };
const fresh = { priorInbound: 0, outboundTo: 0, ticketThreads: 0 };
const input = (over: Partial<SavIntakeNoiseInput> = {}, context: Partial<SavIntakeNoiseInput["context"]> = {}): SavIntakeNoiseInput => ({
  messageId: mid, direction: "inbound", fromEmail: "news@lists.example.invalid", subject: "Lettre fictive de novembre",
  bodyText: "Les nouveautés fictives du mois. Se désinscrire.", headers: newsletterHeaders, attachmentCount: 0, senderHistory: fresh,
  ...over, context: { conversationLength: 1, threadTicketId: null, humanContext: false, quotedMailboxReply: false, ...context } });

describe("SAV-92 noise filter flag", () => {
  it("is off when absent, accepts only off|observe|on", () => {
    expect(savIntakeNoiseFilterMode({})).toBe("off");
    for (const mode of ["off", "observe", "on"] as const) expect(savIntakeNoiseFilterMode({ SAV_INTAKE_NOISE_FILTER: mode })).toBe(mode);
    for (const bad of ["ON", "true", "1", ""]) expect(() => savIntakeNoiseFilterMode({ SAV_INTAKE_NOISE_FILTER: bad })).toThrow("SAV_INTAKE_RUNTIME_CONFIGURATION_REQUIRED");
  });
});

describe("SAV-92 deterministic rules (closed reason codes)", () => {
  it.each([
    [{ ...parsed, "content-type": 'multipart/report; report-type=delivery-status; boundary="x"' }, "notify@example.invalid", "SAV_NOISE_DELIVERY_STATUS"],
    [parsed, "MAILER-DAEMON@mx.example.invalid", "SAV_NOISE_MAILER_DAEMON"],
    [{ ...parsed, "auto-submitted": "auto-generated" }, "alerts@example.invalid", "SAV_NOISE_AUTO_SUBMITTED"],
    [{ ...parsed, "auto-submitted": "Auto-Replied; owner=\"x\"" }, "person@example.invalid", "SAV_NOISE_AUTO_SUBMITTED"],
    [{ ...parsed, "x-autoreply": "yes" }, "person@example.invalid", "SAV_NOISE_X_AUTOREPLY"],
    [{ ...parsed, "x-autorespond": "1" }, "person@example.invalid", "SAV_NOISE_X_AUTOREPLY"],
    [{ ...parsed, precedence: "junk" }, "promo@example.invalid", "SAV_NOISE_PRECEDENCE"],
    [{ ...parsed, precedence: "List" }, "promo@example.invalid", "SAV_NOISE_PRECEDENCE"],
    [{ ...parsed, "list-id": "present", "list-unsubscribe": "present" }, "promo@example.invalid", "SAV_NOISE_LIST_HEADERS"],
    [{ ...parsed, "list-unsubscribe": "present" }, "no-reply@example.invalid", "SAV_NOISE_LIST_TECHNICAL_SENDER"],
    [{ ...parsed, "list-id": "present" }, "noreply@example.invalid", "SAV_NOISE_LIST_TECHNICAL_SENDER"],
  ] as const)("%o from %s → %s", (headers, fromEmail, reason) => {
    const verdict = savIntakeNoiseVerdict(input({ headers, fromEmail, subject: "Notification fictive" }));
    expect(verdict).toMatchObject({ verdict: "noise", reason, guard: null });
  });
  it("orders signals by priority and never echoes a value", () => {
    const signals = savIntakeNoiseSignals({ fromEmail: "mailer-daemon@example.invalid", headers: { ...newsletterHeaders, "auto-submitted": "auto-replied", "content-type": "multipart/report; report-type=delivery-status" } });
    expect(signals).toEqual(["SAV_NOISE_DELIVERY_STATUS", "SAV_NOISE_MAILER_DAEMON", "SAV_NOISE_AUTO_SUBMITTED", "SAV_NOISE_PRECEDENCE", "SAV_NOISE_LIST_HEADERS"]);
    expect(signals.every(s => (SAV_INTAKE_NOISE_REASONS as readonly string[]).includes(s))).toBe(true);
  });
  it.each([
    ["Auto-Submitted: no", { ...parsed, "auto-submitted": "no" }, "person@example.invalid"],
    ["a technical sender alone", parsed, "noreply@example.invalid"],
    ["postmaster alone", parsed, "postmaster@example.invalid"],
    ["List-Unsubscribe alone (sales tools add it to 1:1 mail)", { ...parsed, "list-unsubscribe": "present" }, "person@example.invalid"],
    ["List-Id alone", { ...parsed, "list-id": "present" }, "person@example.invalid"],
    ["Precedence: first-class", { ...parsed, precedence: "first-class" }, "person@example.invalid"],
    ["repeated Auto-Submitted (ambiguous marker)", { ...parsed, "x-studio-automation-headers": "ambiguous", "auto-submitted": "auto-generated" }, "person@example.invalid"],
    ["no Gmail parser marker", { "auto-submitted": "auto-generated", "content-type": "multipart/report; report-type=delivery-status" }, "person@example.invalid"],
    ["list headers without the capture marker", { "x-studio-automation-headers": "singleton-v1", "list-id": "x", "list-unsubscribe": "present", precedence: "bulk" }, "promo@example.invalid"],
    ["a plain human mail", parsed, "client@example.invalid"],
  ] as const)("no rule: %s", (_label, headers, fromEmail) => {
    expect(savIntakeNoiseVerdict(input({ headers, fromEmail }))).toMatchObject({ verdict: "keep", reason: null, guard: "SAV_NOISE_KEEP_NO_SIGNAL" });
  });
  it("treats missing or malformed headers as no evidence", () => {
    for (const headers of [undefined, null, [] as unknown as Record<string, string>, { "auto-submitted": 1 } as unknown as Record<string, string>])
      expect(savIntakeNoiseVerdict(input({ headers })).guard).toBe("SAV_NOISE_KEEP_NO_SIGNAL");
  });
});

describe("SAV-92 exclusion guards always win (a real customer is never filtered)", () => {
  it.each([
    ["an outbound mail", input({ direction: "outbound" }), "SAV_NOISE_GUARD_NOT_INBOUND"],
    ["a person's information, choice, pause or request", input({}, { humanContext: true }), "SAV_NOISE_GUARD_HUMAN_CONTEXT"],
    ["a thread linked to a ticket", input({}, { threadTicketId: "123" }), "SAV_NOISE_GUARD_THREAD_TICKET"],
    ["a thread with another message", input({}, { conversationLength: 2 }), "SAV_NOISE_GUARD_THREAD_HISTORY"],
    ["a partial history", input({}, { conversationLength: Number.POSITIVE_INFINITY }), "SAV_NOISE_GUARD_THREAD_HISTORY"],
    ["a reply quoting the mailbox", input({}, { quotedMailboxReply: true }), "SAV_NOISE_GUARD_SUPPORT_REPLY"],
    ["a reply prefix on a list mail", input({ subject: "RE: Lettre fictive" }), "SAV_NOISE_GUARD_SUPPORT_REPLY"],
    ["In-Reply-To on a list mail", input({ headers: { ...newsletterHeaders, "in-reply-to": "<x@example.invalid>" } }), "SAV_NOISE_GUARD_SUPPORT_REPLY"],
    ["a forward", input({ subject: "TR: Lettre fictive" }), "SAV_NOISE_GUARD_FORWARD"],
    ["a Reply-To elsewhere (form, helpdesk)", input({ headers: { ...newsletterHeaders, "x-studio-reply-to": "differs" } }), "SAV_NOISE_GUARD_REPLY_TO"],
    ["an attachment", input({ attachmentCount: 1 }), "SAV_NOISE_GUARD_ATTACHMENTS"],
    ["finance in the subject", input({ subject: "Votre facture fictive" }), "SAV_NOISE_GUARD_SENSITIVE"],
    ["refund in the body", input({ bodyText: "Je veux être remboursé. Se désinscrire." }), "SAV_NOISE_GUARD_SENSITIVE"],
    ["cancellation", input({ bodyText: "Merci de résilier mon compte." }), "SAV_NOISE_GUARD_SENSITIVE"],
    ["cancel subscription without accents", input({ bodyText: "je veux annuler mon abonnement" }), "SAV_NOISE_GUARD_SENSITIVE"],
    ["English payment", input({ bodyText: "Your payment failed" }), "SAV_NOISE_GUARD_SENSITIVE"],
    ["a contact form notification", input({ subject: "Nouveau message de formulaire fictif" }), "SAV_NOISE_GUARD_FORM_OR_QUOTE"],
    ["a quoted human conversation", input({ bodyText: "Bonjour.\nLe 3 nov., Client Fictif a écrit :\n> question" }), "SAV_NOISE_GUARD_FORM_OR_QUOTE"],
    ["an unreadable sender history", input({ senderHistory: null }), "SAV_NOISE_GUARD_SENDER_UNKNOWN"],
    ["a malformed sender history", input({ senderHistory: { priorInbound: -1, outboundTo: 0, ticketThreads: 0 } }), "SAV_NOISE_GUARD_SENDER_UNKNOWN"],
    ["a sender who wrote before", input({ senderHistory: { ...fresh, priorInbound: 1 } }), "SAV_NOISE_GUARD_KNOWN_SENDER"],
    ["a sender the support wrote to", input({ senderHistory: { ...fresh, outboundTo: 1 } }), "SAV_NOISE_GUARD_KNOWN_SENDER"],
    ["a sender with a ticketed thread", input({ senderHistory: { ...fresh, ticketThreads: 1 } }), "SAV_NOISE_GUARD_KNOWN_SENDER"],
  ] as const)("keeps %s", (_label, value, guard) => {
    const verdict = savIntakeNoiseVerdict(value);
    expect(verdict.verdict).toBe("keep");
    expect(verdict.guard).toBe(guard);
    expect(verdict.reason).not.toBeNull();
  });
  it("lets an autoreply or a bounce carry its reply headers, never a forward", () => {
    const bounce = { ...parsed, "content-type": "multipart/report; report-type=delivery-status", "in-reply-to": "<x@example.invalid>" };
    expect(savIntakeNoiseVerdict(input({ headers: bounce, subject: "Re: Undeliverable", attachmentCount: 2 })).verdict).toBe("noise");
    expect(savIntakeNoiseVerdict(input({ headers: { ...parsed, "auto-submitted": "auto-replied" }, subject: "Réponse automatique : Re: fictif" })).verdict).toBe("noise");
    expect(savIntakeNoiseVerdict(input({ headers: { ...parsed, "auto-submitted": "auto-replied" }, subject: "Fwd: fictif" })).guard).toBe("SAV_NOISE_GUARD_FORWARD");
  });
  it("asks for the sender history only after every other guard passed", () => {
    expect(savIntakeNoiseVerdict(input({ senderHistory: undefined }))).toMatchObject({ verdict: "keep", guard: "SAV_NOISE_GUARD_SENDER_UNKNOWN", needsSenderHistory: true });
    expect(savIntakeNoiseVerdict(input({ senderHistory: undefined, subject: "Votre facture" })).needsSenderHistory).toBeUndefined();
  });
  it("closes every code list", () => {
    expect(new Set(SAV_INTAKE_NOISE_GUARDS).size).toBe(SAV_INTAKE_NOISE_GUARDS.length);
    expect(SAV_INTAKE_NOISE_REASONS).toHaveLength(7);
  });
});

describe("SAV-92 observation output carries no personal data", () => {
  it("logs the message id and codes only", () => {
    const value = input({ fromEmail: "secret.person@private.example.invalid", subject: "Sujet privé", bodyText: "Texte privé" });
    const line = savIntakeNoiseLogLine("observe", mid, savIntakeNoiseVerdict(value));
    expect(JSON.parse(line)).toEqual({ event: "sav_intake_noise_filter", revision: "sav-intake-noise-filter.v1", mode: "observe", messageId: mid,
      verdict: "noise", reason: "SAV_NOISE_PRECEDENCE", guard: null, signals: ["SAV_NOISE_PRECEDENCE", "SAV_NOISE_LIST_HEADERS"], routed: false });
    expect(line).not.toMatch(/secret|private|privé|@/i);
    expect(JSON.parse(savIntakeNoiseLogLine("on", mid, savIntakeNoiseVerdict(value))).routed).toBe(true);
  });
  it("summarizes a replay per view, verdict, rule and guard", () => {
    const records = [
      { messageId: "a", view: "other", verdict: savIntakeNoiseVerdict(input()) },
      { messageId: "b", view: "to_validate", verdict: savIntakeNoiseVerdict(input({ headers: { ...parsed, "auto-submitted": "auto-generated" }, fromEmail: "x@example.invalid" })) },
      { messageId: "c", view: "to_validate", verdict: savIntakeNoiseVerdict(input({ senderHistory: { ...fresh, priorInbound: 3 } })) },
      { messageId: "d", view: null, verdict: savIntakeNoiseVerdict(input({ headers: parsed, fromEmail: "client@example.invalid" })) },
    ];
    expect(summarizeSavIntakeNoiseReplay(records)).toEqual({ revision: "sav-intake-noise-filter.v1", total: 4,
      byView: { none: 1, other: 1, to_validate: 2 }, byVerdict: { keep: 2, noise: 2 },
      noiseByReason: { SAV_NOISE_AUTO_SUBMITTED: 1, SAV_NOISE_PRECEDENCE: 1 }, noiseByView: { other: 1, to_validate: 1 },
      keptWithSignalByGuard: { SAV_NOISE_GUARD_KNOWN_SENDER: 1 },
      signalCounts: { SAV_NOISE_DELIVERY_STATUS: 0, SAV_NOISE_MAILER_DAEMON: 0, SAV_NOISE_AUTO_SUBMITTED: 1, SAV_NOISE_X_AUTOREPLY: 0,
        SAV_NOISE_PRECEDENCE: 2, SAV_NOISE_LIST_HEADERS: 2, SAV_NOISE_LIST_TECHNICAL_SENDER: 0 },
      noiseFromToValidate: ["b"] });
  });
});

describe("SAV-92 engine and contract: Autre without a model call", () => {
  const message = (over: Partial<IntakeMessage> = {}): IntakeMessage => ({ id: mid, threadId: tid, receivedAt: at, fromEmail: "news@lists.example.invalid",
    toEmails: ["support@example.invalid"], currentText: "Les nouveautés fictives du mois.", contentComplete: true, direction: "inbound", ...over });
  const engineInput = (over: Partial<EngineInput> = {}, m = message()): EngineInput => ({ message: m, conversation: { status: "complete", data: [m], observedAt: at },
    latestInboundMessageId: mid, now: at, mode: "current", identificationAttemptId: mid, ...over });
  const base: EnginePolicy = { relationRevision: "synthetic-relation-v1", admittedRelations: [], resources: {} };
  const noise = { messageId: mid, sourceHash: "b".repeat(64), reason: "SAV_NOISE_PRECEDENCE", signals: ["SAV_NOISE_PRECEDENCE"], resource: { ...SAV_INTAKE_NOISE_RESOURCE } };

  it("routes a filtered mail to Autre with the noise proof and no read call", async () => {
    const plan = await planSavIntake(engineInput(), intakeAutomationAdapters(mid), { ...base, noiseFilter: noise }, { timeoutMs: 1000 });
    expect(plan.decision.classification).toBe("other");
    expect(plan.decision.disposition).toMatchObject({ kind: "no_ticket", reason: "qualified_other", qualifiedInformation: "automated_noise", nextAction: "none" });
    expect(plan.progress).toMatchObject({ kind: "qualified_other", view: "other", classificationRule: SAV_INTAKE_NOISE_RESOURCE });
    expect(plan.decision.evidence.map(e => e.source).sort()).toEqual(["automation_headers", "current_message"]);
    expect(plan.steps).toEqual([]);
    expect(plan.readCalls).toBe(0);
  });
  it("lets a person's choice, an override, information or another message win", async () => {
    const adapters = intakeAutomationAdapters(mid);
    const other = message({ id: "40000000-0000-4000-8000-000000000009", receivedAt: "2026-11-15T09:00:00.000Z", direction: "outbound" });
    for (const [input, policy] of [
      [engineInput({ conversation: { status: "complete", data: [message(), other], observedAt: at } }), { ...base, noiseFilter: noise }],
      [engineInput({}, message({ operatorInformation: { id: "40000000-0000-4000-8000-000000000003", revision: 1, messageId: mid, actorId: "40000000-0000-4000-8000-000000000004", at, text: "Client réel.", contentHash: "0".repeat(64) } })), { ...base, noiseFilter: noise }],
      [engineInput(), { ...base, noiseFilter: { ...noise, messageId: "40000000-0000-4000-8000-000000000008" } }],
      [engineInput(), { ...base, noiseFilter: noise, manualSupportOverride: { ...SAV_INTAKE_NOISE_RESOURCE } }],
    ] as const) {
      const plan = await planSavIntake(input, adapters, policy as EnginePolicy, { timeoutMs: 1000 });
      expect(plan.decision.disposition).not.toMatchObject({ qualifiedInformation: "automated_noise" });
      expect(plan.progress.kind).not.toBe("qualified_other");
    }
  });
  it("rejects an automated_noise decision without the header proof", async () => {
    const plan = await planSavIntake(engineInput(), intakeAutomationAdapters(mid), { ...base, noiseFilter: noise }, { timeoutMs: 1000 });
    const withoutProof = { ...plan.decision, evidence: plan.decision.evidence.filter(e => e.source !== "automation_headers"),
      disposition: { ...plan.decision.disposition, evidenceIds: plan.decision.disposition.evidenceIds.filter(id => id !== "noise-filter") } };
    expect(savIntakeDecisionSchema.safeParse(plan.decision).success).toBe(true);
    expect(savIntakeDecisionSchema.safeParse(withoutProof).success).toBe(false);
    expect(savIntakeDecisionSchema.safeParse({ ...plan.decision, classification: "acknowledgement" }).success).toBe(false);
  });
});
