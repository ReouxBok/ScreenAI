import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { planSavIntake } from "./engine";
import type { EngineInput, EnginePolicy, IntakeAdapters, IntakeContact, IntakeTicket, MessageAnalysis } from "./engine-types";
import {
  decideIntakeRouting, intakeRoutingAgrees, intakeRoutingPlanFacts, savIntakeRoutingWireSchema, savIntakeRoutingWireSchemaFor, savIntakeSafeArchiveRoutingWireSchema,
  type SavIntakeRoutingAnalysis, type SavIntakeRoutingFacts,
} from "./routing-rules";
import { savIntakeRoutingGuideline } from "./routing-guidelines";
import { intakeRuntimeConfigurationHash } from "./runtime-contract";
import { savIntakeNoiseVerdict, type SavIntakeNoiseInput } from "./noise-filter";
import {
  savIntakeDeliveryReport, savIntakeCustomerSignalAbsenceVerified, savIntakeMentionsProduct, savIntakeSafeArchiveFacts, savIntakeSafeArchiveRefusal, savIntakeSenderContact,
  savIntakeSupportDefaultApplies, savIntakeToValidatePolicy, type SavIntakeSafeArchiveFacts,
} from "./to-validate-rules";

// SAV-139 (Ugo 25/11): « À valider » rules. Fictional data only (@exemple.invalid).
const mid = "10000000-0000-4000-8000-000000000239", thread = "20000000-0000-4000-8000-000000000239";
const at = "2026-11-25T10:00:00.000Z", earlier = "2026-11-20T09:00:00.000Z";
const newsletter = "Black Friday : -40 % sur toutes nos formations en ligne. Pour ne plus recevoir nos offres, cliquez ici pour vous désinscrire.";

// ---------- Part 1 + 2: routing (pure rule) ----------
const model = (over: Partial<SavIntakeRoutingAnalysis> = {}): SavIntakeRoutingAnalysis => ({ class: "demarchage", confidence: "high", justification: "Offre promotionnelle.",
  customerSignal: false, customerSignalQuote: "Pour ne plus recevoir nos offres", ...over });
const collectPlan = { classification: "unknown", requestKinds: [] as string[], disposition: "collect_context", progress: "human_choice" };
const firstMail = { conversationLength: 1, ticketId: null, humanContext: false, quotedReply: false };
const safe = (over: Partial<SavIntakeSafeArchiveFacts> = {}): SavIntakeSafeArchiveFacts => ({ noRequest: true, sender: "none", productMention: false, customerSignalAbsenceVerified: true, ...over });
const route = (over: Partial<SavIntakeRoutingFacts> = {}) => decideIntakeRouting({ messageId: mid, model: model(), plan: collectPlan, thread: firstMail, safeArchive: safe(), ...over });

describe("SAV-139 safe archive of a mail without any request (routing rule)", () => {
  it("switch off (no safe-archive facts): exactly today's v1_collect_context, whatever the class", () => {
    for (const cls of ["demarchage", "notification_auto", "phishing", "lead_commercial"] as const)
      expect(decideIntakeRouting({ messageId: mid, model: model({ class: cls }), plan: collectPlan, thread: firstMail })).toMatchObject({ action: "keep", reason: "v1_collect_context" });
  });
  it.each(["demarchage", "notification_auto", "phishing"] as const)("archives a first %s mail when every server check passes", cls => {
    expect(route({ model: model({ class: cls }) })).toMatchObject({ action: "archive", recipient: null, reason: null, class: cls });
  });
  it("never forwards from collect_context: a lead or partnership class keeps today's path", () => {
    for (const cls of ["lead_commercial", "partenariat", "investisseur", "candidature"] as const) expect(route({ model: model({ class: cls }) })).toMatchObject({ action: "keep", reason: "v1_collect_context" });
  });
  it("keeps the mail at the slightest doubt", () => {
    const cases: [Partial<SavIntakeRoutingFacts>, string][] = [
      [{ safeArchive: safe({ sender: "known" }) }, "safe_archive_sender_known"],
      [{ safeArchive: safe({ sender: "unknown" }) }, "safe_archive_sender_unknown"],
      [{ safeArchive: safe({ productMention: true }) }, "safe_archive_product_mention"],
      [{ safeArchive: safe({ customerSignalAbsenceVerified: false }) }, "safe_archive_customer_signal"],
      [{ safeArchive: safe({ noRequest: false }) }, "v1_collect_context"],
      [{ model: model({ confidence: "medium" }) }, "confidence_medium"],
      [{ model: null }, "model_routing_missing"],
      [{ model: model({ class: "unknown" }) }, "v1_collect_context"],
      [{ thread: { ...firstMail, conversationLength: 2 } }, "thread_history"],
      [{ thread: { ...firstMail, ticketId: "301" } }, "thread_ticket"],
      [{ thread: { ...firstMail, quotedReply: true } }, "reply_to_team"],
      [{ thread: { ...firstMail, humanContext: true } }, "human_context"],
      [{ thread: { ...firstMail, v2Case: true } }, "v2_case"],
      [{ analysisWaiting: true }, "analysis_waiting"],
    ];
    for (const [over, reason] of cases) expect(route(over)).toMatchObject({ action: "keep", reason });
  });
  it("finance, cancellation and support are never archived, whatever the facts", () => {
    expect(route({ model: model({ class: "finance" }) })).toMatchObject({ action: "keep", reason: "sensitive_request" });
    expect(route({ plan: { ...collectPlan, requestKinds: ["cancellation"] } })).toMatchObject({ action: "keep", reason: "sensitive_request" });
    expect(route({ plan: { ...collectPlan, requestKinds: ["support"] } })).toMatchObject({ action: "keep", reason: "support_request" });
  });
  it("phishing agrees with an Other plan like the other archive classes", () => {
    expect(intakeRoutingAgrees("phishing", { classification: "other", requestKinds: ["other"], disposition: "no_ticket", progress: "qualified_other" })).toBe(true);
    expect(intakeRoutingAgrees("phishing", { classification: "commercial", requestKinds: ["commercial"], disposition: "no_ticket", progress: "supervised_action" })).toBe(false);
  });
});

