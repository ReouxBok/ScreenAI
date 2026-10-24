import { describe, expect, it, vi } from "vitest";
import { createSavIntakeSemanticReaders, type IntakeGeminiCall, type IntakeModelTrace } from "./model-readers";
import { SAV_INTAKE_MODEL_LIMITS } from "./model-limits";
import { intakeDiagnosticPayload } from "./run-diagnostics";
import { encryptSavPayload } from "../crypto";
import type { IntakeHistory } from "./engine-types";

const at = "2026-10-21T10:00:00.000Z", mid = "10000000-0000-4000-8000-000000000001", tid = "20000000-0000-4000-8000-000000000001";
const marker = "PRIVATESYNTHETICBODY";
const message = { id: mid, threadId: tid, receivedAt: at, fromEmail: "client@example.test", toEmails: ["support@example.test"],
  direction: "inbound" as const, currentText: "Ma routine ne se lance toujours pas.", contentComplete: true };
const signal = () => new AbortController().signal;
const result = (json: unknown) => ({ json, metadata: { inputTokens: 10, outputTokens: 10, thoughtTokens: 0, totalTokens: 20 } });
type Data = { requests: unknown[]; citationCatalogue: { id: string; sourceId: string; text: string }[] };
const data = (arg: Parameters<IntakeGeminiCall>[0]) => JSON.parse(arg.body.contents[0].parts[0].text) as Data;
const anchor = (arg: Parameters<IntakeGeminiCall>[0], source: string) => data(arg).citationCatalogue.find(a => a.sourceId === source)!.id;

/** One customer reply of ~1.2 KB, quoting the whole previous chain as mail
 * clients do, and logged on the ticket by intake and again natively. */
const reply = (n: number) => `Bonjour,\nToujours bloqué (essai ${n}) : la routine "Relance" ne démarre pas, rien dans les logs. ${marker} ${"détail ".repeat(140)}\nCordialement`;
function chainBody(n: number) {
  let body = reply(0);
  for (let i = 1; i <= n; i++) body = `${reply(i)}\n\nLe 2${i}/10/2026 à 10:00, support@limova.ai a écrit :\n${body.split("\n").map(l => `> ${l}`).join("\n")}`;
  return body;
}
const email = (id: string, body: string) => ({ id: `emails:${id}`, kind: "email" as const, at,
  text: JSON.stringify({ from: message.fromEmail, to: "support@example.test", direction: "INCOMING_EMAIL", subject: "Re: Routine", body }) });
function threadHistory(replies: number, { quoted = true, nativeCopy = true } = {}): IntakeHistory {
  return Array.from({ length: replies }, (_, i) => {
    const body = quoted ? chainBody(i) : reply(i);
    return [email(`${i}a`, body), ...(nativeCopy ? [email(`${i}b`, body)] : [])];
  }).flat();
}
const ticket = (id: string) => ({ id, contactIds: ["101"], stage: "open" as const, createdAt: at, ownerId: null, subject: "Routine bloquée", content: "La routine ne démarre pas." });
function issueInput(history: IntakeHistory, requests = 1) {
  return { message, requests: Array.from({ length: requests }, (_, i) => ({ id: `r${i}`, kind: "support" as const, currentMessageId: mid })),
    tickets: [{ ticket: ticket("201"), history }],
    evidence: ["current", "ticket-201", "history-201"].map(id => ({ id, sourceId: id, observedAt: at, contentHash: "a".repeat(43), source: "crm_ticket" as const })) };
}
const sameVerdict = (arg: Parameters<IntakeGeminiCall>[0], sources: string[], requestIds = ["r0"]) => result({ investigationComplete: true,
  tickets: [{ ticketId: "201", relation: "same", requestIds, evidenceIds: ["current", "ticket-201", "history-201"], rationale: "Même routine", grounding: sources.map(s => ({ quoteId: anchor(arg, s) })) }] });

