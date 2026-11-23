// V1 routing (23/11): the live effect with an in-memory store and a fake Gmail. Shadow and off do nothing; live forwards once (idempotent, never a second
// send after a dispatch, proven by the send response id first), carries the original mail and its attachments, archives demarchage/automatic mails, and
// refuses as soon as a fact changed or V1 disagrees. Synthetic.
import { describe, expect, it } from "vitest";
import { buildIntakeRoutingForward, INTAKE_ROUTING_MAX_ATTEMPTS, INTAKE_ROUTING_MAX_ORIGINAL_BYTES, intakeRoutingRfcMessageId, routeIntakeMessage, type IntakeRoutingDeps,
  type IntakeRoutingLiveFacts, type IntakeRoutingMetadata, type IntakeRoutingStep } from "./routing-effect";
import { decideIntakeRouting, type SavIntakeRoutingClass, type SavIntakeRoutingFacts } from "./routing-rules";

const MID = "60000000-0000-4000-8000-000000000001";
// The V1 plan that agrees with each class (review #347: no routing without agreement).
const agreeingPlan = (cls: SavIntakeRoutingClass): SavIntakeRoutingFacts["plan"] => {
  const classification = cls === "lead_commercial" ? "commercial" : cls === "partenariat" ? "partnership" : cls === "investisseur" ? "investor" : cls === "support" ? "support" : "other";
  return { classification, requestKinds: [classification], disposition: "no_ticket", progress: "supervised_action" };
};
const ORIGINAL = Buffer.from([
  "From: prospect@example.test", "Subject: Candidature", 'Content-Type: multipart/mixed; boundary="orig"', "", "--orig", "Content-Type: text/plain", "", "Bonjour",
  "--orig", 'Content-Type: application/pdf; name="cv.pdf"', "Content-Transfer-Encoding: base64", "", "JVBERi0xLjQK", "--orig--", ""].join("\r\n"));
const ruleFacts = (cls: SavIntakeRoutingClass, plan?: SavIntakeRoutingFacts["plan"]): SavIntakeRoutingFacts => ({ messageId: MID,
  model: { class: cls, confidence: "high", justification: "Fait." }, plan: plan ?? agreeingPlan(cls),
  thread: { conversationLength: 1, ticketId: null, humanContext: false, quotedReply: false } });
function live(cls: SavIntakeRoutingClass, over: { thread?: Partial<SavIntakeRoutingFacts["thread"]>; mode?: string; plan?: SavIntakeRoutingFacts["plan"] } = {}): IntakeRoutingLiveFacts {
  const analysed = ruleFacts(cls, over.plan);
  const stored = { ...decideIntakeRouting(analysed), mode: over.mode ?? "live" };
  return { stored, facts: { ...analysed, thread: { ...analysed.thread, ...over.thread } },
    source: { mailboxEmail: "contact@limova.ai", gmailMessageId: "abc123", gmailThreadId: "def456", fromEmail: "prospect@example.test", subject: "Demande de tarif",
      receivedAt: "2026-11-23T08:00:00.000Z", text: "Bonjour, quel est le prix pour 3 utilisateurs ?" } };
}
type BenchOptions = { mode?: string; sent?: "found" | "missing"; sendThrows?: boolean; authority?: () => Promise<void>; archived?: boolean;
  ackId?: string | null; byIdHeader?: "ours" | "other" | "missing" | "throws"; original?: Buffer; originalThrows?: string };
