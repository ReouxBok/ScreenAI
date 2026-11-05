import { describe, expect, it } from "vitest";
import { createCaseTicketStageAdapters, TICKET_STAGE_NOT_APPLIED_PREFIX } from "./case-ticket-stage-hubspot";
import { buildTicketStageIntent } from "./case-ticket-stage";
import { caseTicketStageKey } from "./customer-return";

/*
 * The HubSpot side of the `ticket_stage` effect, on a function-shaped synthetic HubSpot (no socket). Every refusal below is « zero PATCH »: the counter is the proof.
 * Ticket ids, owners and stage ids are synthetic placeholders.
 */
const TICKET = "9100001", PILOT = "424242", TEAM = "999111", CASE = "30000000-0000-4000-8000-000000000009";
const ENV = { SAV_V2_TICKET_STAGES: "on", SAV_V2_STAGE_WAITING_CUSTOMER: "2", SAV_V2_STAGE_CLOSED: "4", HUBSPOT_ACCESS_TOKEN: "synthetic-token" };

function hubspot(ticket: { pipeline: string; stage: string; owner: string | null }, mode: "ok" | "reject" | "lose" = "ok") {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const state = { ...ticket };
  const network = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.origin !== "https://api.hubapi.com" || url.pathname !== `/crm/v3/objects/tickets/${TICKET}`) throw Error("UNEXPECTED_REQUEST");
    if (method === "PATCH") {
      if (mode === "reject") return new Response("{}", { status: 403 });
      if (mode === "lose") throw Error("SOCKET_CLOSED");
      state.stage = JSON.parse(String(init!.body)).properties.hs_pipeline_stage;
      return Response.json({ id: TICKET });
    }
    return Response.json({ id: TICKET, properties: { hs_pipeline: state.pipeline, hs_pipeline_stage: state.stage, hubspot_owner_id: state.owner } });
  }) as typeof fetch;
  return { network, calls, state, patches: () => calls.filter(call => call.method === "PATCH") };
}
const intentOf = (target: "waiting_customer" | "closed" = "waiting_customer", stageId = target === "waiting_customer" ? "2" : "4", owner = PILOT) =>
  buildTicketStageIntent({ key: caseTicketStageKey(CASE, target, target === "closed" ? "cycle-1" : "reply:x"), target, stageId, ticketId: TICKET, caseId: CASE }, owner);
const adapters = (h: ReturnType<typeof hubspot>, env: Record<string, string | undefined> = ENV) => createCaseTicketStageAdapters({ network: h.network, env: () => env });
const signal = () => new AbortController().signal;
const refusal = async (promise: Promise<unknown>) => (await promise.then(() => "no refusal", error => (error as Error).message));