describe("SAV-139 server checks behind the safe-archive facts", () => {
  it("accepts « no customer signal » only with an exact quote of the current text", () => {
    expect(savIntakeCustomerSignalAbsenceVerified(model(), newsletter)).toBe(true);
    expect(savIntakeCustomerSignalAbsenceVerified(model({ customerSignalQuote: "Pour ne plus recevoir nos promotions" }), newsletter)).toBe(false);
    expect(savIntakeCustomerSignalAbsenceVerified(model({ customerSignalQuote: undefined }), newsletter)).toBe(false);
    expect(savIntakeCustomerSignalAbsenceVerified(model({ customerSignalQuote: "ici" }), newsletter)).toBe(false);
    expect(savIntakeCustomerSignalAbsenceVerified(model({ customerSignal: true }), newsletter)).toBe(false);
    expect(savIntakeCustomerSignalAbsenceVerified(model({ customerSignal: undefined }), newsletter)).toBe(false);
  });
  it("the product's name in the text or the sender's address can only keep a mail (a phishing imitating Limova stays for the team)", () => {
    expect(savIntakeMentionsProduct("Votre compte LIMOVA sera suspendu, confirmez vos identifiants", "alerte@exemple.invalid")).toBe(true);
    expect(savIntakeMentionsProduct("Confirmez vos identifiants", "securite@limova-support.exemple.invalid")).toBe(true);
    expect(savIntakeMentionsProduct(newsletter, "news@exemple.invalid")).toBe(false);
    expect(savIntakeMentionsProduct("Cliquez ici pour délivrer votre email.", "filtre@exemple.invalid", "Re: LIMOVA - Merci pour votre message")).toBe(true);
  });
  it("sender: none only for a complete search without any contact", () => {
    expect(savIntakeSenderContact({ status: "complete", data: [] }, "a@exemple.invalid")).toBe("none");
    expect(savIntakeSenderContact({ status: "complete", data: [{ emails: ["A@exemple.invalid"] }] }, "a@exemple.invalid")).toBe("known");
    expect(savIntakeSenderContact({ status: "complete", data: [{ emails: ["b@exemple.invalid"] }] }, "a@exemple.invalid")).toBe("unknown");
    expect(savIntakeSenderContact({ status: "partial", data: [] }, "a@exemple.invalid")).toBe("unknown");
    expect(savIntakeSenderContact({ status: "failed", data: [] }, "a@exemple.invalid")).toBe("unknown");
  });
  it("facts: no request means collect_context asking only for the classification, with zero request or only « other »", () => {
    const plan = (kinds: string[], reasons = ["classification_incomplete"], kind = "collect_context") => ({ decision: { requests: kinds.map(k => ({ kind: k })), disposition: { kind, reasons } }, senderContact: "none" as const });
    const message = { currentText: newsletter, fromEmail: "news@exemple.invalid" };
    expect(savIntakeSafeArchiveFacts({ plan: plan([]), message, routing: model() })).toEqual(safe());
    expect(savIntakeSafeArchiveFacts({ plan: plan(["other"], ["other_rule_not_applicable", "classification_incomplete"]), message, routing: model() })?.noRequest).toBe(true);
    expect(savIntakeSafeArchiveFacts({ plan: plan(["unknown"]), message, routing: model() })?.noRequest).toBe(false);
    expect(savIntakeSafeArchiveFacts({ plan: plan([], ["history_incomplete"]), message, routing: model() })?.noRequest).toBe(false);
    expect(savIntakeSafeArchiveFacts({ plan: { decision: { requests: [], disposition: { kind: "collect_context", reasons: ["classification_incomplete"] } } }, message, routing: model() })?.sender).toBe("unknown");
    expect(savIntakeSafeArchiveFacts({ plan: null, message, routing: model() })).toBeNull();
  });
  it("review A4: a mail with an unread attachment is never archived", () => {
    const plan = { decision: { requests: [], disposition: { kind: "collect_context", reasons: ["classification_incomplete"] }, evidence: [{ id: "current", source: "current_message" }] }, senderContact: "none" as const };
    const unread = savIntakeSafeArchiveFacts({ plan, message: { currentText: newsletter, fromEmail: "news@exemple.invalid", unreadAttachments: [{ sourceId: "f1" }] }, routing: model() })!;
    expect(unread.unreadAttachment).toBe(true);
    expect(route({ safeArchive: unread })).toMatchObject({ action: "keep", reason: "safe_archive_unread_attachment" });
    const notAnalysed = savIntakeSafeArchiveFacts({ plan, message: { currentText: newsletter, fromEmail: "news@exemple.invalid", attachmentInputs: [{ sourceId: "f2" }] }, routing: model() })!;
    expect(route({ safeArchive: notAnalysed })).toMatchObject({ action: "keep", reason: "safe_archive_unread_attachment" });
    const analysed = savIntakeSafeArchiveFacts({ plan: { ...plan, decision: { ...plan.decision, evidence: [...plan.decision.evidence, { id: "f2", source: "current_attachment" }] } },
      message: { currentText: newsletter, fromEmail: "news@exemple.invalid", attachmentInputs: [{ sourceId: "f2" }] }, routing: model() })!;
    expect(route({ safeArchive: analysed })).toMatchObject({ action: "archive" });
  });
  it("refusal: absent facts are exactly today's reason", () => {
    expect(savIntakeSafeArchiveRefusal({ model: model() })).toBe("v1_collect_context");
    expect(savIntakeSafeArchiveRefusal({ model: model(), safeArchive: safe() })).toBeNull();
  });
});

