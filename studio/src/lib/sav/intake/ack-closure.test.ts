// SAV-95: the effect path. Switch off = zero call and zero row; one confident close = one stage write read back + one note read back + one final receipt;
// a retry or a concurrent pass never writes twice; every unknown outcome is kept for a person. HubSpot faked at the network boundary. Synthetic data.
import { describe, expect, it } from "vitest";
import { closeAcknowledgedTicket, createAckClosureHubspot, isAckClosureRequest, type AckClosureDeps, type AckClosureStep, type AckClosureStore } from "./ack-closure";
import type { AckClosureFacts, SavAckClosureAnalysis } from "./ack-closure-rules";

const OUT = "50000000-0000-4000-8000-000000000001", MID = "50000000-0000-4000-8000-000000000002", TICKET = "7001";
const model = (over: Partial<SavAckClosureAnalysis> = {}): SavAckClosureAnalysis => ({ decision: "close", confidence: "high", lastOutboundMessageId: OUT, lastOutboundState: "conclusive",
  customerMessage: "pure_ack", justification: "Réponse conclusive.", evidenceQuote: "C'est corrigé", ...over });
const facts = (over: Partial<AckClosureFacts> = {}): AckClosureFacts => ({ v1Acknowledgement: true, customerMessageId: MID, previous: { messageId: OUT, direction: "outbound" },
  newerMessage: false, ticketId: TICKET, sensitiveDossier: false, v2Case: false, model: model(), ...over });

function memoryStore() {
  const rows: Array<{ messageId: string; step: AckClosureStep; metadata: Record<string, unknown> }> = [];
  const store: AckClosureStore = {
    steps: async id => rows.filter(r => r.messageId === id).map(r => r.step),
    record: async (id, step, metadata) => { if (rows.some(r => r.messageId === id && r.step === step)) return false; rows.push({ messageId: id, step, metadata }); return true; },
  };
  return { rows, store };
}

/** A fake HubSpot ticket and notes behind `fetch`, recording every request. */
function fakeHubspot(options: { stage?: string; pipeline?: string; patchStatus?: number; patchApplies?: boolean; noteStatus?: number; noteBody?: string; noteAssociated?: boolean } = {}) {
  const state = { stage: options.stage ?? "2", pipeline: options.pipeline ?? "0", notes: new Map<string, { body: string; ticketId: string }>() };
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const network: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, ...(body ? { body } : {}) });
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (url.pathname === `/crm/v3/objects/tickets/${TICKET}` && method === "GET") return json(200, { id: TICKET, properties: { hs_pipeline: state.pipeline, hs_pipeline_stage: state.stage } });
    if (url.pathname === `/crm/v3/objects/tickets/${TICKET}` && method === "PATCH") {
      if (options.patchStatus && options.patchStatus !== 200) return json(options.patchStatus, {});
      if (options.patchApplies !== false) state.stage = body.properties.hs_pipeline_stage;
      return json(200, { id: TICKET });
    }
    if (url.pathname === "/crm/v3/objects/notes" && method === "POST") {
      if (options.noteStatus && options.noteStatus >= 500) return json(options.noteStatus, {});
      const id = String(9000 + state.notes.size);
      state.notes.set(id, { body: options.noteBody ?? body.properties.hs_note_body, ticketId: body.associations[0].to.id });
      return json(201, { id });
    }
    const note = /^\/crm\/v3\/objects\/notes\/(\d+)$/.exec(url.pathname);
    if (note && method === "GET") {
      const row = state.notes.get(note[1]!);
      return row ? json(200, { id: note[1], properties: { hs_note_body: row.body }, associations: { tickets: { results: options.noteAssociated === false ? [] : [{ id: row.ticketId, type: "note_to_ticket" }] } } }) : json(404, {});
    }
    return json(404, {});
  };
  return { state, calls, network, writes: () => calls.filter(c => c.method !== "GET") };
}

function deps(over: Partial<AckClosureDeps> & { hub?: ReturnType<typeof fakeHubspot>; mem?: ReturnType<typeof memoryStore>; facts?: AckClosureFacts | null } = {}) {
  const hub = over.hub ?? fakeHubspot(), mem = over.mem ?? memoryStore();
  const env = () => ({ SAV_ACK_CLOSE: "on", HUBSPOT_ACCESS_TOKEN: "synthetic-token" });
  const value: AckClosureDeps = { env, authority: async () => {}, readFacts: async () => over.facts === undefined ? facts() : over.facts, store: mem.store,
    hubspot: createAckClosureHubspot({ network: hub.network, env: over.env ?? env }), now: () => new Date("2026-11-18T12:00:00.000Z"), ...over };
  return { value, hub, mem };
}

