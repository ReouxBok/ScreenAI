import { describe, expect, it } from "vitest";
import { planSavIntake } from "./engine";
import { intakeAutomationAdapters } from "./automated-message";
import { savIntakeDecisionSchema } from "./contract";
import type { EngineInput, EnginePolicy, IntakeMessage } from "./engine-types";
import { SAV_INTAKE_NOISE_GUARDS, SAV_INTAKE_NOISE_REASONS, SAV_INTAKE_NOISE_RESOURCE, SAV_INTAKE_NOISE_STRONG_REASONS, savIntakeNoiseFilterMode, savIntakeNoiseLogLine,
  savIntakeNoiseSignals, savIntakeNoiseVerdict, summarizeSavIntakeNoiseReplay, type SavIntakeNoiseInput } from "./noise-filter";

// Synthetic witnesses only: no real mailbox, sender, list or Message-ID.
const mid = "40000000-0000-4000-8000-000000000001", tid = "40000000-0000-4000-8000-000000000002", at = "2026-11-15T10:00:00.000Z";
const parsed = { "x-studio-automation-headers": "singleton-v1", "x-studio-noise-headers": "v1", "content-type": "text/plain; charset=UTF-8" };
const dsnHeaders = { ...parsed, "content-type": 'multipart/report; report-type=delivery-status; boundary="x"' };
const absenceHeaders = { ...parsed, "auto-submitted": "auto-replied" };
const newsletterHeaders = { ...parsed, "list-id": "present", "list-unsubscribe": "present", precedence: "bulk" };
const fresh = { priorInbound: 0, priorInboundNotAutomatic: 0, outboundTo: 0, ticketThreads: 0 };
const customerText = "Bonjour, je n'arrive plus à me connecter, pouvez-vous m'aider ?";
// Default: a bounce (strong rule) from a new mailer-daemon.
const input = (over: Partial<SavIntakeNoiseInput> = {}, context: Partial<SavIntakeNoiseInput["context"]> = {}): SavIntakeNoiseInput => ({
  messageId: mid, direction: "inbound", fromEmail: "mailer-daemon@mx.example.invalid", subject: "Delivery Status Notification (Failure)",
  bodyText: "Address not found. Your message could not be delivered.", headers: dsnHeaders, attachmentCount: 0, senderHistory: fresh,
  ...over, context: { conversationLength: 1, threadTicketId: null, humanContext: false, quotedMailboxReply: false, ...context } });

describe("SAV-92 noise filter flag", () => {
  it("is off when absent, accepts only off|observe|on", () => {
    expect(savIntakeNoiseFilterMode({})).toBe("off");
    for (const mode of ["off", "observe", "on"] as const) expect(savIntakeNoiseFilterMode({ SAV_INTAKE_NOISE_FILTER: mode })).toBe(mode);
    for (const bad of ["ON", "true", "1", ""]) expect(() => savIntakeNoiseFilterMode({ SAV_INTAKE_NOISE_FILTER: bad })).toThrow("SAV_INTAKE_RUNTIME_CONFIGURATION_REQUIRED");
  });
});

describe("SAV-92 strong rules: the only ones that can route to Autre", () => {
  it.each([
    ["a delivery-status report", input({ fromEmail: "notify@example.invalid", subject: "Notification", bodyText: "Rapport." }), "SAV_NOISE_DELIVERY_STATUS"],
    ["mailer-daemon with Auto-Submitted and non-delivery wording", input({ headers: { ...parsed, "auto-submitted": "auto-replied" } }), "SAV_NOISE_MAILER_DAEMON"],
    ["mailer-daemon with Auto-Submitted and French wording", input({ headers: { ...parsed, "auto-submitted": "auto-generated" }, subject: "Message non remis", bodyText: "Votre message n'a pas pu être distribué." }), "SAV_NOISE_MAILER_DAEMON"],
    ["auto-replied with an absence wording", input({ headers: absenceHeaders, fromEmail: "person@example.invalid", subject: "Réponse automatique : Re: fictif", bodyText: "Je suis absente jusqu'au 20 novembre." }), "SAV_NOISE_AUTO_REPLIED"],
    ["auto-replied, out of office in English", input({ headers: absenceHeaders, fromEmail: "person@example.invalid", subject: "Out of Office", bodyText: "Back on Monday." }), "SAV_NOISE_AUTO_REPLIED"],
  ] as const)("%s → noise", (_label, value, reason) => {
    expect(savIntakeNoiseVerdict(value)).toMatchObject({ verdict: "noise", reason, strength: "strong", guard: null });
  });
  it("lets a bounce or an absence reply carry reply headers, never a forward", () => {
    const withReply = { ...dsnHeaders, "in-reply-to": "<x@example.invalid>" };
    expect(savIntakeNoiseVerdict(input({ headers: withReply, subject: "Re: Undeliverable" })).verdict).toBe("noise");
    expect(savIntakeNoiseVerdict(input({ headers: absenceHeaders, fromEmail: "p@example.invalid", subject: "Fwd: absence", bodyText: "Je suis absent." })).guard).toBe("SAV_NOISE_GUARD_FORWARD");
  });
});

