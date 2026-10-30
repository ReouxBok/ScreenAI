import { createElement, Fragment, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prerender } from "react-dom/static";
import { beforeEach, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ staff: vi.fn(), list: vi.fn(), detail: vi.fn(), action: vi.fn(), crmDisplay: vi.fn(), controls: vi.fn(), manualOther: vi.fn(), operator: vi.fn() }));
vi.mock("@/lib/sav/intake/manual-other-classification", () => ({ readManualOtherEligibility: mocks.manualOther, manualOtherUnavailableLabels: { not_waiting: "Ce dossier n’attend pas un classement humain." } }));
vi.mock("./manual-other-actions", () => ({ classifyManualOtherAction: mocks.action }));
vi.mock("@/lib/sav/intake-ux/operator-commands", () => ({ readOperatorPanel: mocks.operator }));
vi.mock("@/lib/sav/intake-ux/message-controls", () => ({ readUxMessageControls: mocks.controls }));
vi.mock("@/lib/sav/intake/crm-display-server", () => ({ readIntakeCrmDisplay: mocks.crmDisplay }));
vi.mock("@/lib/sav/intake/console-auth", () => ({ requireIntakeConsoleStaff: mocks.staff }));
vi.mock("@/lib/sav/intake/console-store", () => ({ listIntakeConsole: mocks.list }));
vi.mock("./agent-pause-banner", () => ({ AgentPauseBanner: () => null }));
vi.mock("@/lib/sav/intake/console-detail", () => ({ readIntakeConsoleDetail: mocks.detail }));
vi.mock("./actions", () => ({ saveIntakeChoice: mocks.action, requestRecoveryAction: mocks.action, reconcileIdentificationAction: mocks.action, reconcileNoteAction: mocks.action, completeIntakeDossierAction: mocks.action, releaseIntakeHumanHoldAction: mocks.action }));
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => createElement("a", props) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw Error("NOT_FOUND"); } }));
import IntakeConsolePage from "./page";
import IntakeDetailPage from "./[id]/page";
import { intakeDossierSummary, studioMcpTools, type StudioMcpContext } from "@/lib/mcp/tools";

/** SAV-25 golden tests: for the same fixture dossier, the MCP read tools state what the console renders. Synthetic data only. */
const threadId = "10000000-0000-4000-8000-000000000001", messageId = "10000000-0000-4000-8000-000000000002", runId = "10000000-0000-4000-8000-000000000003";
const at = new Date("2026-10-21T10:00:00Z");
const list = { installed: true, counts: { learning: 1, missing_contact: 1, to_validate: 2, sensitive: 1, completed: 1, other: 1, processing: 3, blocked: 1 }, rows: [
  { threadId, mailboxId: "10000000-0000-4000-8000-000000000004", messageId, version: 7, subject: "Connexion synthétique", fromEmail: "fiction@example.invalid", receivedAt: at, updatedAt: at,
    view: null, status: "waiting", reason: "SAV_INTAKE_RUNTIME_DAILY_BUDGET_DEFERRED", blockedCause: null, retryAt: null },
  { threadId: "10000000-0000-4000-8000-000000000011", mailboxId: "10000000-0000-4000-8000-000000000004", messageId: "10000000-0000-4000-8000-000000000012", version: 2, subject: "", fromEmail: null,
    receivedAt: at, updatedAt: at, view: null, status: "waiting", reason: null, blockedCause: "attempts_exhausted", retryAt: null }], page: 1, pages: 1, total: 3 };
const effects = [{ id: "effect-1", kind: "ticket_create", state: "confirmed", confirmedAt: at }, { id: "effect-2", kind: "email_associate", state: "uncertain", confirmedAt: null }];
const base = { thread: { id: threadId, subject: "Connexion synthétique", paused: false, ticketId: null }, projection: { epoch: 4, projectedEpoch: 4, view: null, status: "human_choice", reason: null },
  latestMessageId: messageId, handledExternally: false, humanHeld: false, confirmedCurrent: false, historyTruncated: false, diagnostics: null,
  current: { id: runId, messageId, state: "observed", candidateContactIds: ["101", "102"], sourceHash: "a".repeat(64), version: 7, sourceMatches: true,
    payload: { plan: { candidateContactIds: ["101", "102"], decision: { classification: "support", disposition: { kind: "ticket", target: { operation: "link", contactId: "101", ticketId: "201" } },
      evidence: [{ id: "t", source: "crm_ticket", sourceId: "201", observedAt: at.toISOString() }] } } } },
  messages: [{ id: messageId, direction: "inbound", fromEmail: "fiction@example.invalid", receivedAt: at, createdAt: at, body: { text: "Ma connexion synthétique ne fonctionne plus.", attachments: [] } }],
  progress: { runId, confirmed: false, state: "uncertain", ticketId: null, reason: "SAV_INTAKE_EXECUTION_RECONCILIATION_REQUIRED", effects }, choices: [] };
