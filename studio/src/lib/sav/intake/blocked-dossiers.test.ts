/** SAV-92 (dossiers bloqués 16/11): every dossier is either handled or shown in the right team queue with a named reason.
 * Synthetic data only. No model, CRM or Gmail call; the routes below are pure console presentation. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savMailboxes, savMessages, savThreads, savIntakeRuns, savIntakeExecutions, savIntakeExecutionPolicies, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { encryptSavPayload } from "../crypto";
import { intakeBlockedCauseSql, intakeBlockedRunSql } from "./console-store";
import { intakeBlockedRowLabel, intakeBlockedSubCause, intakeContextRequiredRoute, intakeExecutionDecisionRoute, intakeSensitiveRoute, intakeStatusLabel } from "./console-presentation";
import { observationCoverage, observationLimitsLabel, publicObservationSourceCodes, splitObservationSourceErrors } from "../observation-coverage";

const KEY = "synthetic-intake-runtime-encryption-key";
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string;
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", KEY);
  await f.client.exec("TRUNCATE sav.intake_executions, sav.intake_execution_policies, sav.mailboxes CASCADE; TRUNCATE public.staff_users CASCADE");
  mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
});
/** A dossier whose current V1 run was left waiting 2 h ago, with or without a confirmed execution of the same mail. */
async function dossier(execution: "confirmed" | "waiting" | null) {
  const [thread] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "client@example.invalid" }).returning();
  const [message] = await f.db.insert(savMessages).values({ mailboxId, threadId: thread.id, direction: "inbound", fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"],
    subject: "Demande synthétique", gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload({ text: "Bonjour, demande synthétique.", attachments: [], headers: {} }),
    receivedAt: new Date(), createdAt: new Date(), analysisStatus: "intake_execution_confirmed" }).returning();
  const old = new Date(Date.now() - 2 * 3_600_000);
  const [run] = await f.db.insert(savIntakeRuns).values({ threadId: thread.id, messageId: message.id, version: 1, state: "waiting", attempts: 1, configHash: "c".repeat(64), policyHash: "p".repeat(64),
    payloadCiphertext: encryptSavPayload({ revision: "synthetic" }), createdAt: old, updatedAt: old }).returning();
  if (execution) {
    const [admin] = await f.db.insert(staffUsers).values({ clerkId: randomUUID(), email: `${randomUUID()}@example.invalid` }).returning();
    const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "synthetic", state: "approved", administratorId: admin.id, policyHash: "h".repeat(64), payloadCiphertext: encryptSavPayload({}) }).returning();
    await f.db.insert(savIntakeExecutions).values({ messageId: message.id, threadId: thread.id, runId: run.id, runVersion: 1, policyId: policy.id, policyHash: policy.policyHash,
      state: execution, ticketId: execution === "confirmed" ? "900001" : null, payloadCiphertext: encryptSavPayload({ reason: "SAV_INTAKE_EXECUTION_INTERRUPTED" }) });
  }
  return thread.id;
}
const blocked = async (threadId: string) => ((await f.db.execute(sql`select ${intakeBlockedRunSql(sql`${threadId}::uuid`)} as blocked, ${intakeBlockedCauseSql(sql`${threadId}::uuid`)} as cause`)) as unknown as { rows: { blocked: boolean; cause: string | null }[] }).rows[0];