describe("SAV-92 weak rules never route (cases reproduced by the review)", () => {
  const person = { fromEmail: "client@example.invalid", subject: "Problème de connexion", bodyText: customerText };
  it.each([
    ["A: mail via a Google-group alias (Precedence list + List-Id + List-Unsubscribe)", input({ ...person, headers: { ...parsed, precedence: "list", "list-id": "present", "list-unsubscribe": "present" } }), "SAV_NOISE_WEAK_LIST_HEADERS"],
    ["B: helpdesk Auto-Submitted: auto-generated", input({ ...person, headers: { ...parsed, "auto-submitted": "auto-generated" } }), "SAV_NOISE_WEAK_AUTO_GENERATED"],
    ["D: Precedence: bulk alone", input({ ...person, headers: { ...parsed, precedence: "bulk" } }), "SAV_NOISE_WEAK_PRECEDENCE"],
    ["H: unknown Auto-Submitted keyword", input({ ...person, headers: { ...parsed, "auto-submitted": "auto-forwarded" } }), "SAV_NOISE_WEAK_AUTO_SUBMITTED_OTHER"],
    ["auto-replied without any absence wording", input({ ...person, headers: absenceHeaders }), "SAV_NOISE_WEAK_AUTO_SUBMITTED_OTHER"],
    ["X-Autoreply alone", input({ ...person, headers: { ...parsed, "x-autoreply": "yes" } }), "SAV_NOISE_WEAK_X_AUTOREPLY"],
    ["mailer-daemon without non-delivery wording", input({ ...person, fromEmail: "mailer-daemon@example.invalid", headers: parsed }), "SAV_NOISE_WEAK_DAEMON_SENDER"],
    ["review 2: a person writing from postmaster@client about a non-delivery", input({ fromEmail: "postmaster@client.example.invalid", headers: parsed, subject: "Mail non remis",
      bodyText: "Bonjour, votre mail n'a pas pu être remis, pouvez-vous vérifier ?" }), "SAV_NOISE_WEAK_DAEMON_SENDER"],
    ["review 2: postmaster even with Auto-Submitted and wording", input({ fromEmail: "postmaster@client.example.invalid", headers: { ...parsed, "auto-submitted": "auto-generated" } }), "SAV_NOISE_WEAK_AUTO_GENERATED"],
    ["review 2: mailer-daemon with wording but no machine header", input({ headers: parsed }), "SAV_NOISE_WEAK_DAEMON_SENDER"],
    ["review 2: mailer-daemon with wording and Auto-Submitted: no", input({ headers: { ...parsed, "auto-submitted": "no" } }), "SAV_NOISE_WEAK_DAEMON_SENDER"],
    ["a real newsletter", input({ fromEmail: "news@lists.example.invalid", subject: "Lettre fictive", bodyText: "Nouveautés. Se désinscrire.", headers: newsletterHeaders }), "SAV_NOISE_WEAK_LIST_HEADERS"],
  ] as const)("%s → keep (weak, measured)", (_label, value, reason) => {
    const verdict = savIntakeNoiseVerdict(value);
    expect(verdict).toMatchObject({ verdict: "keep", reason, strength: "weak", guard: "SAV_NOISE_KEEP_WEAK_ONLY" });
    expect(JSON.parse(savIntakeNoiseLogLine("on", mid, verdict)).routed).toBe(false);
  });
  it("C: helpdesk auto-generated with Re: and In-Reply-To → keep (reply guard)", () => {
    const verdict = savIntakeNoiseVerdict(input({ fromEmail: "client@example.invalid", subject: "Re: Problème de connexion", bodyText: customerText,
      headers: { ...parsed, "auto-submitted": "auto-generated", "in-reply-to": "<x@example.invalid>" } }));
    expect(verdict).toMatchObject({ verdict: "keep", strength: "weak", guard: "SAV_NOISE_GUARD_SUPPORT_REPLY" });
  });
  it("records strong rules before weak ones", () => {
    expect(savIntakeNoiseSignals({ fromEmail: "mailer-daemon@example.invalid", subject: "Undeliverable", headers: { ...dsnHeaders, ...newsletterHeaders, "content-type": dsnHeaders["content-type"], "auto-submitted": "auto-generated" } }))
      .toEqual(["SAV_NOISE_DELIVERY_STATUS", "SAV_NOISE_MAILER_DAEMON", "SAV_NOISE_WEAK_LIST_HEADERS", "SAV_NOISE_WEAK_PRECEDENCE", "SAV_NOISE_WEAK_AUTO_GENERATED"]);
  });
  it.each([
    ["Auto-Submitted: no", { ...parsed, "auto-submitted": "no" }],
    ["noreply sender alone", parsed],
    ["repeated Auto-Submitted (ambiguous marker)", { ...parsed, "x-studio-automation-headers": "ambiguous", "auto-submitted": "auto-replied" }],
    ["DSN without the Gmail parser marker", { "content-type": dsnHeaders["content-type"] }],
    ["list headers without the capture marker", { "x-studio-automation-headers": "singleton-v1", "list-id": "x", "list-unsubscribe": "present", precedence: "bulk" }],
  ] as const)("no rule at all: %s", (_label, headers) => {
    expect(savIntakeNoiseVerdict(input({ headers, fromEmail: "noreply@example.invalid", subject: "Info", bodyText: "Texte." }))).toMatchObject({ verdict: "keep", reason: null, guard: "SAV_NOISE_KEEP_NO_SIGNAL" });
  });
  it("treats missing or malformed headers as no evidence", () => {
    for (const headers of [undefined, null, [] as unknown as Record<string, string>, { "auto-submitted": 1 } as unknown as Record<string, string>])
      expect(savIntakeNoiseVerdict(input({ headers, fromEmail: "x@example.invalid" })).guard).toBe("SAV_NOISE_KEEP_NO_SIGNAL");
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
    ["a forward", input({ subject: "TR: Undeliverable" }), "SAV_NOISE_GUARD_FORWARD"],
    ["a Reply-To elsewhere", input({ headers: { ...dsnHeaders, "x-studio-reply-to": "differs" } }), "SAV_NOISE_GUARD_REPLY_TO"],
    ["an attachment on a mailer-daemon mail without DSN", input({ headers: parsed, attachmentCount: 1 }), "SAV_NOISE_GUARD_ATTACHMENTS"],
    ["an attachment on an absence reply", input({ headers: absenceHeaders, fromEmail: "p@example.invalid", bodyText: "Je suis absent.", attachmentCount: 1 }), "SAV_NOISE_GUARD_ATTACHMENTS"],
    ["finance in a bounced mail", input({ bodyText: "Undeliverable: votre facture fictive" }), "SAV_NOISE_GUARD_SENSITIVE"],
    ["cancellation", input({ bodyText: "Undeliverable. Merci de résilier mon compte." }), "SAV_NOISE_GUARD_SENSITIVE"],
    ["English payment", input({ bodyText: "Undeliverable: your payment" }), "SAV_NOISE_GUARD_SENSITIVE"],
    ["a quoted human conversation", input({ bodyText: "Undeliverable.\nLe 3 nov., Client Fictif a écrit :\n> question" }), "SAV_NOISE_GUARD_FORM_OR_QUOTE"],
    ["an unreadable sender history", input({ senderHistory: null }), "SAV_NOISE_GUARD_SENDER_UNKNOWN"],
    ["an inconsistent sender history", input({ senderHistory: { ...fresh, priorInbound: 0, priorInboundNotAutomatic: 1 } }), "SAV_NOISE_GUARD_SENDER_UNKNOWN"],
    ["a prior inbound not proven automatic", input({ senderHistory: { ...fresh, priorInbound: 2, priorInboundNotAutomatic: 1 } }), "SAV_NOISE_GUARD_KNOWN_SENDER"],
    ["a sender the support wrote to", input({ senderHistory: { ...fresh, outboundTo: 1 } }), "SAV_NOISE_GUARD_KNOWN_SENDER"],
    ["a sender with a ticketed thread", input({ senderHistory: { ...fresh, ticketThreads: 1 } }), "SAV_NOISE_GUARD_KNOWN_SENDER"],
  ] as const)("keeps %s", (_label, value, guard) => {
    const verdict = savIntakeNoiseVerdict(value);
    expect(verdict.verdict).toBe("keep");
    expect(verdict.guard).toBe(guard);
    expect(verdict.reason).not.toBeNull();
  });
  it("a delivery-status report keeps its standard attachment (the original message)", () => {
    expect(savIntakeNoiseVerdict(input({ attachmentCount: 2 })).verdict).toBe("noise");
  });
  it("ignores prior mails proven automatic for a strong rule only", () => {
    const automaticHistory = { ...fresh, priorInbound: 3, priorInboundNotAutomatic: 0 };
    expect(savIntakeNoiseVerdict(input({ senderHistory: automaticHistory })).verdict).toBe("noise");
    expect(savIntakeNoiseVerdict(input({ senderHistory: automaticHistory, fromEmail: "news@lists.example.invalid", subject: "Lettre", bodyText: "Se désinscrire.", headers: newsletterHeaders })).guard).toBe("SAV_NOISE_GUARD_KNOWN_SENDER");
  });
  it("asks for the sender history only after every other guard passed", () => {
    expect(savIntakeNoiseVerdict(input({ senderHistory: undefined }))).toMatchObject({ verdict: "keep", guard: "SAV_NOISE_GUARD_SENDER_UNKNOWN", needsSenderHistory: true });
    expect(savIntakeNoiseVerdict(input({ senderHistory: undefined, subject: "Votre facture" })).needsSenderHistory).toBeUndefined();
  });
  it("closes every code list", () => {
    expect(new Set(SAV_INTAKE_NOISE_GUARDS).size).toBe(SAV_INTAKE_NOISE_GUARDS.length);
    expect(SAV_INTAKE_NOISE_REASONS).toHaveLength(9);
    expect(SAV_INTAKE_NOISE_STRONG_REASONS).toEqual(["SAV_NOISE_DELIVERY_STATUS", "SAV_NOISE_MAILER_DAEMON", "SAV_NOISE_AUTO_REPLIED"]);
  });
});

