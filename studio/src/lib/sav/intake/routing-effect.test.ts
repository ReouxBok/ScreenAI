// V1 routing (23/11): the live effect with an in-memory store and a fake Gmail. Shadow and off do nothing; live forwards once (idempotent, never a second
// send after a dispatch), archives demarchage/automatic mails, and refuses as soon as a fact changed. Synthetic.
import { describe, expect, it } from "vitest";
import { buildIntakeRoutingForward, INTAKE_ROUTING_MAX_ATTEMPTS, intakeRoutingRfcMessageId, routeIntakeMessage, type IntakeRoutingDeps, type IntakeRoutingLiveFacts,
  type IntakeRoutingStep } from "./routing-effect";
import { decideIntakeRouting, type SavIntakeRoutingClass, type SavIntakeRoutingFacts } from "./routing-rules";

const MID = "60000000-0000-4000-8000-000000000001";
const ruleFacts = (cls: SavIntakeRoutingClass, plan?: SavIntakeRoutingFacts["plan"]): SavIntakeRoutingFacts => ({ messageId: MID,
  model: { class: cls, confidence: "high", justification: "Fait." },
  plan: plan ?? { classification: "commercial", requestKinds: ["commercial"], disposition: "no_ticket", progress: "supervised_action" },
  thread: { conversationLength: 1, ticketId: null, humanContext: false, quotedReply: false } });
function live(cls: SavIntakeRoutingClass, over: { thread?: Partial<SavIntakeRoutingFacts["thread"]>; mode?: string; plan?: SavIntakeRoutingFacts["plan"] } = {}): IntakeRoutingLiveFacts {
  const analysed = ruleFacts(cls, over.plan);
  const stored = { ...decideIntakeRouting(analysed), mode: over.mode ?? "live" };
  return { stored, facts: { ...analysed, thread: { ...analysed.thread, ...over.thread } },
    source: { mailboxEmail: "contact@limova.ai", gmailMessageId: "abc123", gmailThreadId: "def456", fromEmail: "prospect@example.test", subject: "Demande de tarif",
      receivedAt: "2026-11-23T08:00:00.000Z", text: "Bonjour, quel est le prix pour 3 utilisateurs ?" } };
}
function bench(facts: IntakeRoutingLiveFacts | null, options: { mode?: string; sent?: "found" | "missing" | "after_send"; sendThrows?: boolean; authority?: () => Promise<void>; archived?: boolean } = {}) {
  const steps = new Map<IntakeRoutingStep, Record<string, unknown>>(); let attempts = 0;
  const calls = { send: [] as string[], findSent: 0, archive: 0 };
  let delivered = false;
  const deps: IntakeRoutingDeps = {
    env: () => ({ SAV_INTAKE_ROUTING_MODE: options.mode ?? "live" }),
    authority: options.authority ?? (async () => undefined),
    readFacts: async () => facts,
    store: {
      steps: async () => [...steps.keys()],
      record: async (_id, step, metadata) => { if (steps.has(step)) return false; steps.set(step, metadata); return true; },
      lease: async () => async () => undefined,
      attempt: async () => ++attempts,
    },
    gmail: {
      send: async (_mailbox, raw) => { calls.send.push(raw); delivered = true; if (options.sendThrows) throw Error("GMAIL_HTTP_500"); return { id: "s1", threadId: "t1" }; },
      findSent: async (_mailbox, rfc) => { calls.findSent++; expect(rfc).toBe(intakeRoutingRfcMessageId(MID));
        return options.sent === "missing" ? null : options.sent === "found" || delivered ? "sent1" : null; },
      archive: async () => { calls.archive++; return options.archived ?? true; },
    },
  };
  return { deps, steps, calls, run: () => routeIntakeMessage(MID, deps) };
}

describe("off and shadow perform no effect", () => {
  it.each([undefined, "shadow", "on"])("mode %s: no read, no Gmail call, no receipt", async mode => {
    const b = bench(live("lead_commercial"), { mode: mode ?? "" });
    expect(await b.run()).toEqual({ skipped: "off" });
    expect(b.calls).toEqual({ send: [], findSent: 0, archive: 0 });
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

describe("live forward: once, idempotent", () => {
  it("forwards a lead to sacha once, reads it back in Sent, then closes", async () => {
    const b = bench(live("lead_commercial"));
    expect(await b.run()).toEqual({ final: "confirmed" });
    expect(b.calls.send).toHaveLength(1);
    expect(b.calls.send[0]).toContain("To: sacha@limova.ai");
    expect(b.calls.send[0]).toContain("From: contact@limova.ai");
    expect(b.calls.send[0]).not.toContain("prospect@example.test\r\nTo");
    expect([...b.steps.keys()]).toEqual(["claimed", "forward_dispatched", "forward_confirmed", "confirmed"]);
    expect(await b.run()).toEqual({ skipped: "already_done" });
    expect(b.calls.send).toHaveLength(1);
  });
  it("partenariat goes to nathan", async () => {
    const b = bench(live("partenariat"));
    await b.run();
    expect(b.calls.send[0]).toContain("To: nathan@limova.ai");
  });
  it("an unknown send outcome is confirmed by the read-back, never re-sent", async () => {
    const b = bench(live("candidature"), { sendThrows: true });
    expect(await b.run()).toEqual({ final: "confirmed" });
    expect(b.calls.send).toHaveLength(1);
  });
  it("a dispatched forward not found in Sent is retried by read-back only, then uncertain for a person", async () => {
    const b = bench(live("investisseur"), { sent: "missing" });
    expect(await b.run()).toEqual({ retry: "SAV_INTAKE_ROUTING_FORWARD_UNCONFIRMED" });
    for (let i = 2; i < INTAKE_ROUTING_MAX_ATTEMPTS; i++) expect(await b.run()).toMatchObject({ retry: expect.any(String) });
    expect(await b.run()).toMatchObject({ final: "uncertain" });
    expect(b.calls.send).toHaveLength(1);
    expect(b.calls.findSent).toBe(INTAKE_ROUTING_MAX_ATTEMPTS);
  });
});

describe("live archive", () => {
  it.each(["demarchage", "notification_auto"] as const)("%s: INBOX removed and read back, no mail sent", async cls => {
    const b = bench(live(cls));
    expect(await b.run()).toEqual({ final: "confirmed" });
    expect(b.calls).toMatchObject({ send: [], archive: 1 });
  });
});

describe("refusals before any effect", () => {
  it.each([["newer_message", { newerMessage: true }], ["thread_ticket", { ticketId: "42" }], ["human_context", { humanContext: true }], ["v2_case", { v2Case: true }],
    ["handled_externally", { handledExternally: true }]] as const)("a fact changed since the analysis (%s): not applied", async (reason, thread) => {
    const b = bench(live("lead_commercial", { thread }));
    expect(await b.run()).toEqual({ final: "not_applied", reason });
    expect(b.calls).toEqual({ send: [], findSent: 0, archive: 0 });
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
  it("another mailbox is refused", () => {
    const facts = live("lead_commercial");
    expect(() => buildIntakeRoutingForward(facts.stored!, { ...facts.source, mailboxEmail: "ugo@limova.ai" })).toThrow("SAV_INTAKE_ROUTING_FORWARD_INVALID");
  });
});
