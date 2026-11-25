import { describe, expect, it, vi } from "vitest";
import {
  createSavIntakeHubspotReaders, savIntakeBodylessHistoryEnabled, SAV_INTAKE_BODYLESS_EMAIL_TEXT, SAV_INTAKE_BODYLESS_NOTE_TEXT, type IntakeReadTrace,
} from "./hubspot-readers";
import { planSavIntake } from "./engine";
import type { EngineInput, EnginePolicy, IntakeAdapters } from "./engine-types";

// SAV-139: a reply in an existing thread whose ticket history holds one engagement without body (an email logged with
// only files, an empty note) is no longer blocked as « historique et pièces non analysées » when the flag is on.
// Fictional data only (@exemple.invalid).
const at = "2026-11-25T10:00:00.000Z", earlier = "2026-11-24T09:00:00.000Z";
const mid = "10000000-0000-4000-8000-000000000139", thread = "20000000-0000-4000-8000-000000000139";
const sender = "client@exemple.invalid";
const signal = () => new AbortController().signal;
const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
const edge = (id: string) => ({ toObjectId: id, associationTypes: [{ typeId: 16, category: "HUBSPOT_DEFINED", label: null }] });
const pipeline = { id: "0", stages: ["1", "2", "3", "4"].map(id => ({ id, metadata: { isClosed: id === "4" ? "true" : "false" } })) };

type Engagements = { notes?: Record<string, string | null>[]; emails?: Record<string, string | null>[] };
/** Synthetic HubSpot: contact 101, one open support ticket 201 whose history holds the given engagements. */
function hubspot(engagements: Engagements) {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input)), path = url.pathname;
    if (path.endsWith("/contacts/search")) return response({ results: [{ id: "101", properties: { email: sender, hs_additional_emails: null } }], total: 1 });
    if (path.endsWith("/pipelines/tickets/0")) return response(pipeline);
    if (path === "/crm/v4/objects/contacts/101/associations/tickets") return response({ results: [edge("201")] });
    if (path === "/crm/v4/objects/tickets/201/associations/contacts") return response({ results: [edge("101")] });
    if (path.endsWith("/tickets/batch/read")) return response({ status: "COMPLETE", results: [{ id: "201", properties: {
      subject: "Problème technique", content: "Les agents ne répondent plus.", createdate: earlier, hs_pipeline: "0", hs_pipeline_stage: "2", hubspot_owner_id: null } }] });
    for (const type of ["notes", "emails"] as const) {
      const rows = engagements[type] ?? [];
      if (path === `/crm/v4/objects/tickets/201/associations/${type}`) return response({ results: rows.map((_, i) => edge(`${type === "notes" ? 3 : 4}0${i}`)) });
      if (path.endsWith(`/${type}/batch/read`)) return response({ status: "COMPLETE", results: rows.map((properties, i) => ({ id: `${type === "notes" ? 3 : 4}0${i}`, properties })) });
    }
    return response({ results: [] });
  }) as typeof fetch;
}
const bodylessEmail = { hs_email_text: null, hs_email_html: null, hs_email_subject: "Re: Problème technique", hs_email_from_email: sender,
  hs_email_to_email: "support@exemple.invalid", hs_email_direction: "INCOMING_EMAIL", hs_timestamp: earlier };
const emptyNote = { hs_note_body: null, hs_timestamp: earlier };
const writtenEmail = { ...bodylessEmail, hs_email_text: "Bonjour, les agents ne répondent plus depuis hier." };

function readers(engagements: Engagements, bodylessHistory?: boolean, onRead?: (trace: IntakeReadTrace) => void) {
  return createSavIntakeHubspotReaders({ network: hubspot(engagements), now: () => new Date(at), ...(bodylessHistory === undefined ? {} : { bodylessHistory }), ...(onRead ? { onRead } : {}) });
}