describe("SAV-139 switches, prompt and launch configuration", () => {
  it("switches: only the exact value « on »; none set means no engine policy at all", () => {
    expect(savIntakeToValidatePolicy({})).toBeUndefined();
    expect(savIntakeToValidatePolicy({ SAV_INTAKE_SAFE_ARCHIVE: "true", SAV_INTAKE_SUPPORT_DEFAULT: "1", SAV_INTAKE_THREAD_ACK: "ON", SAV_INTAKE_THREAD_TICKET_LINK: "" })).toBeUndefined();
    expect(savIntakeToValidatePolicy({ SAV_INTAKE_SAFE_ARCHIVE: "on", SAV_INTAKE_ROUTING_MODE: "shadow" }, { threadTicketId: "301" })).toEqual({ senderLookup: true, threadTicketId: "301" });
    // Review A5: no HubSpot lookup while the routing (and so its field) is off.
    expect(savIntakeToValidatePolicy({ SAV_INTAKE_SAFE_ARCHIVE: "on" }, { threadTicketId: "301" })).toEqual({ threadTicketId: "301" });
    expect(savIntakeToValidatePolicy({ SAV_INTAKE_SUPPORT_DEFAULT: "on", SAV_INTAKE_ROUTING_MODE: "off" })).toEqual({ supportDefault: true, threadTicketId: null });
    expect(savIntakeToValidatePolicy({ SAV_INTAKE_TICKET_DECIDE: "on" })).toEqual({ ticketDecide: true, threadTicketId: null });
    expect(savIntakeToValidatePolicy({ SAV_INTAKE_THREAD_TICKET_LINK: "on" }, { threadTicketId: "x1" })).toEqual({ threadTicketLink: true, threadTicketId: null });
  });
  it("guideline and wire field: off unchanged; on adds phishing and the customer signal", () => {
    expect(savIntakeRoutingGuideline(false)).toBe(savIntakeRoutingGuideline());
    expect(savIntakeRoutingGuideline()).not.toMatch(/phishing|CUSTOMER SIGNAL/);
    expect(savIntakeRoutingGuideline(true)).toMatch(/- phishing:/);
    expect(savIntakeRoutingGuideline(true)).toMatch(/customerSignalQuote/);
    expect(savIntakeRoutingWireSchemaFor(false)).toBe(savIntakeRoutingWireSchema);
    expect(savIntakeRoutingWireSchema.safeParse(model({ class: "phishing" })).success).toBe(false);
    expect(savIntakeRoutingWireSchema.safeParse({ class: "demarchage", confidence: "high", justification: "x" }).success).toBe(true);
    expect(savIntakeRoutingWireSchemaFor(true)).toBe(savIntakeSafeArchiveRoutingWireSchema);
    expect(savIntakeSafeArchiveRoutingWireSchema.safeParse(model({ class: "phishing" })).success).toBe(true);
    expect(savIntakeSafeArchiveRoutingWireSchema.safeParse({ class: "demarchage", confidence: "high", justification: "x" }).success).toBe(false);
  });
  it("launch hash: the switch changes it only with routing on", () => {
    const pins = { mailboxId: "30000000-0000-4000-8000-000000000001", createdAfter: at, receivedAfter: at, expiresAt: "2026-11-26T10:00:00.000Z",
      codeRevision: "a".repeat(40), resourcesHash: "b".repeat(64), policyHash: "c".repeat(64), maxNanoUsd: 1000, maxCalls: 10 };
    const hash = (env: Record<string, string>) => intakeRuntimeConfigurationHash(pins, env);
    expect(hash({ SAV_INTAKE_SAFE_ARCHIVE: "on" })).toBe(hash({}));
    expect(hash({ SAV_INTAKE_ROUTING_MODE: "shadow", SAV_INTAKE_SUPPORT_DEFAULT: "on", SAV_INTAKE_THREAD_ACK: "on", SAV_INTAKE_THREAD_TICKET_LINK: "on" })).toBe(hash({ SAV_INTAKE_ROUTING_MODE: "shadow" }));
    expect(hash({ SAV_INTAKE_ROUTING_MODE: "shadow", SAV_INTAKE_SAFE_ARCHIVE: "on" })).not.toBe(hash({ SAV_INTAKE_ROUTING_MODE: "shadow" }));
  });
  it("support default: support class always; an unknown class only for a known contact; never a thanks, finance, cancellation, mixed or outside", () => {
    expect(savIntakeSupportDefaultApplies({ class: "support" }, "none")).toBe(true);
    expect(savIntakeSupportDefaultApplies({ class: "acknowledgement" }, "known", true)).toBe(false);
    expect(savIntakeSupportDefaultApplies({ class: "unknown" }, "known", true)).toBe(true);
    // Review A2: only for a first mail of a thread without a ticket.
    expect(savIntakeSupportDefaultApplies({ class: "unknown" }, "known", false)).toBe(false);
    expect(savIntakeSupportDefaultApplies({ class: "support" }, "none", false)).toBe(true);
    expect(savIntakeSupportDefaultApplies({ class: "acknowledgement" }, "none")).toBe(false);
    expect(savIntakeSupportDefaultApplies({ class: "unknown" }, "unknown")).toBe(false);
    for (const cls of ["finance", "cancellation", "mixed", "lead_commercial", "partenariat", "demarchage", "notification_auto", "phishing"] as const)
      expect(savIntakeSupportDefaultApplies({ class: cls }, "known")).toBe(false);
    expect(savIntakeSupportDefaultApplies(null, "known")).toBe(false);
  });
});