describe("the stage write: the last look before the only PATCH", () => {
  it("a Support ticket owned by the pilot is moved to the stage the configuration names, with ONE PATCH of the stage property alone", async () => {
    const h = hubspot({ pipeline: "0", stage: "1", owner: PILOT });
    const ack = await adapters(h).dispatch(intentOf(), signal());
    expect(ack).toEqual({ id: TICKET });
    expect(h.patches()).toEqual([{ method: "PATCH", path: `/crm/v3/objects/tickets/${TICKET}`, body: { properties: { hs_pipeline_stage: "2" } } }]);
    await expect(adapters(h).verify(intentOf(), ack, new Date(), signal())).resolves.toMatchObject({ confirmed: true, attributed: true });
  });

  it("COUNTER-TEST pipeline: a commercial ticket owned by the pilot gets ZERO PATCH, for both targets", async () => {
    for (const target of ["waiting_customer", "closed"] as const) {
      const h = hubspot({ pipeline: "88888888", stage: "1", owner: PILOT });
      expect(await refusal(adapters(h).dispatch(intentOf(target), signal()))).toBe(`${TICKET_STAGE_NOT_APPLIED_PREFIX}PIPELINE_NOT_SUPPORT`);
      expect(h.patches()).toHaveLength(0);
      expect(h.state.stage).toBe("1");
    }
    // A ticket whose pipeline is not readable is not Support either.
    const unknown = hubspot({ pipeline: "", stage: "1", owner: PILOT });
    expect(await refusal(adapters(unknown).dispatch(intentOf(), signal()))).toBe(`${TICKET_STAGE_NOT_APPLIED_PREFIX}PIPELINE_NOT_SUPPORT`);
    expect(unknown.patches()).toHaveLength(0);
  });

  it("COUNTER-TEST configuration: a sealed stage that is no longer the configured one (changed, removed or turned off) gets ZERO PATCH, and not even a read", async () => {
    const sealed = intentOf("waiting_customer", "2");
    for (const env of [{ ...ENV, SAV_V2_STAGE_WAITING_CUSTOMER: "3" }, { ...ENV, SAV_V2_STAGE_WAITING_CUSTOMER: undefined }, { ...ENV, SAV_V2_TICKET_STAGES: "off" }]) {
      const h = hubspot({ pipeline: "0", stage: "1", owner: PILOT });
      expect(await refusal(adapters(h, env).dispatch(sealed, signal()))).toMatch(new RegExp(`^${TICKET_STAGE_NOT_APPLIED_PREFIX}(STAGE_CONFIG_CHANGED|STAGES_OFF)$`));
      expect(h.patches()).toHaveLength(0);
      expect(h.calls).toHaveLength(0);
    }
    // The closed stage is judged against the closed stage, not the waiting one: a « waiting » stage id sealed under the closed target is refused.
    const crossed = intentOf("closed", "2");
    const h = hubspot({ pipeline: "0", stage: "1", owner: PILOT });
    expect(await refusal(adapters(h).dispatch(crossed, signal()))).toBe(`${TICKET_STAGE_NOT_APPLIED_PREFIX}STAGE_CONFIG_CHANGED`);
    expect(h.patches()).toHaveLength(0);
  });

  it("an owner who is not the pilot, a ticket already closed (for « waiting »), a rejected or unreadable ticket: zero PATCH, and a lost answer after the PATCH stays unknown", async () => {
    const taken = hubspot({ pipeline: "0", stage: "1", owner: TEAM });
    expect(await refusal(adapters(taken).dispatch(intentOf(), signal()))).toBe(`${TICKET_STAGE_NOT_APPLIED_PREFIX}OWNER_CHANGED`);
    const closed = hubspot({ pipeline: "0", stage: "4", owner: PILOT });
    expect(await refusal(adapters(closed).dispatch(intentOf(), signal()))).toBe(`${TICKET_STAGE_NOT_APPLIED_PREFIX}TICKET_CLOSED`);
    expect([taken, closed].flatMap(h => h.patches())).toHaveLength(0);
    const rejected = hubspot({ pipeline: "0", stage: "1", owner: PILOT }, "reject");
    expect(await refusal(adapters(rejected).dispatch(intentOf(), signal()))).toBe(`${TICKET_STAGE_NOT_APPLIED_PREFIX}HTTP_403`);
    const lost = hubspot({ pipeline: "0", stage: "1", owner: PILOT }, "lose");
    expect(await refusal(adapters(lost).dispatch(intentOf(), signal()))).toBe("SAV_TICKET_STAGE_RESULT_UNKNOWN");
    const noToken = hubspot({ pipeline: "0", stage: "1", owner: PILOT });
    expect(await refusal(adapters(noToken, { ...ENV, HUBSPOT_ACCESS_TOKEN: undefined }).dispatch(intentOf(), signal()))).toBe("SAV_TICKET_STAGE_TOKEN_MISSING");
    expect(noToken.calls).toHaveLength(0);
  });

  it("the verification is read-only and needs the stage AND the pilot owner AND the Support pipeline; otherwise it does not confirm", async () => {
    const moved = hubspot({ pipeline: "0", stage: "2", owner: PILOT });
    await expect(adapters(moved).verify(intentOf(), null, new Date(), signal())).resolves.toMatchObject({ confirmed: true });
    for (const state of [{ pipeline: "0", stage: "1", owner: PILOT }, { pipeline: "0", stage: "2", owner: TEAM }, { pipeline: "88888888", stage: "2", owner: PILOT }]) {
      const h = hubspot(state);
      await expect(adapters(h).verify(intentOf(), null, new Date(), signal())).resolves.toMatchObject({ confirmed: false, attributed: false });
      expect(h.calls.every(call => call.method === "GET")).toBe(true);
    }
  });
});