describe("switch and authority", () => {
  it("switch off: no read, no call, no row", async () => {
    let read = 0;
    const { value, hub, mem } = deps({ env: () => ({ HUBSPOT_ACCESS_TOKEN: "synthetic-token" }), readFacts: async () => { read++; return facts(); } });
    expect(await closeAcknowledgedTicket(MID, value)).toEqual({ skipped: "off" });
    expect(read).toBe(0); expect(hub.calls).toEqual([]); expect(mem.rows).toEqual([]);
  });
  it("no authority or no closure right: nothing", async () => {
    const { value, hub, mem } = deps({ authority: async () => { throw Error("SAV_ACK_CLOSE_PERMISSION_MISSING"); } });
    expect(await closeAcknowledgedTicket(MID, value)).toEqual({ skipped: "authority", detail: "SAV_ACK_CLOSE_PERMISSION_MISSING" });
    expect(hub.calls).toEqual([]); expect(mem.rows).toEqual([]);
  });
  it("the switch turned off between the read and the write: no write", async () => {
    let reads = 0;
    const env = () => ({ SAV_ACK_CLOSE: reads++ < 2 ? "on" : "off", HUBSPOT_ACCESS_TOKEN: "synthetic-token" });
    const { value, hub } = deps({ env });
    expect(await closeAcknowledgedTicket(MID, value)).toEqual({ skipped: "off" });
    expect(hub.writes()).toEqual([]);
  });
});

describe("a confident close", () => {
  it("writes the stage only, reads it back, adds one associated note, reads it back, records the receipt", async () => {
    const { value, hub, mem } = deps();
    const result = await closeAcknowledgedTicket(MID, value);
    expect(result).toEqual({ final: "confirmed", basis: "conclusive_reply_acknowledged", noteId: "9000" });
    expect(hub.state.stage).toBe("4");
    expect(hub.writes()).toEqual([
      { method: "PATCH", path: `/crm/v3/objects/tickets/${TICKET}`, body: { properties: { hs_pipeline_stage: "4" } } },
      { method: "POST", path: "/crm/v3/objects/notes", body: { properties: { hs_note_body: "<p>Fermé : le client a confirmé la résolution (accusé)</p>", hs_timestamp: "2026-11-18T12:00:00.000Z" },
        associations: [{ to: { id: TICKET }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 228 }] }] } },
    ]);
    expect(mem.rows.map(r => r.step)).toEqual(["claimed", "stage_confirmed", "note_dispatched", "confirmed"]);
    expect(mem.rows.at(-1)!.metadata).toMatchObject({ ticketId: TICKET, basis: "conclusive_reply_acknowledged", stage: "4", noteId: "9000", revision: "sav-ack-closure-2026-11-18.v1" });
    // Never an email, never an owner.
    expect(JSON.stringify(hub.calls)).not.toMatch(/emails|hubspot_owner_id|gmail/);
  });
  it("is idempotent: a second pass writes nothing and records nothing", async () => {
    const { value, hub, mem } = deps();
    await closeAcknowledgedTicket(MID, value);
    const writes = hub.writes().length, rows = mem.rows.length;
    expect(await closeAcknowledgedTicket(MID, value)).toEqual({ skipped: "already_done" });
    expect(hub.writes()).toHaveLength(writes); expect(mem.rows).toHaveLength(rows);
  });
  it("two concurrent passes post one note only", async () => {
    const shared = deps();
    const [a, b] = await Promise.all([closeAcknowledgedTicket(MID, shared.value), closeAcknowledgedTicket(MID, shared.value)]);
    expect(shared.hub.calls.filter(c => c.method === "POST")).toHaveLength(1);
    expect([a, b]).toContainEqual({ skipped: "note_in_progress" });
  });
  it("a crash after the stage resumes with the note only (no second stage write)", async () => {
    const mem = memoryStore();
    await mem.store.record(MID, "claimed", {}); await mem.store.record(MID, "stage_confirmed", {});
    const { value, hub } = deps({ mem, hub: fakeHubspot({ stage: "4" }) });
    expect(await closeAcknowledgedTicket(MID, value)).toMatchObject({ final: "confirmed" });
    expect(hub.writes().map(w => w.method)).toEqual(["POST"]);
  });
  it("a crash after the note was dispatched never posts again: a person checks", async () => {
    const mem = memoryStore();
    await mem.store.record(MID, "claimed", {}); await mem.store.record(MID, "stage_confirmed", {}); await mem.store.record(MID, "note_dispatched", {});
    const { value, hub } = deps({ mem });
    expect(await closeAcknowledgedTicket(MID, value)).toEqual({ final: "uncertain", reason: "note_outcome_unknown" });
    expect(hub.calls).toEqual([]);
  });
});