describe("A — confirmed execution, follow-up incomplete", () => {
  it("a run left waiting after a confirmed execution is not blocked; limits give a partial follow-up with a named reason; codes carry no id", async () => {
    // Confirmed execution: the ticket exists, the waiting run is not an incident any more.
    expect(await blocked(await dossier("confirmed"))).toEqual({ blocked: false, cause: null });
    // Without a confirmed execution the same waiting run stays an incident (nothing hidden).
    expect(await blocked(await dossier("waiting"))).toEqual({ blocked: true, cause: "technical_wait" });
    expect(await blocked(await dossier(null))).toEqual({ blocked: true, cause: "technical_wait" });

    // Fixed limits (size, count) never make the follow-up incomplete: partial coverage, named, no loop promise.
    const limits = ["gmail:18c0synthetic:truncated_8000", "emails:association_limit_100", "gmail:message_limit_200", "timeline:truncated_64k", "notes:body_truncated", "status:history_limit_100"];
    expect(observationCoverage(limits)).toBe("partial");
    expect(splitObservationSourceErrors(limits).errors).toEqual([]);
    expect(observationLimitsLabel(limits)).toMatch(/^Suivi partiel : mail de plus de 8 000 caractères/);
    expect(observationLimitsLabel(limits)).toContain("sans relance en boucle");
    // A real read error keeps it incomplete (re-read at the daily follow-up); an unknown code is never hidden as a limit.
    expect(observationCoverage([...limits, "pipeline:HUBSPOT_HTTP_503"])).toBe("incomplete");
    expect(observationCoverage(["SOURCE_UNAVAILABLE"])).toBe("incomplete");
    expect(observationCoverage(["mystery:code"])).toBe("incomplete");
    expect(observationCoverage([])).toBe("complete");
    // Diagnostic: named families only, never the Gmail id or a provider message.
    const codes = publicObservationSourceCodes(["gmail:18c0synthetic:truncated_8000", "emails:Request failed for client@example.invalid", "SOURCE_UNAVAILABLE"]);
    expect(codes).toEqual([{ code: "hubspot_read_failed", kind: "error" }, { code: "source_unavailable", kind: "error" }, { code: "gmail_body_8000", kind: "limit" }]);
    expect(JSON.stringify(codes)).not.toMatch(/18c0synthetic|example\.invalid|Request failed/);
    // The label no longer promises a catch-up that never comes.
    expect(intakeBlockedRowLabel({ blockedCause: "technical_wait", status: "followup_pending", reason: "Ticket créé et actions confirmées. Collecte du suivi incomplète (source_unavailable)." }))
      .toBe("Suivi incomplet : la lecture d’une source a échoué ; nouvelle lecture au suivi quotidien");
  });
});

describe("B — unclassified technical waits", () => {
  it("context requests go to « À valider » with the expected action; an unconfirmed AI cost stays visible with its reason", () => {
    const route = intakeContextRequiredRoute({ disposition: { kind: "collect_context", reasons: ["history_incomplete"] }, progressKind: "processing", runState: "waiting" });
    expect(route).toMatchObject({ view: "to_validate", status: "context_required" });
    expect(route!.reason).toContain("Contexte à compléter par l’équipe");
    expect(route!.reason).toContain("Vérifier l’historique du ticket");
    expect(route!.reason).toContain("Aucune action automatique");
    expect(intakeContextRequiredRoute({ disposition: { kind: "collect_context", reasons: [] }, runState: "waiting" })!.reason).toContain("information manquante non précisée");
    // A scheduled automatic retry, a marked dependency or an already-human choice is not re-routed.
    expect(intakeContextRequiredRoute({ disposition: { kind: "collect_context", reasons: ["ticket_search_incomplete"] }, runState: "waiting", readRetryScheduled: true })).toBeNull();
    expect(intakeContextRequiredRoute({ disposition: { kind: "collect_context", reasons: ["forwarded_origin_unverified"] }, runState: "waiting" })).toBeNull();
    expect(intakeContextRequiredRoute({ disposition: { kind: "collect_context", reasons: ["history_incomplete"] }, progressKind: "human_choice", runState: "waiting" })).toBeNull();
    expect(intakeContextRequiredRoute({ disposition: { kind: "ticket" }, runState: "waiting" })).toBeNull();
    // Rows not yet re-projected are named from their raw reason instead of « non classée ».
    for (const reason of ["ticket_limit", "history_limit", "history_incomplete"])
      expect(intakeBlockedSubCause({ blockedCause: "technical_wait", status: "waiting", reason })).toBe("context_required");
    expect(intakeBlockedSubCause({ blockedCause: "technical_wait", status: "context_required", reason: route!.reason })).toBe("context_required");
    // Unconfirmed AI cost: named, still an incident in « En traitement »; the label says no new call and no reset.
    const usage = { blockedCause: "technical_wait", status: "waiting", reason: "SAV_INTAKE_RUNTIME_USAGE_UNCERTAIN" };
    expect(intakeBlockedSubCause(usage)).toBe("usage_uncertain");
    expect(intakeBlockedRowLabel(usage)).toBe("Coût IA à confirmer : aucun nouvel appel tant qu’il n’est pas rapproché (aucun reset)");
    expect(intakeBlockedSubCause({ blockedCause: "technical_wait", status: "observed", reason: "motif inconnu de cette version" })).toBe("unclassified");
  });
});