// ---------- Engine: parts 1, 3, 4, 5 ----------
const sender = "client@exemple.invalid";
const ok = <T>(data: T) => ({ status: "complete" as const, data, observedAt: at });
const contact = (id = "101", email = sender): IntakeContact => ({ id, emails: [email] });
const ticket = (id: string, stage: IntakeTicket["stage"] = "open", contactIds = ["101"]): IntakeTicket => ({ id, contactIds, stage, createdAt: earlier, subject: `Sujet ${id}`, content: "Contenu fictif.", ownerId: null });
const warning = "Plusieurs tickets ouverts pour ce contact.";
const policyBase = (): EnginePolicy => ({ relationRevision: "fixture-239", admittedRelations: [], resources: {
  identification: { resourceId: "id-template", revisionId: "r1", sha256: "d".repeat(64) },
  multiTicketWarning: { resourceId: "warning", revisionId: "r1", sha256: createHash("sha256").update(warning).digest("hex"), text: warning } } });
type Fixture = { text: string; analysis: MessageAnalysis; contacts: IntakeContact[]; tickets: IntakeTicket[]; relations?: Record<string, "same" | "different" | "partial" | "unknown">;
  conversation?: EngineInput["conversation"]["data"]; policy?: Partial<EnginePolicy>; unreadAttachments?: { sourceId: string; reason: "unsupported_type" }[] };
function engine(f: Fixture) {
  const message = { id: mid, threadId: thread, receivedAt: at, fromEmail: sender, toEmails: ["contact@exemple.invalid"], direction: "inbound" as const, currentText: f.text, contentComplete: true,
    ...(f.unreadAttachments ? { unreadAttachments: f.unreadAttachments } : {}) };
  const lookups = vi.fn(async () => ok(f.contacts));
  const adapters: IntakeAdapters = {
    analyseMessage: async () => structuredClone(f.analysis),
    findContactsByEmail: lookups,
    directAssociations: async () => ok([]),
    getContact: async id => ok(contact(id)),
    ticketsForContact: async () => ok(f.tickets),
    ticketHistory: async () => ok([]),
    assessIssues: async () => ({ investigationComplete: !Object.values(f.relations ?? {}).some(r => r === "unknown"), tickets: f.tickets.map(t => ({ ticketId: t.id,
      relation: f.relations?.[t.id] ?? "same", requestIds: f.relations?.[t.id] === "different" ? [] : f.analysis.requests.map(r => r.id),
      evidenceIds: ["current", `ticket-${t.id}`, `history-${t.id}`] })) }),
  };
  const input: EngineInput = { message, latestInboundMessageId: mid, conversation: { status: "complete", data: f.conversation ?? [message], observedAt: at }, now: at, mode: "current", identificationAttemptId: "attempt-239" };
  return { lookups, run: () => planSavIntake(input, adapters, { ...policyBase(), ...f.policy }) };
}
const analysis = (kind: string | null, routing?: Partial<SavIntakeRoutingAnalysis>, nature: MessageAnalysis["nature"] = "request"): MessageAnalysis => ({
  messageId: mid, nature, requests: kind ? [{ id: "r0", kind: kind as MessageAnalysis["requests"][number]["kind"], currentMessageId: mid }] : [],
  ...(kind && kind !== "acknowledgement" ? { ticketSummary: { title: "Demande client", description: "Description fictive.", requestIds: ["r0"] } } : {}),
  ...(routing ? { routing: { class: "support", confidence: "high", justification: "x", ...routing } as SavIntakeRoutingAnalysis } : {}) });

