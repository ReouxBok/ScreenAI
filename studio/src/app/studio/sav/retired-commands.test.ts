import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";

// SAV-60: every provider, queue, CRM, Gmail, model and database entry point used by
// actions.ts throws if touched. A retired command may only run its role guard and
// redirect to the archive with the refusal code.
const { d, forbidden } = vi.hoisted(() => ({ d: { auth: vi.fn(), redirect: vi.fn(), revalidate: vi.fn() }, forbidden: (name: string) => vi.fn(() => { throw new Error(`FORBIDDEN_CALL:${name}`); }) }));
vi.mock("@/lib/sav/auth", () => ({ requireSavApiStaff: d.auth }));
vi.mock("next/navigation", () => ({ redirect: d.redirect }));
vi.mock("next/cache", () => ({ revalidatePath: d.revalidate }));
vi.mock("@/lib/sav/hubspot", () => ({ reconcileSavTicketReturn: forbidden("hubspot"), continueHubspotBackfill: forbidden("hubspot"), reconcileSavManualTicket: forbidden("hubspot") }));
vi.mock("@/lib/sav/learning", () => ({ approveLearningCandidate: forbidden("learning"), rejectLearningCandidate: forbidden("learning") }));
vi.mock("@/lib/sav/service", () => ({ retrySavWebhookReceipt: forbidden("service") }));
vi.mock("@/lib/knowledge/review", () => ({ reviewKnowledgeCandidate: forbidden("knowledge") }));
vi.mock("@/lib/knowledge/hubspot-import", () => ({ importHubspotKnowledge: forbidden("knowledge"), prepareHubspotReview: forbidden("knowledge") }));
vi.mock("@/lib/knowledge/onboarding-import", () => ({ proposeActiveOnboardingKnowledge: forbidden("knowledge") }));
vi.mock("@/db", () => ({ requireDb: forbidden("db") }));
vi.mock("@/lib/sav/review", () => ({ reviewSavProposal: forbidden("review") }));
vi.mock("@/lib/sav/observations", () => ({ qualifySavObservation: forbidden("observations") }));
vi.mock("@/lib/sav/draft-verdicts", () => ({ reviewSavDraft: forbidden("drafts") }));
vi.mock("@/lib/sav/drafts", () => ({ saveSavHumanReplyDraft: forbidden("drafts") }));
vi.mock("@/lib/sav/metrics", () => ({ recordSavDeploymentDecision: forbidden("metrics") }));
vi.mock("@/lib/sav/reviewed-replay", () => ({ createReviewedSavReplay: forbidden("replay"), runReviewedSavRuleReplay: forbidden("replay") }));
import * as actions from "./actions";
import * as hubspot from "@/lib/sav/hubspot";
import * as service from "@/lib/sav/service";

const thread = "10000000-0000-4000-8000-000000000001";
const retired = {
  saveReplyDraftAction: "", sendStudioReplyAction: "reply", sendSuggestedReplyAction: "reply", requestHumanAction: "", correctDecisionAction: "",
  createTicketAction: "ticket", linkTicketAction: "ticket", retryAnalysisAction: "", refreshSavContextAction: "", repairSavProposalAction: "",
  approveDraftAction: "", retryAction: "", startPilotBatchAction: "", startSelectedPilotBatchAction: "", cancelPilotBatchAction: "",
  cancelPilotBatchLabAction: "", reviewPilotItemAction: "",
} as const;
const form = (withThread = true) => { const f = new FormData(); if (withThread) f.set("threadId", thread); for (const n of ["messageId", "actionId", "draftActionId", "decisionId", "pilotBatchId", "pilotItemId", "reviewId", "ticketId"]) f.set(n, thread); return f; };
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", forbidden("network")); d.auth.mockResolvedValue({ email: "contact@example.test" }); d.redirect.mockImplementation((url: string) => { throw new Error(`REDIRECT:${url}`); }); });

it("lists exactly the 17 commands the SAV-60 inventory retires", () => {
  expect(Object.keys(retired)).toHaveLength(17);
  expect(Object.keys(actions)).toHaveLength(33);
});

it.each(Object.entries(retired))("%s: guard first, then archive notice, nothing else", async (name, kind) => {
  const action = (actions as unknown as Record<string, (f?: FormData) => Promise<void>>)[name];
  const notice = `notice=SAV_LEGACY_COMMAND_RETIRED${kind ? `&kind=${kind}` : ""}`;
  await expect(action(form())).rejects.toThrow(name === "startPilotBatchAction" ? `REDIRECT:/studio/sav/archives?${notice}` : `REDIRECT:/studio/sav/archives/${thread}?${notice}`);
  expect(d.auth).toHaveBeenCalledTimes(1); expect(d.auth.mock.invocationCallOrder[0]).toBeLessThan(d.redirect.mock.invocationCallOrder[0]);
  expect(d.revalidate).not.toHaveBeenCalled();
});