function bench(facts: IntakeRoutingLiveFacts | null, options: BenchOptions = {}) {
  const steps = new Map<IntakeRoutingStep, IntakeRoutingMetadata>(); let attempts = 0;
  const calls = { send: [] as string[], readOriginal: 0, sentMessageId: [] as string[], findSent: 0, archive: 0 };
  let delivered = false;
  const deps: IntakeRoutingDeps = {
    env: () => ({ SAV_INTAKE_ROUTING_MODE: options.mode ?? "live" }),
    authority: options.authority ?? (async () => undefined),
    readFacts: async () => facts,
    store: {
      steps: async () => [...steps.keys()],
      record: async (_id, step, metadata) => { if (steps.has(step)) return false; steps.set(step, metadata); return true; },
      receipt: async (_id, step) => steps.get(step) ?? null,
      lease: async () => async () => undefined,
      attempt: async () => ++attempts,
    },
    gmail: {
      readOriginal: async (mailbox, id) => { calls.readOriginal++; expect([mailbox, id]).toEqual(["contact@limova.ai", "abc123"]);
        if (options.originalThrows) throw Error(options.originalThrows); return options.original ?? ORIGINAL; },
      send: async (_mailbox, raw) => { calls.send.push(raw.toString("utf8")); delivered = true; if (options.sendThrows) throw Error("GMAIL_HTTP_500");
        return { id: options.ackId === undefined ? "a1b2c3" : options.ackId as string, threadId: "t1" }; },
      sentMessageId: async (_mailbox, id) => { calls.sentMessageId.push(id);
        if (options.byIdHeader === "throws") throw Error("GMAIL_HTTP_500");
        return options.byIdHeader === "missing" ? null : options.byIdHeader === "other" ? "<someone-else@example.test>" : intakeRoutingRfcMessageId(MID); },
      findSent: async (_mailbox, rfc) => { calls.findSent++; expect(rfc).toBe(intakeRoutingRfcMessageId(MID));
        return options.sent === "missing" ? null : options.sent === "found" || delivered ? "sent1" : null; },
      archive: async () => { calls.archive++; return options.archived ?? true; },
    },
  };
  return { deps, steps, calls, run: () => routeIntakeMessage(MID, deps) };
}
const NO_CALLS = { send: [], readOriginal: 0, sentMessageId: [], findSent: 0, archive: 0 };

describe("off and shadow perform no effect", () => {
  it.each([undefined, "shadow", "on"])("mode %s: no read, no Gmail call, no receipt", async mode => {
    const b = bench(live("lead_commercial"), { mode: mode ?? "" });
    expect(await b.run()).toEqual({ skipped: "off" });
    expect(b.calls).toEqual(NO_CALLS);
    expect(b.steps.size).toBe(0);
  });
  it("a decision recorded in shadow is never executed by live", async () => {
    const b = bench(live("lead_commercial", { mode: "shadow" }));
    expect(await b.run()).toMatchObject({ final: "not_applied" });
    expect(b.calls.send).toHaveLength(0);
  });
  it("without the route_intake_mail right (or paused) nothing happens", async () => {
    const b = bench(live("lead_commercial"), { authority: async () => { throw Error("SAV_INTAKE_ROUTING_PERMISSION_MISSING"); } });
    expect(await b.run()).toEqual({ skipped: "authority", detail: "SAV_INTAKE_ROUTING_PERMISSION_MISSING" });
    expect(b.calls.send).toHaveLength(0);
  });
});

