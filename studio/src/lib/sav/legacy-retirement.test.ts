import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Drift guard for the retirement of the old V0 engine (SAV-9). It reads the sources, not the database: anything that would bring back an
// automatic producer of the old engine, a switch to revive it, or remove a V1 dependency fails here and must be classified in review.
const SRC = fileURLToPath(new URL("../../", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}
const sources = walk(SRC).map((path) => ({ path, name: relative(SRC, path), text: readFileSync(path, "utf8") }));
const source = (name: string) => readFileSync(join(SRC, name), "utf8");
const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

describe("the old producers stay retired", () => {
  it.each([
    ["scheduling an old follow-up", /insert\(savFollowups\)/],
    ["an old follow-up action key", /reply:followup:/],
    ["an automatic reply key", /reply:send:/],
    ["an automatic CRM e-mail log key", /hubspot:log-email:/],
    ["the old follow-up copy", /FOLLOWUP_COPY/],
    ["the follow-up calendar outside its definition", /followupDates\(/],
  ])("no source contains %s", (_label, pattern) => {
    const hits = sources.filter((entry) => pattern.test(entry.text) && entry.name !== "lib/sav/policy.ts").map((entry) => entry.name);
    expect(hits).toEqual([]);
  });
  it("the automatic-reply gates are not consulted by the old ticket, send or analysis code", () => {
    for (const name of ["lib/sav/hubspot.ts", "lib/sav/gmail.ts", "lib/sav/service.ts", "lib/sav/followups.ts"]) {
      expect(source(name), name).not.toMatch(/canSendRepliesAutomatically|autoReplyMinConfidence|savAutoReplyCategories|savAutoReplyDailyLimit|savThreadInAutoReplyRollout|getSavAutonomyGate/);
    }
  });
  it("the follow-up entry point reads, writes and imports nothing", () => {
    const text = source("lib/sav/followups.ts");
    expect(text).not.toMatch(/^import /m);
    expect(text).not.toMatch(/requireDb|savActions|savFollowups|insert\(|update\(|fetch\(/);
  });
  it("the cron no longer triggers the old follow-ups and keeps what V1 and the receipts need", () => {
    // The pass lives in lib/sav/reconcile-pass.ts, shared by the cron route and the self-scheduler fallback.
    const cron = source("app/api/cron/sav-reconcile/route.ts") + source("lib/sav/reconcile-pass.ts");
    expect(cron).not.toMatch(/followups|processDueFollowups/);
    for (const step of ["gmail_receipts", "hubspot_receipts", "email_openings", "context_refreshes", "intake_observation", "intake_wakes", "intake_choices",
      "intake_execution", "intake_tracking", "intake_console", "intake_gmail_read", "hubspot_ticket_actions", "gmail_replies", "hubspot_status_actions"]) {
      expect(cron, step).toContain(`"${step}"`);
    }
  });
  it("what remains of machine authorship is the audited set: the router decision and V1 journal metadata", () => {
    // Decisions and proposals already written by the old analysis stay in the database (a person may read them); nothing writes new ones.
    const byFile = Object.fromEntries(sources.map((entry): [string, number] => [entry.name, count(entry.text, /actorType: "(ai|system)"/g)]).filter(([, hits]) => hits > 0));
    expect(byFile).toEqual({
      "lib/sav/hubspot.ts": 1, // the router decision recorded after a ticket
      "lib/sav/intake/execution-store.ts": 2, // journal metadata of the V1 executor
      "lib/sav/intake/executor.ts": 1, // journal metadata of the V1 executor
      // lib/sav/service.ts no longer authors anything: the V0 analysis that wrote decisions, proposals and drafts is retired (below)
    });
  });
});

describe("the old V0 analysis stays retired", () => {
  const body = (text: string, name: string) => {
    const start = text.indexOf(`export async function ${name}(`);
    return start < 0 ? null : text.slice(start, text.indexOf("\n}\n", start) + 2);
  };
  const ENTRY_POINTS = ["processStoredSavMessage", "processPendingSavMessages", "processPendingSavPilotItems", "processSavPilotItem", "retrySavAnalysis", "repairSavProposal", "startSavPilotBatch"];
  it.each(ENTRY_POINTS)("%s reads, writes, hands over and analyses nothing", (name) => {
    const text = body(source("lib/sav/service.ts"), name);
    expect(text, name).not.toBeNull();
    expect(text).not.toMatch(/requireDb|savMessages|savPilotItems|savDecisions|savActions|savAgentRuns|insert\(|update\(|select\(|fetch\(|enqueueConfiguredSavIntake|analyzeStoredSavMessage|analyzeSavMessage/);
  });
  it("the cron has neither the pilot-item step nor the pending-message step", () => {
    expect(source("app/api/cron/sav-reconcile/route.ts") + source("lib/sav/reconcile-pass.ts")).not.toMatch(/pilot_items|pending_messages|processPendingSavMessages|processPendingSavPilotItems/);
  });
  it("no runtime code reaches the analysis: the stored-message analyser has no caller, the model entry has only the audited ones", () => {
    const callers = (needle: string) => sources.filter((entry) => entry.text.includes(needle)).map((entry) => `${entry.name}:${entry.text.split(needle).length - 1}`);
    expect(callers("analyzeStoredSavMessage")).toEqual(["lib/sav/service.ts:1"]); // its definition only
    // intelligence.ts defines it, service.ts wraps it (unreachable above), reanalysis.ts is the operator-only read-only comparison tool
    expect(callers("analyzeSavMessage(")).toEqual(["lib/sav/intelligence.ts:1", "lib/sav/reanalysis.ts:1", "lib/sav/service.ts:1"].sort());
  });
  it("the inbound path stores and hands the mail to V1, then stops: no decision, no pilot queue, no old decision writer", () => {
    const text = source("lib/sav/service.ts");
    expect(text).toContain("v0AnalysisRetired");
    expect(text).not.toMatch(/queuedForPilot|createDecision|processStoredSavMessage\(result/);
  });
  it("no environment variable brings the analysis back", () => {
    expect(sources.filter((entry) => /process\.env\.[A-Z0-9_]*(V0_ANALYSIS|ANALYSIS_RETIRED|REVIVE_ANALYSIS|UNRETIRE_ANALYSIS)/.test(entry.text)).map((entry) => entry.name)).toEqual([]);
  });
});

describe("there is no switch to bring the old engine back", () => {
  it("no environment variable or option revives, re-enables or un-retires the old engine", () => {
    const hits = sources.filter((entry) => /process\.env\.[A-Z0-9_]*(V0_ENGINE|LEGACY_ENGINE|RETIRE|REVIVE|UNRETIRE|V0_FOLLOWUP|V0_AUTO)/.test(entry.text)).map((entry) => entry.name);
    expect(hits).toEqual([]);
  });
  it("the retirement predicate depends on the author alone", () => {
    const text = source("lib/sav/action-policy.ts");
    const body = /export function isSavV0RetiredActor\([^)]*\): boolean \{([^}]*)\}/.exec(text)?.[1] ?? "";
    expect(body.trim()).toBe('return actorType !== "human";');
    expect(text).not.toMatch(/process\.env/);
  });
  it("it is applied both when workers choose candidates and when a write is authorised", () => {
    const text = source("lib/sav/action-policy.ts");
    expect(text).toMatch(/export function savModeAllowsWrite[\s\S]*?\{\n  if \(isSavV0RetiredActor\(actorType\)\) return false;/);
    expect(text).toMatch(/if \(input\.pilotBatchId\) return "SAV_PILOT_WRITE_BLOCKED";\n  if \(isSavV0RetiredActor\(input\.actorType\)\) return SAV_V0_ENGINE_RETIRED;/);
    expect(source("lib/sav/gmail.ts")).toMatch(/eq\(savActions\.actorType, "human"\)/);
  });
});

describe("V1 and the shared mechanisms keep what they use", () => {
  it("the Gmail transport, receipts and the Lu label are still exported by the shared module", () => {
    const gmail = source("lib/sav/gmail.ts");
    for (const name of ["requestSavGmail", "parseGmailMessage", "processPendingGmailReceipts", "processGmailReceipt", "acceptGmailWebhook", "fileOpenedGmailMessage", "renewActiveGmailWatches"]) {
      expect(gmail, name).toMatch(new RegExp(`export (async )?function ${name}\\b|export const ${name}\\b`));
    }
  });
  it("the CRM receipts, reads and the legacy occupation protocol are still there", () => {
    const hubspot = source("lib/sav/hubspot.ts");
    for (const name of ["processPendingHubspotReceipts", "acceptHubspotWebhook", "readSavHubspotContext", "processPendingHubspotActions"]) expect(hubspot, name).toContain(name);
    const occupation = source("lib/sav/intake/legacy-occupation.ts");
    for (const name of ["guardLegacyIntakeOccupation", "withLegacyOccupationAction", "markLegacyIntakeDispatch", "releaseLegacyIntakeIfConfirmed"]) expect(occupation, name).toContain(name);
  });
  it("the V1 executor still reads the legacy rows to detect a conflict: the rows are kept, not deleted", () => {
    expect(source("lib/sav/intake/execution-store.ts")).toContain("assertNoLegacyConflict");
    expect(sources.filter((entry) => /delete\(savActions\)|delete\(savFollowups\)|truncate\s+(table\s+)?sav\./i.test(entry.text) && entry.name.startsWith("lib/sav/")).map((entry) => entry.name)).toEqual([]);
  });
});