describe("SAV-139 engine: sender lookup for a mail without any request (part 1)", () => {
  it("off: no lookup and no senderContact (today's plan)", async () => {
    const e = engine({ text: newsletter, analysis: analysis(null, { class: "demarchage" }, "information"), contacts: [], tickets: [] });
    const plan = await e.run();
    expect(plan.decision.disposition).toMatchObject({ kind: "collect_context", reasons: ["classification_incomplete"] });
    expect(plan.senderContact).toBeUndefined(); expect(e.lookups).not.toHaveBeenCalled();
  });
  it("on: the plan carries the sender's HubSpot answer, the decision itself is unchanged", async () => {
    for (const [contacts, expected] of [[[], "none"], [[contact()], "known"]] as const) {
      const e = engine({ text: newsletter, analysis: analysis(null, { class: "demarchage" }, "information"), contacts: [...contacts], tickets: [], policy: { toValidate: { senderLookup: true } } });
      const plan = await e.run();
      expect(plan.senderContact).toBe(expected);
      expect(plan.decision.disposition).toMatchObject({ kind: "collect_context", reasons: ["classification_incomplete"] });
    }
  });
});

describe("SAV-139 engine: thanks in a known thread (part 3)", () => {
  const thanks = (policy: Partial<EnginePolicy>, text = "ok merci, cela semble bon") =>
    engine({ text, analysis: analysis("acknowledgement", { class: "acknowledgement" }), contacts: [contact()], tickets: [ticket("301")], policy }).run();
  it("off: a thanks the model called a request waits for the team (today)", async () => {
    expect((await thanks({ acknowledgementTicket: { ticketId: "301" } })).decision.disposition).toMatchObject({ kind: "collect_context" });
  });
  it("on, thread ticket: goes into the thread's ticket as an acknowledgement", async () => {
    const plan = await thanks({ acknowledgementTicket: { ticketId: "301" }, toValidate: { threadAck: true, threadTicketId: "301" } });
    expect(plan.decision.classification).toBe("acknowledgement");
    expect(plan.decision.disposition).toMatchObject({ kind: "ticket", target: { operation: "link", ticketId: "301" }, note: { kind: "acknowledgement_summary" } });
  });
  it("on, V2 case on the thread: acknowledgement only (V2's relay), never « À valider »", async () => {
    const plan = await thanks({ toValidate: { threadAck: true, threadV2Case: true } });
    expect(plan.decision.disposition).toMatchObject({ kind: "no_ticket", reason: "acknowledgement_only" });
  });
  it("review A1: admitted for the thread's ticket but not attachable to it: back to the team, never closed as a thanks", async () => {
    const policy = { acknowledgementTicket: { ticketId: "301" }, toValidate: { threadAck: true as const, threadTicketId: "301" } };
    const notOnContact = await engine({ text: "ok merci", analysis: analysis("acknowledgement", { class: "acknowledgement" }), contacts: [contact()], tickets: [ticket("302")], policy }).run();
    expect(notOnContact.decision.disposition).toMatchObject({ kind: "collect_context", reasons: ["classification_incomplete"] });
    expect(notOnContact.progress).toMatchObject({ kind: "human_choice", questionCode: "request_scope_uncertain" });
    expect(notOnContact.acknowledgementTicket).toEqual({ outcome: "not_attached", reason: "thread_ticket_not_on_contact" });
    for (const contacts of [[], [contact("101"), contact("102")]]) {
      const plan = await engine({ text: "ok merci", analysis: analysis("acknowledgement", { class: "acknowledgement" }), contacts, tickets: [ticket("301")], policy }).run();
      expect(plan.decision.disposition).toMatchObject({ kind: "collect_context", reasons: ["classification_incomplete"] });
    }
    // Without the switch, the same refusal keeps today's acknowledgement path (SAV-128, nature not « request »).
    const today = await engine({ text: "ok merci", analysis: analysis("acknowledgement", { class: "acknowledgement" }, "information"), contacts: [contact()], tickets: [ticket("302")],
      policy: { acknowledgementTicket: { ticketId: "301" } } }).run();
    expect(today.decision.disposition).toMatchObject({ kind: "no_ticket", reason: "acknowledgement_only" });
  });
  it("on, but a written request marker: never treated as a thanks", async () => {
    const plan = await thanks({ acknowledgementTicket: { ticketId: "301" }, toValidate: { threadAck: true, threadTicketId: "301" } }, "merci mais ça ne marche toujours pas, pouvez-vous regarder ?");
    expect(plan.decision.disposition).toMatchObject({ kind: "collect_context" });
  });
  it("trap: « ok merci » outside any known thread is not a thread acknowledgement", async () => {
    expect((await thanks({ toValidate: { threadAck: true, threadTicketId: null } })).decision.disposition).toMatchObject({ kind: "collect_context" });
  });
});