describe("live forward: once, idempotent, proven by the send response id", () => {
  it("forwards a lead to sacha once, proves it by the send response id, then closes", async () => {
    const b = bench(live("lead_commercial"));
    expect(await b.run()).toEqual({ final: "confirmed" });
    expect(b.calls.send).toHaveLength(1);
    expect(b.calls.send[0]).toContain("To: sacha@limova.ai");
    expect(b.calls.send[0]).toContain("From: contact@limova.ai");
    expect(b.calls.send[0]).not.toContain("prospect@example.test\r\nTo");
    expect([...b.steps.keys()]).toEqual(["claimed", "forward_dispatched", "forward_acked", "forward_confirmed", "confirmed"]);
    expect(b.steps.get("forward_acked")).toMatchObject({ gmailMessageId: "a1b2c3" });
    expect(b.steps.get("forward_confirmed")).toMatchObject({ gmailMessageId: "a1b2c3", proof: "send_response_id" });
    expect(b.calls.sentMessageId).toEqual(["a1b2c3"]);
    expect(b.calls.findSent).toBe(0);
    expect(await b.run()).toEqual({ skipped: "already_done" });
    expect(b.calls.send).toHaveLength(1);
  });
  it("partenariat goes to nathan", async () => {
    const b = bench(live("partenariat"));
    await b.run();
    expect(b.calls.send[0]).toContain("To: nathan@limova.ai");
  });
  it("an unknown send outcome is confirmed by the Message-ID read-back, never re-sent", async () => {
    const b = bench(live("candidature"), { sendThrows: true });
    expect(await b.run()).toEqual({ final: "confirmed" });
    expect(b.calls.send).toHaveLength(1);
    expect(b.steps.get("forward_confirmed")).toMatchObject({ gmailMessageId: "sent1", proof: "message_id_header" });
  });
  it("no usable send id: the Message-ID lookup is the fallback proof", async () => {
    const b = bench(live("lead_commercial"), { ackId: null });
    expect(await b.run()).toEqual({ final: "confirmed" });
    expect(b.steps.has("forward_acked")).toBe(false);
    expect(b.calls.sentMessageId).toEqual([]);
    expect(b.steps.get("forward_confirmed")).toMatchObject({ gmailMessageId: "sent1", proof: "message_id_header" });
  });
  it.each(["missing", "other"] as const)("the acked id is %s in Sent: falls back to the Message-ID lookup", async byIdHeader => {
    const b = bench(live("lead_commercial"), { byIdHeader });
    expect(await b.run()).toEqual({ final: "confirmed" });
    expect(b.calls.sentMessageId).toEqual(["a1b2c3"]);
    expect(b.steps.get("forward_confirmed")).toMatchObject({ gmailMessageId: "sent1", proof: "message_id_header" });
  });
  it("an unreadable read-back by id is a retry by read-back only (no second send)", async () => {
    const b = bench(live("lead_commercial"), { byIdHeader: "throws" });
    expect(await b.run()).toEqual({ retry: "GMAIL_HTTP_500" });
    expect(await b.run()).toEqual({ retry: "GMAIL_HTTP_500" });
    expect(b.calls.send).toHaveLength(1);
    expect(b.calls.sentMessageId).toEqual(["a1b2c3", "a1b2c3"]);
  });
  it("a dispatched forward not found in Sent is retried by read-back only, then uncertain for a person", async () => {
    const b = bench(live("investisseur"), { sent: "missing", byIdHeader: "missing" });
    expect(await b.run()).toEqual({ retry: "SAV_INTAKE_ROUTING_FORWARD_UNCONFIRMED" });
    for (let i = 2; i < INTAKE_ROUTING_MAX_ATTEMPTS; i++) expect(await b.run()).toMatchObject({ retry: expect.any(String) });
    expect(await b.run()).toMatchObject({ final: "uncertain" });
    expect(b.calls.send).toHaveLength(1);
    expect(b.calls.findSent).toBe(INTAKE_ROUTING_MAX_ATTEMPTS);
  });
});