describe("C — sources changed", () => {
  it("a human decision goes to « À valider », an older execution is shown obsolete, a context change idle for 24 h is a named incident", () => {
    const progress = { state: "waiting", confirmed: false, runId: "run-1", version: 1, crmRecheck: { humanRequired: true },
      crmDelta: { reason: "original_evidence_changed", classification: "business_change", fields: ["ticket.added"], fieldsKnown: true, ticketIds: ["900002"] }, effects: [{ state: "planned" }] };
    const same = intakeExecutionDecisionRoute({ progress, run: { id: "run-1", version: 1, state: "observed" } });
    expect(same).toMatchObject({ view: "to_validate", status: "crm_review_required" });
    expect(same!.reason).toContain("aucune action envoyée");
    expect(same!.reason).toContain("ticket 900002");
    const newer = intakeExecutionDecisionRoute({ progress, run: { id: "run-2", version: 2, state: "observed" } });
    expect(newer).toMatchObject({ view: "to_validate", status: "execution_superseded" });
    expect(newer!.reason).toContain("Exécution de la version 1 obsolète");
    expect(newer!.reason).toContain("aucune ne le sera");
    expect(intakeStatusLabel("execution_superseded")).toBe("Ancienne exécution obsolète, décision attendue");
    // An automatic recheck still scheduled, or a confirmed execution, is not a team decision.
    expect(intakeExecutionDecisionRoute({ progress: { ...progress, crmRecheck: { humanRequired: false } }, run: { id: "run-1", version: 1, state: "observed" } })).toBeNull();
    expect(intakeExecutionDecisionRoute({ progress: { ...progress, confirmed: true, state: "confirmed" }, run: { id: "run-1", version: 1, state: "observed" } })).toBeNull();
    // Context changed, never retried: an incident after 24 h, a plain source change before.
    const now = new Date("2026-11-16T10:00:00Z");
    const row = { blockedCause: "technical_wait", status: "waiting", reason: "SAV_INTAKE_SEMANTIC_CONTEXT_CHANGED", runAttempts: 0 };
    expect(intakeBlockedSubCause({ ...row, runUpdatedAt: "2026-11-13T07:58:00Z" }, now)).toBe("context_changed_stalled");
    expect(intakeBlockedRowLabel({ ...row, runUpdatedAt: "2026-11-13T07:58:00Z" })).toBe("Incident : contexte changé sans nouvelle tentative depuis plus de 24 h");
    expect(intakeBlockedSubCause({ ...row, runUpdatedAt: "2026-11-16T09:00:00Z" }, now)).toBe("sources_changed");
    expect(intakeBlockedSubCause({ ...row, runAttempts: 1, runUpdatedAt: "2026-11-13T07:58:00Z" }, now)).toBe("sources_changed");
  });
});

describe("sensitive dossiers", () => {
  it("a finance or cancellation dossier is never left in a technical wait: it is shown in the sensitive team queue", () => {
    // Review F1: uncertain keeps its banner, observed is a transit, a confirmed/refused/follow-up dossier has nothing to decide.
    for (const status of ["uncertain", "observed", "followup_pending", "confirmed", "refused"])
      expect(intakeSensitiveRoute({ view: null, status, reason: null }, true)).toBeNull();
    for (const result of [{ view: null, status: "waiting", reason: "SAV_INTAKE_SEMANTIC_CONTEXT_CHANGED" }, { view: null, status: "context_changed", reason: "Les sources locales doivent être réinvestiguées" }]) {
      const route = intakeSensitiveRoute(result, true);
      expect(route).toMatchObject({ view: "sensitive", status: "sensitive_team" });
      expect(route!.reason).toMatch(/^Dossier sensible \(résiliation ou facturation\) : décision de l’équipe, jamais en attente technique\. État : /);
    }
    // Already in a team queue, actively moving, or not sensitive: unchanged.
    expect(intakeSensitiveRoute({ view: "to_validate", status: "context_required", reason: "x" }, true)).toBeNull();
    expect(intakeSensitiveRoute({ view: null, status: "analysing", reason: null }, true)).toBeNull();
    expect(intakeSensitiveRoute({ view: null, status: "waiting", reason: null }, false)).toBeNull();
  });
});