describe("SAV-92 observation output carries no personal data", () => {
  it("logs the message id and codes only", () => {
    const value = input({ fromEmail: "mailer-daemon@private.example.invalid", bodyText: "Undeliverable: secret texte privé" });
    const line = savIntakeNoiseLogLine("observe", mid, savIntakeNoiseVerdict(value));
    expect(JSON.parse(line)).toEqual({ event: "sav_intake_noise_filter", revision: "sav-intake-noise-filter.v2", mode: "observe", messageId: mid,
      verdict: "noise", reason: "SAV_NOISE_DELIVERY_STATUS", strength: "strong", guard: null, signals: ["SAV_NOISE_DELIVERY_STATUS", "SAV_NOISE_MAILER_DAEMON"], routed: false });
    expect(line).not.toMatch(/secret|private|privé|@/i);
    expect(JSON.parse(savIntakeNoiseLogLine("on", mid, savIntakeNoiseVerdict(value))).routed).toBe(true);
  });
  it("summarizes a replay per view, verdict, rule and guard", () => {
    const records = [
      { messageId: "a", view: "other", verdict: savIntakeNoiseVerdict(input()) },
      { messageId: "b", view: "to_validate", verdict: savIntakeNoiseVerdict(input({ headers: absenceHeaders, fromEmail: "p@example.invalid", subject: "Absence", bodyText: "Je suis absent." })) },
      { messageId: "c", view: "to_validate", verdict: savIntakeNoiseVerdict(input({ senderHistory: { ...fresh, priorInbound: 3, priorInboundNotAutomatic: 3 } })) },
      { messageId: "d", view: "to_validate", verdict: savIntakeNoiseVerdict(input({ fromEmail: "news@example.invalid", subject: "Lettre", bodyText: "Se désinscrire.", headers: newsletterHeaders })) },
      { messageId: "e", view: null, verdict: savIntakeNoiseVerdict(input({ headers: parsed, fromEmail: "client@example.invalid" })) },
    ];
    expect(summarizeSavIntakeNoiseReplay(records)).toEqual({ revision: "sav-intake-noise-filter.v2", total: 5,
      byView: { none: 1, other: 1, to_validate: 3 }, byVerdict: { keep: 3, noise: 2 },
      noiseByReason: { SAV_NOISE_AUTO_REPLIED: 1, SAV_NOISE_DELIVERY_STATUS: 1 }, noiseByView: { other: 1, to_validate: 1 },
      weakOnlyByReason: { SAV_NOISE_WEAK_LIST_HEADERS: 1 },
      keptWithSignalByGuard: { SAV_NOISE_GUARD_KNOWN_SENDER: 1 },
      signalCounts: { SAV_NOISE_DELIVERY_STATUS: 2, SAV_NOISE_MAILER_DAEMON: 2, SAV_NOISE_AUTO_REPLIED: 1, SAV_NOISE_WEAK_LIST_HEADERS: 1, SAV_NOISE_WEAK_PRECEDENCE: 1,
        SAV_NOISE_WEAK_AUTO_GENERATED: 0, SAV_NOISE_WEAK_AUTO_SUBMITTED_OTHER: 0, SAV_NOISE_WEAK_X_AUTOREPLY: 0, SAV_NOISE_WEAK_DAEMON_SENDER: 0 },
      noiseFromToValidate: ["b"] });
  });
});

