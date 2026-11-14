import { expect, it, vi } from "vitest";
vi.mock("./runtime-store", () => ({ settleSavIntakeCall: vi.fn(async () => true) }));
import { boundIntakeTicketHistories, intakeHistoryNotice, SAV_INTAKE_HISTORY_BUDGET } from "./history-budget";
import { createIntakeModelDispatcher } from "./model-dispatch";
import type { IntakeGeminiCall } from "./model-readers";
import type { IntakeRuntimeConfig } from "./runtime-contract";
import { SAV_INTAKE_ANALYSIS_TIMING } from "./attempt-policy";
import { SAV_AI_BUDGET } from "../gemini-transport";
import type { IntakeHistory } from "./engine-types";

const B = SAV_INTAKE_HISTORY_BUDGET;
const history = (ticket: string, events: number, chars: number): IntakeHistory => Array.from({ length: events }, (_, i) => ({
  id: `${ticket}-e${i}`, kind: "email" as const, at: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(), text: `${i}:`.padEnd(chars, "x") }));
const row = (id: string, events: number, chars: number) => ({ ticket: { id }, history: history(id, events, chars) });
const size = (rows: { history: IntakeHistory }[]) => rows.reduce((sum, r) => sum + r.history.reduce((s, e) => s + e.text.length, 0), 0);

it("SAV-92 leaves small histories byte-identical (same request body and ledger hash as before)", () => {
  const rows = [row("1", 5, 300), row("2", 3, 1200)];
  const bounded = boundIntakeTicketHistories(rows, ["2"]);
  expect(bounded[0]).toBe(rows[0]); expect(bounded[1]).toBe(rows[1]);
  expect(bounded.some(r => "historyOmitted" in r)).toBe(false);
});

it("SAV-92 bounds 7 large histories (the 0.41 USD case) to the total budget, newest events first, and says so", () => {
  const rows = Array.from({ length: 7 }, (_, i) => row(String(i + 1), 100, 20_000));
  const before = size(rows), bounded = boundIntakeTicketHistories(rows);
  expect(before).toBe(14_000_000);
  // Each event costs at most eventChars plus a small header; at most one minimal event may exceed a ticket's share.
  expect(size(bounded)).toBeLessThanOrEqual(B.totalChars);
  for (const [i, r] of bounded.entries()) {
    expect(r.history.length).toBeGreaterThanOrEqual(1);
    expect(r.history.length).toBeLessThanOrEqual(B.eventsPerTicket);
    // The kept events are the newest, still in chronological order.
    expect(r.history.at(-1)!.id).toBe(rows[i].history.at(-1)!.id);
    expect(r.history.every(e => e.text.length <= B.eventChars)).toBe(true);
    expect(r.historyOmitted).toEqual({ events: 100 - r.history.length, shortenedEvents: r.history.length, suppliedEvents: r.history.length, totalEvents: 100 });
    // A shortened event is the verbatim beginning of the original (quotes stay verbatim).
    expect(rows[i].history.find(e => e.id === r.history[0].id)!.text.startsWith(r.history[0].text)).toBe(true);
  }
  expect(intakeHistoryNotice(bounded[0].historyOmitted!)).toContain("never conclude");
});

it("SAV-92 the ticket of the Gmail thread keeps the larger share and is never cut away by other candidates", () => {
  const rows = Array.from({ length: 7 }, (_, i) => row(String(i + 1), 100, 3_000));
  const bounded = boundIntakeTicketHistories(rows, ["4", null, undefined, "absent"]);
  const linked = bounded[3], others = bounded.filter((_, i) => i !== 3);
  expect(linked.history.length).toBeGreaterThan(Math.max(...others.map(r => r.history.length)));
  expect(size([linked])).toBeLessThanOrEqual(B.priorityChars);
  expect(linked.history.length).toBeGreaterThanOrEqual(14);
  expect(others.every(r => r.history.length >= 1)).toBe(true);
  // Deterministic: the same input always gives the same bounded body.
  expect(JSON.stringify(boundIntakeTicketHistories(rows, ["4"]))).toBe(JSON.stringify(boundIntakeTicketHistories(rows, ["4"])));
});

it("SAV-92 production model calls get the comparison's 60 s; outer deadlines cannot cut them", () => {
  const T = SAV_INTAKE_ANALYSIS_TIMING;
  expect(T.modelMs).toBe(SAV_AI_BUDGET.durationMs);
  expect(T.analysisMs).toBeGreaterThan(T.modelMs);
  expect(T.leaseMs).toBeGreaterThanOrEqual(T.analysisMs + T.settlementMs);
  expect(T.startMarginMs).toBeGreaterThanOrEqual(T.analysisMs + T.settlementMs);
  // The scheduled pass (270 s budget, 300 s function) still finishes an analysis started at its margin.
  expect(T.startMarginMs).toBeLessThan(270_000);
});

it.each([
  [true, "understanding", false, "single_pass"], [true, "ticket_matching", false, "single_pass"],
  [false, "understanding", false, "standard"],
] as const)("SAV-92 single-pass when eligible=%s phase=%s media=%s -> %s", async (eligible, phase, media, expected) => {
  const network = vi.fn<typeof fetch>(async () => new Response(null, { status: 400 }));
  const dispatcher = createIntakeModelDispatcher({ config: { model: "gemini-3.6-flash" } as IntakeRuntimeConfig, live: async () => {}, network, captureDiagnostics: true,
    signal: new AbortController().signal, env: () => ({ SAV_GEMINI_API_KEY: "synthetic-key" }), reserve: async () => ({ id: "r", cached: null }), singlePassWhenEligible: eligible });
  const input: Parameters<IntakeGeminiCall>[0] = { model: "gemini-3.6-flash", phase, promptRevision: "fixture", signal: new AbortController().signal, allowRetry: false,
    body: { systemInstruction: { parts: [{ text: "fixture" }] }, contents: [{ role: "user", parts: [{ text: "x" }] }], generationConfig: { maxOutputTokens: 8192 } } };
  void media; // A visual call keeps "standard": the dispatcher selects single_pass only when !input.media (transport rule).
  await dispatcher.call(input).catch(() => {});
  expect(dispatcher.diagnostics[0]?.generationBudget).toBe(expected);
});
