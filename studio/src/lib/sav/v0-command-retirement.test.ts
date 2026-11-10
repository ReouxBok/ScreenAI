import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SAV-9 x SAV-60: the retired V0 commands are refused by the SERVER, where the work starts, before any read or effect. A hidden button is not
// a retirement: an old tab, a cached form or a replayed POST still reaches the server action.
const db = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/db", () => ({ requireDb: () => { db.calls += 1; throw Error("DB_TOUCHED"); } }));
import { SAV_V0_COMMANDS, SAV_LEGACY_COMMAND_RETIRED, isSavLegacyCommandRetired } from "./v0-command-retirement";
import { approveSavDraft, cancelSavPilotBatch, correctSavDecision, requestHumanIntervention, retrySavAction, reviewSavPilotItem } from "./service";
import { confirmSavSuggestedReply, queueSavManualReply } from "./manual-replies";
import { queueSavManualTicket } from "./manual-tickets";
import { enqueueSavContextRefresh, processPendingSavContextRefreshes } from "./dispatch";

const SRC = join(__dirname, "..", "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? (name === "node_modules" ? [] : walk(path)) : [path];
});
const sources = () => walk(SRC).filter(path => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path));
const UUID = "00000000-0000-4000-8000-000000000001";
const staff = "staff@example.invalid";

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => { db.calls = 0; fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy); });
afterEach(() => { vi.unstubAllGlobals(); });

// The lib function behind each command that the server refuses with SAV_LEGACY_COMMAND_RETIRED (12 of the 17 "retire" rows; the 5 others are
// already read-only or refused by SAV_V0_ANALYSIS_RETIRED / SAV_DRAFT_READ_ONLY).
const REFUSED: [string, string, () => Promise<unknown>][] = [
  ["A08 sendStudioReplyAction", "queueSavManualReply", () => queueSavManualReply({ threadId: UUID }, staff)],
  ["A09 sendSuggestedReplyAction", "confirmSavSuggestedReply", () => confirmSavSuggestedReply({ threadId: UUID }, staff)],
  ["A10 requestHumanAction", "requestHumanIntervention", () => requestHumanIntervention(UUID, staff, "raison valable")],
  ["A11 correctDecisionAction", "correctSavDecision", () => correctSavDecision(UUID, {}, staff)],
  ["A12 createTicketAction", "queueSavManualTicket", () => queueSavManualTicket({ threadId: UUID, reviewId: UUID, kind: "create_ticket" }, staff)],
  ["A13 linkTicketAction", "queueSavManualTicket", () => queueSavManualTicket({ threadId: UUID, reviewId: UUID, kind: "link_ticket", ticketId: "123" }, staff)],
  ["A15 refreshSavContextAction", "enqueueSavContextRefresh", () => enqueueSavContextRefresh(UUID, staff)],
  ["A18 approveDraftAction", "approveSavDraft", () => approveSavDraft(UUID, staff)],
  ["A19 retryAction", "retrySavAction", () => retrySavAction(UUID, staff)],
  ["A23 cancelPilotBatchAction / A24 cancelPilotBatchLabAction", "cancelSavPilotBatch", () => cancelSavPilotBatch(UUID, staff, "raison valable")],
  ["A25 reviewPilotItemAction", "reviewSavPilotItem", () => reviewSavPilotItem(UUID, {}, staff)],
];

describe("retired V0 commands: refused by the server before any effect", () => {
  it.each(REFUSED)("%s -> %s refuses with SAV_LEGACY_COMMAND_RETIRED: no database, no provider call", async (_name, _fn, call) => {
    await expect(call()).rejects.toThrow(SAV_LEGACY_COMMAND_RETIRED);
    expect(db.calls).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the signed-preview ticket path is NOT refused (canonical intake keeps working): it goes on to read the case", async () => {
    // Whatever it fails on afterwards (actor check, database), it is not the retirement refusal.
    const error = await queueSavManualTicket({ threadId: UUID, reviewId: UUID, kind: "create_ticket", previewToken: "signed.preview.token" }, staff).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toBe(SAV_LEGACY_COMMAND_RETIRED);
  });

  it("an unknown or malformed ticket payload without a preview token is refused too, never parsed into an effect", async () => {
    for (const raw of [undefined, null, {}, { kind: "link_ticket" }, { previewToken: "" }]) {
      await expect(queueSavManualTicket(raw as never, staff)).rejects.toThrow(SAV_LEGACY_COMMAND_RETIRED);
    }
    expect(db.calls).toBe(0);
  });
});

describe("refusal code", () => {
  it("the refusal has one stable signature: a plain Error whose message is exactly the code, recognised by the guard", async () => {
    const error = await queueSavManualReply({ threadId: UUID }, staff).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
    expect((error as Error).message).toBe("SAV_LEGACY_COMMAND_RETIRED");
    expect((error as Error).cause).toBeUndefined();
    expect(isSavLegacyCommandRetired(error)).toBe(true);
    expect([new Error("SAV_V0_ANALYSIS_RETIRED"), new Error("SAV_LEGACY_COMMAND_RETIRED "), "SAV_LEGACY_COMMAND_RETIRED", null].map(isSavLegacyCommandRetired)).toEqual([false, false, false, false]);
  });

  it("passes the catch blocks of actions.ts untouched, so the screen can show it instead of a generic message", () => {
    expect(SAV_LEGACY_COMMAND_RETIRED).toMatch(/^SAV_[A-Z_]+$/);
    expect(SAV_LEGACY_COMMAND_RETIRED).toMatch(/^[A-Z][A-Z_]+$/);
    expect("SAV_V0_ANALYSIS_RETIRED").not.toMatch(/^SAV_[A-Z_]+$/); // the existing analysis code is flattened today: documented for the UX contract
  });
});