describe("SAV-139 engine: « Quelle demande ? » on a real customer mail (part 4)", () => {
  const unknownMail = (routing: Partial<SavIntakeRoutingAnalysis> | undefined, contacts: IntakeContact[], policy: Partial<EnginePolicy> = { toValidate: { supportDefault: true, senderLookup: true } }, kind = "unknown", text = "Bonjour, c'est encore bloqué.") =>
    engine({ text, analysis: analysis(kind, routing), contacts, tickets: [], policy }).run();
  it("off: today's question to the team", async () => {
    expect((await unknownMail({ class: "support" }, [contact()], {})).decision.disposition).toMatchObject({ kind: "collect_context", reasons: ["classification_incomplete"] });
  });
  it("routing class support: support ticket for the known contact", async () => {
    const plan = await unknownMail({ class: "support" }, [contact()]);
    expect(plan.decision.classification).toBe("support");
    expect(plan.decision.disposition).toMatchObject({ kind: "ticket", target: { operation: "create", contactId: "101" } });
  });
  it("trap (review A2): a known client's short reply « Re: et donc ? » in an existing exchange stays with the team, never archived", async () => {
    const prior = { id: "10000000-0000-4000-8000-000000000238", threadId: thread, receivedAt: "2026-11-24T10:00:00.000Z", fromEmail: "contact@exemple.invalid", toEmails: [sender],
      direction: "outbound" as const, currentText: "Bonjour, pouvez-vous préciser ?", contentComplete: true };
    const message = { id: mid, threadId: thread, receivedAt: at, fromEmail: sender, toEmails: ["contact@exemple.invalid"], direction: "inbound" as const, currentText: "Re: et donc ?", contentComplete: true };
    const plan = await engine({ text: "Re: et donc ?", analysis: analysis("unknown", { class: "unknown", confidence: "low" }), contacts: [contact()], tickets: [],
      conversation: [prior, message], policy: { toValidate: { supportDefault: true, senderLookup: true } } }).run();
    expect(plan.decision.disposition).toMatchObject({ kind: "collect_context", reasons: ["classification_incomplete"] });
    const withTicket = await unknownMail({ class: "unknown" }, [contact()], { toValidate: { supportDefault: true, senderLookup: true, threadTicketId: "301" } });
    expect(withTicket.decision.disposition.kind).toBe("collect_context");
  });
  it("a known client's first mail of a thread, class unknown, goes to support", async () => {
    const plan = await unknownMail({ class: "unknown", confidence: "low" }, [contact()], undefined, "unknown", "Bonjour, je reviens vers vous.");
    expect(plan.decision.classification).toBe("support");
    expect(plan.decision.disposition.kind).toBe("ticket");
  });
  it("trap: a known client answering « ok merci » outside any thread stays with the team: never archived, never a support ticket", async () => {
    const plan = await engine({ text: "ok merci", analysis: analysis("acknowledgement", { class: "acknowledgement" }), contacts: [contact()], tickets: [],
      policy: { toValidate: { supportDefault: true, senderLookup: true, threadAck: true, threadTicketId: null } } }).run();
    expect(plan.decision.disposition).toMatchObject({ kind: "collect_context", reasons: ["classification_incomplete"] });
    expect(decideIntakeRouting({ messageId: mid, model: model({ class: "acknowledgement" }), plan: intakeRoutingPlanFacts(plan), thread: firstMail,
      safeArchive: savIntakeSafeArchiveFacts({ plan, message: { currentText: "ok merci", fromEmail: sender }, routing: model({ class: "acknowledgement" }) })! })).toMatchObject({ action: "keep" });
  });
  it("a known client's mail the routing calls support, with an unclear request, gets the fallback ticket title", async () => {
    const plan = await engine({ text: "Bonjour, toujours pareil.", analysis: analysis(null, { class: "support" }, "information"), contacts: [contact()], tickets: [],
      policy: { toValidate: { supportDefault: true, senderLookup: true } } }).run();
    expect(plan.decision.disposition).toMatchObject({ kind: "ticket", target: { operation: "create" } });
    expect(plan.newTicket?.title).toBe("Message client à qualifier");
  });
  it("an unknown sender with an unknown class keeps today's question", async () => {
    expect((await unknownMail({ class: "unknown" }, [])).decision.disposition.kind).toBe("collect_context");
  });
  it.each(["finance", "cancellation", "mixed", "lead_commercial"] as const)("routing class %s: no relaxation, today's question", async cls => {
    expect((await unknownMail({ class: cls }, [contact()])).decision.disposition).toMatchObject({ kind: "collect_context", reasons: ["classification_incomplete"] });
  });
  it.each(["finance", "cancellation"] as const)("a %s request detected by V1 is unchanged by every switch", async kind => {
    const all = { toValidate: { supportDefault: true as const, senderLookup: true as const, threadAck: true as const, threadTicketLink: true as const, threadTicketId: null } };
    const on = await unknownMail({ class: "support" }, [contact()], all, kind), off = await unknownMail({ class: "support" }, [contact()], {}, kind);
    expect(on.decision.classification).toBe(kind);
    expect(on.decision).toEqual(off.decision);
  });
  it("without a routing field (routing off), no default", async () => {
    expect((await unknownMail(undefined, [contact()])).decision.disposition.kind).toBe("collect_context");
  });
});