const fixtures = {
  unsettled_effect: base,
  waiting_budget: { ...base, projection: { ...base.projection, status: "waiting", reason: "SAV_INTAKE_RUNTIME_DAILY_BUDGET_DEFERRED" }, progress: null,
    current: { ...base.current, state: "waiting", payload: { reason: "SAV_INTAKE_RUNTIME_DAILY_BUDGET_DEFERRED", plan: { ...base.current.payload.plan,
      decision: { ...base.current.payload.plan.decision, disposition: { kind: "collect_context", reasons: ["contact_ambiguous"] } } } } } },
  blocked: { ...base, projection: { ...base.projection, status: "waiting", reason: null }, progress: null, diagnostics: { messageId, attemptsExhausted: true, attemptBudget: { failed: 2, total: 2 }, runs: [] },
    current: { ...base.current, state: "waiting" } },
  human_hold: { ...base, humanHeld: true, projection: { ...base.projection, view: "to_validate", status: "human_hold", reason: "L’équipe garde la main sur ce dossier. L’automatisation reste en pause ; une décision humaine est attendue." } },
  completed: { ...base, handledExternally: true, projection: { ...base.projection, view: "completed", status: "handled_externally", reason: "Traité hors Studio — clôture administrative de ce message." },
    progress: { ...base.progress, state: "confirmed", confirmed: true, effects: [effects[0]] } },
} as const;
const context = { user: {} as StudioMcpContext["user"], staff: { id: "s", email: "ugo@limova.ai", role: "admin", name: "Ugo" } };
const tool = (name: string) => studioMcpTools.find(t => t.name === name)!;
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const renderDetail = async () => { const { prelude } = await prerender(createElement(Fragment, null, await IntakeDetailPage({ params: Promise.resolve({ id: threadId }) })));
  return (await new Response(prelude).text()).replace(/<!--(?: |\$|\/\$)-->/g, ""); };