describe("no close", () => {
  it("the owner's open example: no HubSpot call, one final refusal", async () => {
    const { value, hub, mem } = deps({ facts: facts({ model: model({ decision: "keep_open", lastOutboundState: "open", evidenceQuote: "C'est transmis à l'équipe technique" }) }) });
    expect(await closeAcknowledgedTicket(MID, value)).toEqual({ final: "not_applied", reason: "model_keep_open" });
    expect(hub.calls).toEqual([]); expect(mem.rows.map(r => r.step)).toEqual(["not_applied"]);
  });
  it.each<[string, Partial<AckClosureFacts>]>([["a newer inbound", { newerMessage: true }], ["a sensitive dossier", { sensitiveDossier: true }], ["unsure", { model: model({ decision: "unsure", confidence: "low" }) }]])
  ("%s: nothing written to HubSpot", async (_name, over) => {
    const { value, hub } = deps({ facts: facts(over) });
    expect(await closeAcknowledgedTicket(MID, value)).toMatchObject({ final: "not_applied" });
    expect(hub.calls).toEqual([]);
  });
  it("a ticket already closed by someone: no write, no note", async () => {
    const { value, hub } = deps({ hub: fakeHubspot({ stage: "4" }) });
    expect(await closeAcknowledgedTicket(MID, value)).toEqual({ final: "already_closed", basis: "conclusive_reply_acknowledged" });
    expect(hub.writes()).toEqual([]);
  });
  it("another pipeline: no write", async () => {
    const { value, hub } = deps({ hub: fakeHubspot({ pipeline: "99" }) });
    expect(await closeAcknowledgedTicket(MID, value)).toMatchObject({ final: "not_applied", reason: "pipeline_not_support" });
    expect(hub.writes()).toEqual([]);
  });
  it("HubSpot refuses the stage: refused, no note", async () => {
    const { value, hub } = deps({ hub: fakeHubspot({ patchStatus: 409 }) });
    expect(await closeAcknowledgedTicket(MID, value)).toMatchObject({ final: "not_applied", reason: "stage_rejected" });
    expect(hub.calls.filter(c => c.method === "POST")).toEqual([]);
  });
  it("a stage not read back: retried later, no note, no final receipt", async () => {
    const { value, hub, mem } = deps({ hub: fakeHubspot({ patchApplies: false }) });
    expect(await closeAcknowledgedTicket(MID, value)).toEqual({ retry: "stage_unconfirmed" });
    expect(hub.calls.filter(c => c.method === "POST")).toEqual([]); expect(mem.rows.map(r => r.step)).toEqual(["claimed"]);
  });
  it("a note with an unknown outcome or not read back stays uncertain for a person", async () => {
    const unknown = deps({ hub: fakeHubspot({ noteStatus: 502 }) });
    expect(await closeAcknowledgedTicket(MID, unknown.value)).toMatchObject({ final: "uncertain", reason: "note_outcome_unknown" });
    const detached = deps({ hub: fakeHubspot({ noteAssociated: false }) });
    expect(await closeAcknowledgedTicket(MID, detached.value)).toMatchObject({ final: "uncertain", reason: "note_unverified" });
  });
  it("a newer mail after the stage was closed: kept for a person, no note", async () => {
    const mem = memoryStore();
    await mem.store.record(MID, "claimed", {}); await mem.store.record(MID, "stage_confirmed", {});
    const { value, hub } = deps({ mem, facts: facts({ newerMessage: true }) });
    expect(await closeAcknowledgedTicket(MID, value)).toEqual({ final: "uncertain", reason: "newer_message" });
    expect(hub.calls).toEqual([]);
  });
});

it("the HubSpot adapter may only read/patch a ticket and post/read a note", () => {
  expect(isAckClosureRequest(`/crm/v3/objects/tickets/${TICKET}`, "PATCH")).toBe(true);
  expect(isAckClosureRequest("/crm/v3/objects/notes", "POST")).toBe(true);
  expect(isAckClosureRequest("/crm/v3/objects/emails", "POST")).toBe(false);
  expect(isAckClosureRequest(`/crm/v3/objects/tickets/${TICKET}`, "DELETE")).toBe(false);
  expect(isAckClosureRequest("/crm/v3/objects/contacts/1", "PATCH")).toBe(false);
});