describe("SAV-139 engine: « Déjà couvert ? lequel ? » answered by the thread's ticket (part 5)", () => {
  const two = (policy: Partial<EnginePolicy>, relations: Record<string, "same" | "different" | "partial" | "unknown"> = { "301": "partial", "302": "partial" }) =>
    engine({ text: "Toujours le même souci de connexion.", analysis: analysis("support", { class: "support" }), contacts: [contact()], tickets: [ticket("301"), ticket("302")], relations, policy }).run();
  it("off: two plausible open tickets ask the team (today)", async () => {
    expect((await two({})).progress).toMatchObject({ kind: "human_choice", questionCode: "equivalent_ticket_choice" });
  });
  it("on, the mail is in the thread of ticket 302: linked to 302", async () => {
    const plan = await two({ toValidate: { threadTicketLink: true, threadTicketId: "302" } });
    expect(plan.decision.disposition).toMatchObject({ kind: "ticket", target: { operation: "link", ticketId: "302" } });
    expect(plan.decision.evidence.some(e => e.id === "thread-ticket" && e.sourceId === "302")).toBe(true);
  });
  it("on, two open tickets both « same »: the thread's ticket wins", async () => {
    expect((await two({ toValidate: { threadTicketLink: true, threadTicketId: "301" } }, { "301": "same", "302": "same" })).decision.disposition).toMatchObject({ target: { ticketId: "301" } });
  });
  it("on, without a thread ticket: the choice stays for the team", async () => {
    expect((await two({ toValidate: { threadTicketLink: true, threadTicketId: null } })).progress).toMatchObject({ kind: "human_choice" });
  });
  it("on, the thread's ticket is closed or belongs to another contact: the choice stays", async () => {
    const closed = await engine({ text: "Toujours le même souci.", analysis: analysis("support", { class: "support" }), contacts: [contact()],
      tickets: [ticket("301"), ticket("302"), ticket("303", "closed")], relations: { "301": "partial", "302": "partial", "303": "partial" },
      policy: { toValidate: { threadTicketLink: true, threadTicketId: "303" } } }).run();
    expect(closed.decision.disposition.kind).toBe("collect_context");
    expect((await two({ toValidate: { threadTicketLink: true, threadTicketId: "999" } })).decision.disposition.kind).toBe("collect_context");
  });
  it("review A3: never links to the thread's ticket when the model judged it different", async () => {
    const plan = await two({ toValidate: { threadTicketLink: true, threadTicketId: "302" } }, { "301": "partial", "302": "different" });
    expect(plan.decision.disposition.kind).toBe("collect_context");
    expect(plan.decision.evidence.some(e => e.id === "thread-ticket")).toBe(false);
  });
  it("review A3: finance and cancellation are never linked by the thread rule", async () => {
    for (const kind of ["finance", "cancellation"] as const) {
      const on = await engine({ text: "Question sur ma facture.", analysis: analysis(kind, { class: kind }), contacts: [contact()], tickets: [ticket("301"), ticket("302")],
        relations: { "301": "partial", "302": "partial" }, policy: { toValidate: { threadTicketLink: true, threadTicketId: "302" } } }).run();
      const off = await engine({ text: "Question sur ma facture.", analysis: analysis(kind, { class: kind }), contacts: [contact()], tickets: [ticket("301"), ticket("302")],
        relations: { "301": "partial", "302": "partial" } }).run();
      expect(on.decision).toEqual(off.decision);
      expect(on.decision.evidence.some(e => e.id === "thread-ticket")).toBe(false);
    }
  });
  it("on, an already decided comparison is not overridden", async () => {
    expect((await two({ toValidate: { threadTicketLink: true, threadTicketId: "302" } }, { "301": "same", "302": "different" })).decision.disposition).toMatchObject({ target: { ticketId: "301" } });
  });
});