beforeEach(() => {
  vi.clearAllMocks(); mocks.manualOther.mockResolvedValue({ binding: null, reason: "not_waiting" }); mocks.controls.mockResolvedValue({ blocked: false });
  mocks.operator.mockResolvedValue({ information: null, allowResume: false, allowReanalysis: false, allowInformation: false, unavailableReason: "synthetic", resume: null });
  mocks.crmDisplay.mockResolvedValue({ contacts: {}, tickets: {} }); mocks.staff.mockResolvedValue({ id: "s", email: "ugo@limova.ai", role: "admin" }); mocks.list.mockResolvedValue(list);
});
it.each(Object.keys(fixtures) as (keyof typeof fixtures)[])("SAV-25 get_dossier states what the dossier page renders: %s", async name => {
  const data = fixtures[name]; mocks.detail.mockResolvedValue(data);
  const html = await renderDetail(), result = await tool("get_dossier").run(context, { threadId } as never);
  expect(result.outcome).toBe("done");
  const summary = result.data as ReturnType<typeof intakeDossierSummary>;
  expect(html).toContain(escape(summary.status.label!));
  if (summary.decision) expect(html).toContain(escape(summary.decision.route));
  if (summary.question) expect(html).toContain(escape(summary.question));
  for (const effect of summary.effects) { expect(html).toContain(escape(effect.label)); expect(html).toContain(escape(effect.stateLabel)); }
  if (summary.execution) expect(html).toContain(escape(summary.execution.title));
  for (const cause of summary.handoff?.causes ?? []) expect(html).toContain(escape(cause.replace(/\.$/u, "")));
  expect(summary.locks.blocked).toBe(html.includes("Analyse bloquée"));
  expect(summary.locks.humanHeld).toBe(html.includes("Reprendre ce dossier"));
  expect(summary.locks.unsettledEffects).toBe(data.progress?.effects.filter(e => e.state === "uncertain").length ?? 0);
  expect(summary.lastMessage?.text).toBe(data.messages[0].body.text);
  expect(JSON.parse(Buffer.from(summary.versionToken, "base64url").toString())).toEqual({ v: 1, threadId, messageId, runId, version: 7, sourceHash: "a".repeat(64), epoch: 4 });
});
it("SAV-25 list_dossiers states the console rows, labels and counters", async () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, await IntakeConsolePage({ searchParams: Promise.resolve({}) })));
  const result = await tool("list_dossiers").run(context, { view: "processing", page: 1, sort: "newest" } as never);
  const data = result.data as { counts: Record<string, number>; rows: { label: string; reason: string | null; subject: string; blocked: boolean }[]; total: number };
  expect(mocks.list).toHaveBeenLastCalledWith({ view: "processing", search: undefined, page: 1 });
  for (const row of data.rows) { expect(html).toContain(escape(row.label)); if (row.reason) expect(html).toContain(escape(row.reason)); expect(html).toContain(escape(row.subject)); }
  expect(data.rows.map(r => r.blocked)).toEqual([false, true]);
  expect(data.counts).toMatchObject({ processing: 3, blocked: 1, to_validate: 2, completed: 1 }); expect(data.total).toBe(3);
  expect(html).not.toContain("SAV_INTAKE_RUNTIME_DAILY_BUDGET_DEFERRED");
  expect(JSON.stringify(data)).not.toContain("SAV_INTAKE_RUNTIME_DAILY_BUDGET_DEFERRED\"");
});
it("SAV-25 get_dossier bounds the message text and never returns the rest of the history", async () => {
  const long = "x".repeat(4100), older = { ...base.messages[0], id: "10000000-0000-4000-8000-000000000099", body: { text: "historique synthétique privé", attachments: [] } };
  mocks.detail.mockResolvedValue({ ...base, messages: [{ ...base.messages[0], body: { text: long, attachments: [{ filename: "capture.png", mimeType: "image/png", size: 1 }] } }, older] });
  const summary = (await tool("get_dossier").run(context, { threadId } as never)).data as ReturnType<typeof intakeDossierSummary>;
  expect(summary.lastMessage).toMatchObject({ text: "x".repeat(4000), truncated: true, attachments: ["capture.png"] });
  expect(summary.history).toEqual({ messages: 2, truncated: false });
  expect(JSON.stringify(summary)).not.toContain("historique synthétique privé");
  mocks.detail.mockResolvedValue(null);
  expect(await tool("get_dossier").run(context, { threadId } as never)).toMatchObject({ outcome: "refused", code: "SAV_INTAKE_DOSSIER_NOT_FOUND" });
});


it("REVIEW-bf05 MCP distinguishes current effects from the historical execution retained by the page", async () => {
  const previousRun = { ...base, progress: { ...base.progress, runId: "10000000-0000-4000-8000-000000000098" } };
  mocks.detail.mockResolvedValue(base);
  const currentHtml = await renderDetail();
  mocks.detail.mockResolvedValue(previousRun);
  const previousHtml = await renderDetail();
  expect(currentHtml).toContain("Actions réellement accomplies");
  expect(previousHtml).toContain("Actions historiques conservées");
  const summary = (data: unknown) => intakeDossierSummary(data as Parameters<typeof intakeDossierSummary>[0]);
  expect(summary(previousRun)).not.toEqual(summary(base));
});
it("BF05 planned effects of an older version are historical; confirmed current effects are current, as on the page", async () => {
  const olderRun = "10000000-0000-4000-8000-000000000097";
  const older = { ...base, progress: { ...base.progress, executionId: "e-old", runId: olderRun, version: 6, state: "planned",
    effects: [{ id: "p1", kind: "ticket_create", state: "planned", confirmedAt: null }] } };
  const confirmed = { ...base, confirmedCurrent: true, progress: { ...base.progress, executionId: "e-cur", version: 7, state: "confirmed", confirmed: true, ticketId: "201", effects: [effects[0]] } };
  for (const [data, applicability, title] of [[older, "historical", "Actions historiques conservées"], [confirmed, "current", "Actions réellement accomplies"]] as const) {
    mocks.detail.mockResolvedValue(data);
    const html = await renderDetail(), summary = intakeDossierSummary(data as unknown as Parameters<typeof intakeDossierSummary>[0]);
    expect(html).toContain(title);
    expect(summary.execution).toMatchObject({ applicability, title, runId: data.progress.runId, version: data.progress.version, executionId: data.progress.executionId, currentRunId: runId, currentVersion: 7 });
  }
  expect(intakeDossierSummary(confirmed as never).linkedTicketId).toBe("201");
  expect(intakeDossierSummary(older as never).effects).toEqual([expect.objectContaining({ state: "planned" })]);
});