describe("SAV-139 flag SAV_INTAKE_BODYLESS_HISTORY", () => {
  it("is on only for the exact value « on »", () => {
    expect(savIntakeBodylessHistoryEnabled({})).toBe(false);
    for (const value of ["", "off", "true", "1", "ON", "shadow"]) expect(savIntakeBodylessHistoryEnabled({ SAV_INTAKE_BODYLESS_HISTORY: value })).toBe(false);
    expect(savIntakeBodylessHistoryEnabled({ SAV_INTAKE_BODYLESS_HISTORY: "on" })).toBe(true);
  });

  it("flag off (default and explicit): a bodyless email or empty note is still a partial read history_body_unavailable", async () => {
    vi.stubEnv("SAV_INTAKE_BODYLESS_HISTORY", "");
    try {
      for (const engagements of [{ emails: [bodylessEmail] }, { notes: [emptyNote] }, { notes: [emptyNote], emails: [writtenEmail] }]) {
        for (const flag of [undefined, false]) {
          const traces: IntakeReadTrace[] = [];
          const result = await readers(engagements, flag, trace => traces.push(trace)).ticketHistory("201", signal());
          expect(result).toEqual({ status: "partial", data: [], observedAt: at });
          expect(traces.at(-1)).toMatchObject({ operation: "ticket_history", status: "partial", reason: "history_body_unavailable" });
        }
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it("flag on: keeps each bodyless engagement, dated, with an explicit marker, and the written ones unchanged", async () => {
    const result = await readers({ notes: [emptyNote], emails: [bodylessEmail, { ...writtenEmail, hs_timestamp: at }] }, true).ticketHistory("201", signal());
    expect(result.status).toBe("complete");
    expect(result.data).toHaveLength(3);
    expect(result.data.find(e => e.id === "notes:300")).toEqual({ id: "notes:300", kind: "note", at: earlier, text: SAV_INTAKE_BODYLESS_NOTE_TEXT });
    expect(JSON.parse(result.data.find(e => e.id === "emails:400")!.text)).toMatchObject({ subject: "Re: Problème technique", body: SAV_INTAKE_BODYLESS_EMAIL_TEXT });
    expect(JSON.parse(result.data.find(e => e.id === "emails:401")!.text).body).toBe(writtenEmail.hs_email_text);
  });

  it("flag on via the environment, when no option is passed", async () => {
    vi.stubEnv("SAV_INTAKE_BODYLESS_HISTORY", "on");
    try { expect((await readers({ emails: [bodylessEmail] }).ticketHistory("201", signal())).status).toBe("complete"); }
    finally { vi.unstubAllEnvs(); }
  });

  it("flag on: a body property HubSpot did not return at all (scope, schema) stays a partial read", async () => {
    const noteWithoutProperty = Object.fromEntries(Object.entries(emptyNote).filter(([key]) => key !== "hs_note_body"));
    const emailWithoutHtml = Object.fromEntries(Object.entries(bodylessEmail).filter(([key]) => key !== "hs_email_html"));
    for (const engagements of [{ notes: [noteWithoutProperty] }, { emails: [emailWithoutHtml] }]) {
      expect((await readers(engagements, true).ticketHistory("201", signal())).status).toBe("partial");
    }
  });

  it("flag on: an engagement without date is still a partial read (other gates unchanged)", async () => {
    expect((await readers({ emails: [{ ...bodylessEmail, hs_timestamp: null }] }, true).ticketHistory("201", signal())).status).toBe("partial");
  });
});

describe("SAV-139 engine: a reply in an existing thread with a bodyless engagement in its ticket history", () => {
  const reply = { id: mid, threadId: thread, receivedAt: at, fromEmail: sender, toEmails: ["support@exemple.invalid"], direction: "inbound" as const,
    currentText: "Re: Problème technique — toujours pas de réponse des agents, pouvez-vous regarder ?", contentComplete: true };
  const input = (): EngineInput => ({ message: reply, latestInboundMessageId: mid, conversation: { status: "complete", data: [reply], observedAt: at },
    now: at, mode: "current", identificationAttemptId: "attempt-139" });
  const policy: EnginePolicy = { relationRevision: "fixture-139", admittedRelations: [], resources: {} };
  const models = (kind: "support" | "finance" | "cancellation"): Pick<IntakeAdapters, "analyseMessage" | "assessIssues"> => ({
    analyseMessage: async () => ({ messageId: mid, nature: "request", requests: [{ id: "r0", kind, currentMessageId: mid }],
      ticketSummary: { title: "Agents sans réponse", description: reply.currentText, requestIds: ["r0"] } }),
    assessIssues: async () => ({ investigationComplete: true, tickets: [{ ticketId: "201", relation: "same", requestIds: ["r0"], evidenceIds: ["current", "ticket-201", "history-201"] }] }),
  });
  const plan = (engagements: Engagements, flag: boolean, kind: "support" | "finance" | "cancellation" = "support") =>
    planSavIntake(input(), { ...readers(engagements, flag), ...models(kind) }, policy);

  it("flag off: identical to today, the team is asked to complete the context (history_incomplete)", async () => {
    const p = await plan({ emails: [bodylessEmail] }, false);
    expect(p.decision.disposition).toMatchObject({ kind: "collect_context", reasons: ["history_incomplete"] });
    expect(p.steps).toEqual([]);
  });

  it("flag on: the reply is decided and linked to the open ticket of its thread", async () => {
    const p = await plan({ emails: [bodylessEmail], notes: [emptyNote] }, true);
    expect(p.decision.disposition).toMatchObject({ kind: "ticket", history: "complete", target: { operation: "link", ticketId: "201", contactId: "101" } });
    expect(p.steps.map(s => s.mutation)).toEqual(["link_ticket", "associate_email", "append_ticket_note", "set_ticket_new"]);
  });

  it("flag on: the plan equals the one for the same history with written bodies, except the hashed history itself", async () => {
    const tolerant = await plan({ emails: [bodylessEmail] }, true), written = await plan({ emails: [writtenEmail] }, true);
    expect(tolerant.decision.disposition.kind).toBe(written.decision.disposition.kind);
    expect(tolerant.steps.map(s => s.mutation)).toEqual(written.steps.map(s => s.mutation));
    expect(tolerant.decision.evidence.find(e => e.id === "history-201")?.contentHash).not.toBe(written.decision.evidence.find(e => e.id === "history-201")?.contentHash);
  });

  it.each(["finance", "cancellation"] as const)("flag on: a %s request keeps its classification and stays excluded from learning (team gate unchanged)", async kind => {
    const tolerant = await plan({ emails: [bodylessEmail] }, true, kind), written = await plan({ emails: [writtenEmail] }, false, kind);
    expect(tolerant.decision.classification).toBe(kind);
    expect(tolerant.decision.disposition).toMatchObject({ kind: "ticket", learning: "excluded" });
    expect(tolerant.steps.map(s => s.mutation)).toEqual(written.steps.map(s => s.mutation));
  });

  it("flag on: a current attachment the reader calls required still keeps the dossier for the team", async () => {
    const withFile = { ...reply, unreadAttachments: [{ sourceId: "file-1", reason: "unsupported_type" as const }] };
    const p = await planSavIntake({ ...input(), message: withFile, conversation: { status: "complete", data: [withFile], observedAt: at } },
      { ...readers({ emails: [bodylessEmail] }, true), ...models("support"),
        analyseMessage: async () => ({ messageId: mid, nature: "request", requests: [{ id: "r0", kind: "support", currentMessageId: mid }],
          ticketSummary: { title: "Agents sans réponse", description: reply.currentText, requestIds: ["r0"] },
          unreadAttachmentRequirements: [{ sourceId: "file-1", role: "required" }] }) }, policy);
    expect(p.decision.disposition).toMatchObject({ kind: "collect_context", reasons: ["history_incomplete"] });
  });
});