// ---------- Review 2 D: delivery reports (bounces), archived through SAV-92's verdict only ----------
describe("SAV-139 delivery report archive", () => {
  const bounceText = "Message non distribué. L'adresse equipe@limova.ai n'a pas pu remettre votre message : adresse introuvable.";
  const noiseInput = (over: Partial<SavIntakeNoiseInput> = {}): SavIntakeNoiseInput => ({ messageId: mid, direction: "inbound", fromEmail: "mailer-daemon@exemple.invalid",
    subject: "Delivery Status Notification (Failure)", bodyText: bounceText, attachmentCount: 1,
    headers: { "x-studio-automation-headers": "singleton-v1", "content-type": "multipart/report; report-type=delivery-status; boundary=x" },
    context: { conversationLength: 1, threadTicketId: null, humanContext: false, quotedMailboxReply: false },
    senderHistory: { priorInbound: 0, priorInboundNotAutomatic: 0, outboundTo: 0, ticketThreads: 0 }, ...over });
  const stored = (verdict: ReturnType<typeof savIntakeNoiseVerdict>, messageId = mid) => ({ ...verdict, mode: "observe" as const, messageId, routed: false });
  const bouncePlan = { decision: { requests: [], disposition: { kind: "collect_context", reasons: ["history_incomplete", "classification_incomplete"] }, evidence: [{ id: "current", source: "current_message" }] },
    senderContact: "none" as const };
  const bounceModel = model({ class: "notification_auto", customerSignal: false, customerSignalQuote: "n'a pas pu remettre votre message" });
  const facts = (deliveryReport: boolean) => savIntakeSafeArchiveFacts({ plan: bouncePlan, deliveryReport, routing: bounceModel,
    message: { currentText: bounceText, fromEmail: "mailer-daemon@exemple.invalid", subject: "Delivery Status Notification (Failure)", unreadAttachments: [{ sourceId: "f1" }] } })!;
  it("an isolated bounce is archived (returned copy unread, our own address in the text)", () => {
    const report = savIntakeDeliveryReport(stored(savIntakeNoiseVerdict(noiseInput())), mid);
    expect(report).toBe(true);
    const f = facts(report);
    expect(f).toMatchObject({ noRequest: true, unreadAttachment: true, deliveryReport: true, productMention: true, productMentionAddressOnly: true });
    expect(decideIntakeRouting({ messageId: mid, model: bounceModel, plan: collectPlan, thread: firstMail, safeArchive: f })).toMatchObject({ action: "archive", class: "notification_auto" });
  });
  it("a bounce in a customer's thread stays visible", () => {
    const inThread = savIntakeNoiseVerdict(noiseInput({ context: { conversationLength: 3, threadTicketId: null, humanContext: false, quotedMailboxReply: false } }));
    expect(savIntakeDeliveryReport(stored(inThread), mid)).toBe(false);
    // Even with the report fact, the routing's own first-mail check keeps it.
    expect(decideIntakeRouting({ messageId: mid, model: bounceModel, plan: collectPlan, thread: { ...firstMail, conversationLength: 3 }, safeArchive: facts(true) }))
      .toMatchObject({ action: "keep", reason: "thread_history" });
  });
  it("a mailer-daemon without a report header is kept (the sender's name alone proves nothing)", () => {
    const noHeader = savIntakeNoiseVerdict(noiseInput({ headers: {} }));
    expect(noHeader.verdict).toBe("keep");
    const report = savIntakeDeliveryReport(stored(noHeader), mid);
    expect(report).toBe(false);
    expect(decideIntakeRouting({ messageId: mid, model: bounceModel, plan: collectPlan, thread: firstMail, safeArchive: facts(report) })).toMatchObject({ action: "keep" });
  });
  it("engine: a mail without request whose file stays unread still carries the sender's answer (switch on only)", async () => {
    const base = { text: bounceText, analysis: analysis(null, { class: "notification_auto" }, "information"), contacts: [], tickets: [], unreadAttachments: [{ sourceId: "f1", reason: "unsupported_type" as const }] };
    const on = engine({ ...base, policy: { toValidate: { senderLookup: true } } });
    const plan = await on.run();
    expect(plan.decision.disposition).toMatchObject({ kind: "collect_context", reasons: ["history_incomplete", "classification_incomplete"] });
    expect(plan.senderContact).toBe("none");
    const off = engine(base);
    expect((await off.run()).senderContact).toBeUndefined();
    expect(off.lookups).not.toHaveBeenCalled();
  });
  it("the report fact lifts nothing else: another message's verdict, another class, a Limova mention outside our addresses, a known sender", () => {
    expect(savIntakeDeliveryReport(stored(savIntakeNoiseVerdict(noiseInput()), "10000000-0000-4000-8000-000000000999"), mid)).toBe(false);
    expect(decideIntakeRouting({ messageId: mid, model: model({ class: "demarchage" }), plan: collectPlan, thread: firstMail, safeArchive: facts(true) })).toMatchObject({ action: "keep" });
    const named = savIntakeSafeArchiveFacts({ plan: bouncePlan, deliveryReport: true, routing: bounceModel,
      message: { currentText: `${bounceText} Votre compte Limova est suspendu.`, fromEmail: "mailer-daemon@exemple.invalid", unreadAttachments: [{ sourceId: "f1" }] } })!;
    expect(decideIntakeRouting({ messageId: mid, model: bounceModel, plan: collectPlan, thread: firstMail, safeArchive: named })).toMatchObject({ action: "keep", reason: "safe_archive_product_mention" });
    expect(decideIntakeRouting({ messageId: mid, model: bounceModel, plan: collectPlan, thread: firstMail, safeArchive: { ...facts(true), sender: "known" } })).toMatchObject({ action: "keep" });
    // Without the report, an incomplete history is never a mail « without request ».
    expect(facts(false).noRequest).toBe(false);
  });
});