describe("SAV-92 engine and contract: Autre without a model call", () => {
  const message = (over: Partial<IntakeMessage> = {}): IntakeMessage => ({ id: mid, threadId: tid, receivedAt: at, fromEmail: "mailer-daemon@mx.example.invalid",
    toEmails: ["support@example.invalid"], currentText: "Address not found.", contentComplete: true, direction: "inbound", ...over });
  const engineInput = (over: Partial<EngineInput> = {}, m = message()): EngineInput => ({ message: m, conversation: { status: "complete", data: [m], observedAt: at },
    latestInboundMessageId: mid, now: at, mode: "current", identificationAttemptId: mid, ...over });
  const base: EnginePolicy = { relationRevision: "synthetic-relation-v1", admittedRelations: [], resources: {} };
  const noise = { messageId: mid, sourceHash: "b".repeat(64), reason: "SAV_NOISE_DELIVERY_STATUS", signals: ["SAV_NOISE_DELIVERY_STATUS"], resource: { ...SAV_INTAKE_NOISE_RESOURCE } };

  it("routes a filtered mail to Autre with the noise proof and no read call", async () => {
    const plan = await planSavIntake(engineInput(), intakeAutomationAdapters(mid), { ...base, noiseFilter: noise }, { timeoutMs: 1000 });
    expect(plan.decision.classification).toBe("other");
    expect(plan.decision.disposition).toMatchObject({ kind: "no_ticket", reason: "qualified_other", qualifiedInformation: "automated_noise", nextAction: "none" });
    expect(plan.progress).toMatchObject({ kind: "qualified_other", view: "other", classificationRule: SAV_INTAKE_NOISE_RESOURCE });
    expect(plan.decision.evidence.map(e => e.source).sort()).toEqual(["automation_headers", "current_message"]);
    expect(plan.steps).toEqual([]);
    expect(plan.readCalls).toBe(0);
  });
  it("P2b: routes a report whose attached original leaves the content incomplete, instead of a vague wait", async () => {
    const m = message({ contentComplete: false });
    const plan = await planSavIntake(engineInput({}, m), intakeAutomationAdapters(mid), { ...base, noiseFilter: noise }, { timeoutMs: 1000 });
    expect(plan.progress).toMatchObject({ kind: "qualified_other", view: "other" });
    // Without the filter verdict, the same mail still waits for its content.
    const unfiltered = await planSavIntake(engineInput({}, m), intakeAutomationAdapters(mid), base, { timeoutMs: 1000 });
    expect(unfiltered.decision.disposition).toMatchObject({ kind: "collect_context", reasons: ["classification_incomplete"] });
  });
  it("lets a person's choice, an override, information or another message win", async () => {
    const adapters = intakeAutomationAdapters(mid);
    const other = message({ id: "40000000-0000-4000-8000-000000000009", receivedAt: "2026-11-15T09:00:00.000Z", direction: "outbound" });
    for (const [input, policy] of [
      [engineInput({ conversation: { status: "complete", data: [message(), other], observedAt: at } }), { ...base, noiseFilter: noise }],
      [engineInput({ conversation: { status: "partial", data: [message()], observedAt: at } }), { ...base, noiseFilter: noise }],
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