describe("delayed triggers of retired commands", () => {
  it("the cron redispatch of old context-refresh requests is inert: no database read, no workflow, no provider call", async () => {
    expect(await processPendingSavContextRefreshes(5)).toEqual({ dispatched: 0, retired: true });
    expect(db.calls).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("retirement table", () => {
  const actionsSource = readFileSync(join(SRC, "app/studio/sav/actions.ts"), "utf8");
  const exported = [...actionsSource.matchAll(/export async function (\w+)/g)].map(match => match[1]!);

  it("covers exactly the 33 server actions of actions.ts: a new or removed export fails here", () => {
    expect(Object.keys(SAV_V0_COMMANDS).sort()).toEqual([...exported].sort());
    expect(exported).toHaveLength(33);
    expect(new Set(Object.values(SAV_V0_COMMANDS).map(entry => entry.id)).size).toBe(33);
  });

  it("keeps the 8 documented keep rows and never closes recovery of an engaged effect (A17, A20, A33)", () => {
    const open = (name: keyof typeof SAV_V0_COMMANDS) => SAV_V0_COMMANDS[name].server;
    expect(Object.entries(SAV_V0_COMMANDS).filter(([, entry]) => entry.decision === "keep")).toHaveLength(8);
    for (const name of ["reconcileTicketAction", "retryWebhookAction", "reconcileTicketReturnAction"] as const) expect(open(name)).toBe("open");
  });

  // The refusal has TWO barriers and this test requires at least one on the action and the other on the lib function, whichever shape the
  // interface lot is in: the action may refuse itself (`refuseLegacyCommand`, UX e1c98f1: role guard, then redirect to the archive, nothing else
  // called) or reach the lib function behind it, which refuses first (`refuseRetiredSavV0Command`). It must NOT demand that the action calls the
  // lib function: that would force a useless call into a refused command and contradicts the action-level refusal. The lib barrier is proved
  // by behaviour above (REFUSED), the action barrier by v0-command-retirement-post.test.ts (old POST, every provider forbidden).
  it("every action marked refused is refused by the server: on the action itself or, failing that, by the lib function the table names", () => {
    const body = (name: string) => actionsSource.slice(actionsSource.indexOf(`export async function ${name}`)).split(/\nexport async function /)[0]!;
    const libFunction: Record<string, string> = {
      sendStudioReplyAction: "queueSavManualReply", sendSuggestedReplyAction: "confirmSavSuggestedReply", requestHumanAction: "requestHumanIntervention",
      correctDecisionAction: "correctSavDecision", createTicketAction: "queueSavManualTicket", linkTicketAction: "queueSavManualTicket",
      refreshSavContextAction: "enqueueSavContextRefresh", approveDraftAction: "approveSavDraft", retryAction: "retrySavAction",
      cancelPilotBatchAction: "cancelSavPilotBatch", cancelPilotBatchLabAction: "cancelSavPilotBatch", reviewPilotItemAction: "reviewSavPilotItem",
    };
    for (const [action, fn] of Object.entries(libFunction)) {
      const text = body(action);
      const selfRefusing = /\brefuseLegacyCommand\(/.test(text);
      expect(selfRefusing || text.includes(fn), `${action} must refuse itself or reach ${fn}, which refuses`).toBe(true);
      // A self-refusing action reaches no effect at all: it never also calls the lib function.
      if (selfRefusing) expect(text, `${action} refuses itself, so it must not also call ${fn}`).not.toContain(fn);
    }
    const named = sources().flatMap(path => [...readFileSync(path, "utf8").matchAll(/refuseRetiredSavV0Command\("(\w+)"\)/g)].map(match => match[1]!));
    expect(named.length).toBeGreaterThanOrEqual(9);
    for (const name of named) expect(SAV_V0_COMMANDS[name as keyof typeof SAV_V0_COMMANDS]?.server, name).toBe("refused");
    // The lib barrier stays on every function a retired command can reach (the ticket path is a ternary in manual-tickets.ts, tested by behaviour).
    // Deleting a guard because the action refuses first is not allowed: this set fails.
    expect([...new Set(named)].sort()).toEqual(["approveDraftAction", "cancelPilotBatchAction", "correctDecisionAction", "refreshSavContextAction", "requestHumanAction", "retryAction", "reviewPilotItemAction", "sendStudioReplyAction", "sendSuggestedReplyAction"]);
  });

  it("no source file imports an archived body: only tests keep them, to seed rows for the worker paths that still run", () => {
    const offenders = sources().filter(path => /\b(requestHumanIntervention|correctSavDecision|approveSavDraft|retrySavAction|cancelSavPilotBatch|reviewSavPilotItem|queueSavManualReply|confirmSavSuggestedReply|queueSavManualTicket|enqueueSavContextRefresh|processPendingSavContextRefreshes)Archived\b/.test(readFileSync(path, "utf8")))
      .map(path => relative(SRC, path)).filter(path => !/^lib\/sav\/(service|manual-replies|manual-tickets|dispatch)\.ts$/.test(path));
    expect(offenders).toEqual([]);
  });
});