describe("ticket_matching context budget", () => {
  it("reproduces the limit from duplicated, quoted reply chains and explains it with counts only", async () => {
    const traces: IntakeModelTrace[] = [], call = vi.fn<IntakeGeminiCall>();
    const reader = createSavIntakeSemanticReaders({ model: "gemini-fixture", call, onTrace: t => traces.push(t) });
    await expect(reader.assessIssues(issueInput(threadHistory(8)), signal())).rejects.toThrow("SAV_INTAKE_MODEL_CONTEXT_LIMIT");
    expect(call).not.toHaveBeenCalled(); // refused before any provider request, nothing truncated
    const limit = traces[0].contextLimit!;
    expect(limit).toMatchObject({ stage: "data", limitBytes: SAV_INTAKE_MODEL_LIMITS.dataBytes });
    expect(limit.bytes).toBeGreaterThan(SAV_INTAKE_MODEL_LIMITS.dataBytes);
    const b = limit.breakdown!;
    // The catalogue (full verbatim sources) is the request; the history dominates it.
    expect(b.sections.catalogue / limit.bytes).toBeGreaterThan(0.9);
    expect(b.catalogue.bySource.history / b.sections.catalogue).toBeGreaterThan(0.9);
    expect(b.history).toMatchObject({ tickets: 1, events: 16, emails: 16, duplicateEvents: 8 });
    expect(b.history!.quotedBytes).toBeGreaterThan(b.history!.duplicateBytes / 2);
    expect(JSON.stringify(traces)).not.toContain(marker);
    expect(JSON.stringify(traces)).not.toContain(message.fromEmail);
    expect(JSON.stringify(traces)).not.toContain("citation");
  });
  it("shows the growth is quadratic in replies and disappears without quoting and copies", async () => {
    const size = async (history: IntakeHistory) => {
      let bytes = 0;
      const call: IntakeGeminiCall = async arg => { bytes = Buffer.byteLength(arg.body.contents[0].parts[0].text, "utf8"); return sameVerdict(arg, ["current", "ticket-201", "history-201"]); };
      await createSavIntakeSemanticReaders({ model: "gemini-fixture", call }).assessIssues(issueInput(history), signal());
      return bytes;
    };
    const six = await size(threadHistory(6)), two = await size(threadHistory(2));
    expect(six / two).toBeGreaterThan(5); // three times the replies, more than five times the bytes
    // The same eight authored replies, logged once and unquoted, fit comfortably.
    expect(await size(threadHistory(8, { quoted: false, nativeCopy: false }))).toBeLessThan(SAV_INTAKE_MODEL_LIMITS.dataBytes / 4);
  });
  it("keeps every request and every source span when the budget is respected", async () => {
    let seen: Data | undefined;
    const history = threadHistory(3);
    const call: IntakeGeminiCall = async arg => { seen = data(arg); return sameVerdict(arg, ["current", "ticket-201", "history-201"], ["r0", "r1", "r2"]); };
    const verdict = await createSavIntakeSemanticReaders({ model: "gemini-fixture", call }).assessIssues(issueInput(history, 3), signal());
    expect(verdict.tickets[0].requestIds).toEqual(["r0", "r1", "r2"]);
    expect(seen!.requests).toHaveLength(3);
    const historyText = seen!.citationCatalogue.filter(e => e.sourceId === "history-201").map(e => e.text).join(" ").replace(/\s+/g, " ");
    for (const event of history) expect(historyText).toContain(event.id);
    expect(historyText.split(marker).length - 1).toBe(history.reduce((n, e) => n + e.text.split(marker).length - 1, 0));
  });
  it("still rejects a verdict that omits a required source", async () => {
    const traces: IntakeModelTrace[] = [];
    const call: IntakeGeminiCall = async arg => sameVerdict(arg, ["current", "ticket-201"]);
    await expect(createSavIntakeSemanticReaders({ model: "gemini-fixture", call, onTrace: t => traces.push(t) }).assessIssues(issueInput(threadHistory(2)), signal()))
      .rejects.toThrow("SAV_INTAKE_MODEL_CITATION_REJECTED");
    expect(traces.at(-1)?.validationFailure?.reason).toBe("required_source_missing");
  });
  it("still rejects an anchor attributed to another source and an unknown anchor", async () => {
    for (const grounding of [(arg: Parameters<IntakeGeminiCall>[0]) => [{ quoteId: anchor(arg, "current"), sourceId: "history-201" }], () => [{ quoteId: "q9999" }]]) {
      const traces: IntakeModelTrace[] = [];
      const call: IntakeGeminiCall = async arg => result({ investigationComplete: true, tickets: [{ ticketId: "201", relation: "same", requestIds: ["r0"],
        evidenceIds: ["current", "ticket-201", "history-201"], rationale: "Non fondé", grounding: grounding(arg) }] });
      await expect(createSavIntakeSemanticReaders({ model: "gemini-fixture", call, onTrace: t => traces.push(t) }).assessIssues(issueInput(threadHistory(1)), signal())).rejects.toThrow();
      expect(["wrong_anchor_source", "unknown_anchor", "output_schema_invalid"]).toContain(traces[0].validationFailure?.reason);
      expect(traces.every(t => t.accepted === false)).toBe(true);
    }
  });
});

it("admin diagnostics expose the breakdown as allow-listed numbers only", () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-context-limit-encryption-key-32chars");
  const payload = intakeDiagnosticPayload(encryptSavPayload({ traces: [{ phase: "ticket_matching", accepted: false, errorCode: "SAV_INTAKE_MODEL_CONTEXT_LIMIT",
    contextLimit: { stage: "data", bytes: 140000, limitBytes: 98304, breakdown: {
      sections: { catalogue: 130000, evidence: 900, PRIVATE_KEY: 5 },
      catalogue: { entries: 80, bySource: { history: 125000, current: 200, "PRIVATE SOURCE": 1 } },
      history: { events: 16, duplicateEvents: 8, quotedBytes: "PRIVATE TEXT", leaked: "PRIVATE" } } } }] }));
  expect(payload.traces[0].contextLimit).toEqual({ stage: "data", bytes: 140000, limitBytes: 98304, breakdown: {
    sections: { catalogue: 130000, evidence: 900 }, catalogue: { entries: 80, bySource: { history: 125000, current: 200 } },
    history: { events: 16, duplicateEvents: 8, quotedBytes: null } } });
  expect(JSON.stringify(payload)).not.toContain("PRIVATE");
});