it.each(Object.keys(retired))("%s: refused staff get the guard error, no redirect and no effect", async name => {
  d.auth.mockRejectedValue(new Error("SAV_ACCESS_FORBIDDEN"));
  await expect((actions as unknown as Record<string, (f?: FormData) => Promise<void>>)[name](form())).rejects.toThrow("SAV_ACCESS_FORBIDDEN");
  expect(d.redirect).not.toHaveBeenCalled();
});

it("a forged or missing thread id never builds a dossier URL", async () => {
  const f = form(false); f.set("threadId", "../../studio/sante");
  await expect(actions.retryAction(f)).rejects.toThrow("REDIRECT:/studio/sav/archives?notice=SAV_LEGACY_COMMAND_RETIRED");
  await expect(actions.correctDecisionAction(form(false))).rejects.toThrow("REDIRECT:/studio/sav/archives?notice=SAV_LEGACY_COMMAND_RETIRED");
});

it("no page or component posts to a retired command any more", () => {
  const root = path.resolve(__dirname, "../..");
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx$/.test(e.name) && !/\.test\./.test(e.name) ? [path.join(dir, e.name)] : []);
  const offenders = walk(root).flatMap(file => { const text = readFileSync(file, "utf8"); return Object.keys(retired).filter(name => new RegExp(`\\b${name}\\b`).test(text)).map(name => `${path.relative(root, file)}:${name}`); });
  // Two legacy components still name a retired command but are mounted nowhere; if one
  // came back, its form would only land on the archive notice.
  expect(offenders).toEqual(["studio/sav/[id]/reply-draft.tsx:saveReplyDraftAction", "studio/sav/pilote/candidate-selector.tsx:startSelectedPilotBatchAction"]);
  const sources = walk(root).map(file => readFileSync(file, "utf8")).join("\n");
  for (const unmounted of ["./reply-draft", "./candidate-selector"]) expect(sources).not.toContain(`from "${unmounted}"`);
});

it("old V0 pages read on GET: no opening recorder, no context-refresh polling, no open-email POST", () => {
  const read = (file: string) => readFileSync(path.join(__dirname, file), "utf8");
  const dossier = read("[id]/page.tsx"), inbox = read("inbox.tsx"), pilot = read("pilote/page.tsx");
  for (const banned of ["<SavDossierOpened", "SavContextProgress", "refreshSavContextAction"]) expect(dossier).not.toContain(banned);
  expect(dossier).toContain("/studio/sav/archives/${id}");
  expect(inbox).not.toContain("openSavEmailAction");
  expect(inbox).toContain("action={retryWebhookAction}"); // A20 has no replacement yet: kept
  expect(inbox).toContain('href="/studio/sav/archives"');
  for (const banned of ["PilotCandidateSelector", "cancelPilotBatchLabAction", "listSavPilotCandidates"]) expect(pilot).not.toContain(banned);
});

it("A08, A12, A13: no activation check and no CRM read is left before the refusal", () => {
  const source = readFileSync(path.join(__dirname, "actions.ts"), "utf8");
  for (const banned of ["assertSavManualReplyEnabled", "refreshTicketContext", "@/lib/sav/config", "queueSavManualReply", "queueSavManualTicket"]) expect(source).not.toContain(banned);
  expect(fetch).not.toHaveBeenCalled();
});

it("A17, A33 and A20 are kept: guard, then their own function, never the refusal code", async () => {
  const f = form(); f.set("reason", "Vérifié dans le CRM"); f.set("noteId", thread); f.set("receiptId", thread);
  await expect(actions.reconcileTicketAction(f)).rejects.toThrow(`REDIRECT:/studio/sav/${thread}?review=SAV_RECONCILIATION_FAILED`);
  expect(hubspot.reconcileSavManualTicket).toHaveBeenCalledWith(thread, thread, "contact@example.test", "Vérifié dans le CRM");
  await expect(actions.reconcileTicketReturnAction(f)).rejects.toThrow(`REDIRECT:/studio/sav/${thread}?review=SAV_RECONCILIATION_TARGET_INVALID`);
  expect(hubspot.reconcileSavTicketReturn).toHaveBeenCalledWith(thread, thread, "contact@example.test");
  // A20 puts a failed receipt back to pending with attempts 0: not a read-only check.
  await expect(actions.retryWebhookAction(f)).rejects.toThrow("FORBIDDEN_CALL:service");
  expect(service.retrySavWebhookReceipt).toHaveBeenCalledWith(thread, "contact@example.test");
  expect(d.auth).toHaveBeenCalledTimes(3);
});