describe("review #347: the original attachments travel with the forward", () => {
  it("a candidature with a CV is forwarded with the original mail attached as message/rfc822, bytes intact", async () => {
    const b = bench(live("candidature"));
    expect(await b.run()).toEqual({ final: "confirmed" });
    expect(b.calls.readOriginal).toBe(1);
    const raw = b.calls.send[0];
    expect(raw).toMatch(/Content-Type: multipart\/mixed; boundary="sav-routing-[a-f0-9]{32}"/);
    expect(raw).toContain('Content-Type: message/rfc822; name="message-origine.eml"');
    expect(raw).toContain(ORIGINAL.toString("utf8"));
    expect(raw).toContain('application/pdf; name="cv.pdf"');
    expect(raw.trimEnd().endsWith("--")).toBe(true);
  });
  it("an original too large for Gmail's simple send stays human: nothing sent, nothing dispatched", async () => {
    const b = bench(live("candidature"), { original: Buffer.alloc(INTAKE_ROUTING_MAX_ORIGINAL_BYTES + 1, 65) });
    expect(await b.run()).toEqual({ final: "not_applied", reason: "SAV_INTAKE_ROUTING_ORIGINAL_TOO_LARGE" });
    expect(b.calls.send).toHaveLength(0);
    expect(b.steps.has("forward_dispatched")).toBe(false);
  });
  it("an unreadable original is retried before any dispatch (never a forward without its attachments)", async () => {
    const b = bench(live("candidature"), { originalThrows: "GMAIL_HTTP_503" });
    expect(await b.run()).toEqual({ retry: "GMAIL_HTTP_503" });
    expect(b.calls.send).toHaveLength(0);
    expect(b.steps.has("forward_dispatched")).toBe(false);
  });
});

describe("live archive", () => {
  it.each(["demarchage", "notification_auto"] as const)("%s: INBOX removed and read back, no mail sent", async cls => {
    const b = bench(live(cls));
    expect(await b.run()).toEqual({ final: "confirmed" });
    expect(b.calls).toMatchObject({ send: [], archive: 1, readOriginal: 0 });
  });
});

describe("refusals before any effect", () => {
  it.each([["newer_message", { newerMessage: true }], ["thread_ticket", { ticketId: "42" }], ["human_context", { humanContext: true }], ["v2_case", { v2Case: true }],
    ["handled_externally", { handledExternally: true }]] as const)("a fact changed since the analysis (%s): not applied", async (reason, thread) => {
    const b = bench(live("lead_commercial", { thread }));
    expect(await b.run()).toEqual({ final: "not_applied", reason });
    expect(b.calls).toEqual(NO_CALLS);
  });
  it.each(["finance", "cancellation"])("a %s mail is never forwarded, whatever the model said", async kind => {
    const b = bench(live("lead_commercial", { plan: { classification: kind, requestKinds: [kind], disposition: "ticket", progress: "processing" } }));
    expect(await b.run()).toMatchObject({ final: "not_applied", reason: "sensitive_request" });
    expect(b.calls.send).toHaveLength(0);
  });
  it("a support mail or a low-confidence class is never forwarded", async () => {
    const support = bench(live("support"));
    expect(await support.run()).toMatchObject({ final: "not_applied" });
    const doubtful = live("lead_commercial");
    const low = bench({ ...doubtful, stored: { ...decideIntakeRouting({ ...doubtful.facts, model: { class: "lead_commercial", confidence: "medium", justification: "?" } }), mode: "live" } });
    expect(await low.run()).toMatchObject({ final: "not_applied", reason: "confidence_medium" });
    expect(support.calls.send.length + low.calls.send.length).toBe(0);
  });
  it("review #347: a plan that disagrees with the class is never forwarded nor archived", async () => {
    const vendor = bench(live("demarchage", { plan: { classification: "partnership", requestKinds: ["partnership"], disposition: "no_ticket", progress: "supervised_action" } }));
    expect(await vendor.run()).toMatchObject({ final: "not_applied", reason: "routing_disagreement" });
    const bounce = bench(live("notification_auto", { plan: { classification: "unknown", requestKinds: ["unknown"], disposition: "collect_context", progress: "human_choice" } }));
    expect(await bounce.run()).toMatchObject({ final: "not_applied", reason: "v1_collect_context" });
    expect(vendor.calls.archive + bounce.calls.archive + vendor.calls.send.length + bounce.calls.send.length).toBe(0);
  });
  it("another mailbox is refused", () => {
    const facts = live("lead_commercial");
    expect(() => buildIntakeRoutingForward(facts.stored!, { ...facts.source, mailboxEmail: "ugo@limova.ai" }, ORIGINAL)).toThrow("SAV_INTAKE_ROUTING_FORWARD_INVALID");
  });
});
