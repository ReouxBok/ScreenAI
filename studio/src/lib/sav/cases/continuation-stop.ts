import "server-only";
import { and, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs } from "@/db/schema";
import type { CaseContinuationReport, CaseContinuationTrigger } from "./v2-entry-binding";

export const CONTINUATION_MARK = { action: "sav_v2_continuation_failed", entityType: "sav_v2_case" } as const;
export type ContinuationStop = { code: string; since: string; lastAt: string; failures: number;
  responsible: "ticket_owner" | "sav_administrator"; nextAction: "return_ticket_to_v2" | "review_scope_and_decision" | "review_authorization" | "inspect_failure" };
type Db = ReturnType<typeof requireDb>;
const row = (caseId: string) => and(eq(auditLogs.entityType, CONTINUATION_MARK.entityType), eq(auditLogs.entityId, caseId), eq(auditLogs.action, CONTINUATION_MARK.action));
const actions = ["return_ticket_to_v2", "review_scope_and_decision", "review_authorization", "inspect_failure"];
export function publicContinuationStop(meta: unknown): ContinuationStop | null {
  const m = meta as Partial<ContinuationStop> | null;
  if (!m || typeof m.code !== "string" || !/^[a-zA-Z0-9_]{1,100}$/.test(m.code)) return null;
  const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : "";
  return { code: m.code, since: date(m.since) || date(m.lastAt), lastAt: date(m.lastAt),
    failures: Number.isSafeInteger(m.failures) && m.failures! >= 0 ? m.failures! : 0,
    responsible: m.responsible === "ticket_owner" ? "ticket_owner" : "sav_administrator",
    nextAction: actions.includes(m.nextAction!) ? m.nextAction! : "inspect_failure" };
}
export async function readContinuationStop(caseId: string, db: Db = requireDb()) {
  const [mark] = await db.select({ meta: auditLogs.technicalMetadata }).from(auditLogs).where(row(caseId));
  return publicContinuationStop(mark?.meta);
}
/** A durable operator task. No case, owner, decision, lease or budget is changed. */
export async function markContinuationStop(caseId: string, trigger: CaseContinuationTrigger, code: string | null) {
  const db = requireDb();
  const [existing] = await db.select().from(auditLogs).where(row(caseId));
  if (code === null) { if (existing) await db.delete(auditLogs).where(row(caseId)); return; }
  const previous = publicContinuationStop(existing?.technicalMetadata), now = new Date().toISOString();
  const owner = code.startsWith("ticket_owner_"), scope = code.includes("scope") || code.startsWith("qualification_");
  const technicalMetadata = { code, trigger, since: previous?.since || now, lastAt: now, failures: (previous?.failures ?? 0) + 1,
    responsible: owner ? "ticket_owner" : "sav_administrator",
    nextAction: owner ? "return_ticket_to_v2" : scope ? "review_scope_and_decision" : code === "admission" || code.includes("authorization") || code.includes("POLICY") || code.includes("AUTHORITY") ? "review_authorization" : "inspect_failure" };
  if (existing) await db.update(auditLogs).set({ technicalMetadata }).where(row(caseId));
  else await db.insert(auditLogs).values({ actorEmail: "system", ...CONTINUATION_MARK, entityId: caseId, technicalMetadata });
}
/** Only positive progress clears an unresolved stop. A routine no_reply, pause or busy pass proves no recovery. */
export function continuationStopCode(report: CaseContinuationReport): string | null | undefined {
  if (report.reason && (report.reason.startsWith("ticket_owner_") || report.reason.includes("scope") || report.reason === "admission" || report.reason === "admission_not_current_input")) return report.reason;
  if (report.reason === "team_part_handoff_unavailable") return undefined;
  if (report.status === "awaiting_person") return "authorization_human_required";
  if (["human_task_required", "proposal_refused", "queue_refused", "not_wired"].includes(report.status)) return report.reason ?? report.status;
  if (["queued", "started", "recorded"].includes(report.status)) return null;
  return undefined;
}
