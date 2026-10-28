import { publicIntakeCrmDelta } from "./execution-context";
import { CRM_RECHECK_POLICY } from "./crm-recheck";

/** The next safe step of a waiting execution, as a code. It never authorizes anything:
 * it states what the existing machinery will do, or that a person must decide. */
export type ExecutionNextStep = "none" | "read_only_verification" | "human_decision" | "automatic_recheck" | "wait_resume" | "unknown";
const EFFECT_KINDS = new Set(["ticket_create", "note_create", "note_associate", "email_create", "email_associate", "stage_new", "identity_send"]);
const EFFECT_STATES = new Set(["planned", "dispatched", "acked", "uncertain", "confirmed"]);
export function intakeExecutionNextStep(input: { state: string; reason: string | null; crmDelta: ReturnType<typeof publicIntakeCrmDelta>; effectStates: string[]; crmRecheck?: ReturnType<typeof publicCrmRecheck> }): ExecutionNextStep {
  if (input.state === "confirmed") return "none";
  if (input.effectStates.some(s => ["dispatched", "acked", "uncertain"].includes(s)) || input.state === "uncertain") return "read_only_verification";
  if (input.crmRecheck) return input.crmRecheck.humanRequired ? "human_decision" : "automatic_recheck";
  if (/PAUSE|AGENT_PAUSED/.test(input.reason ?? "")) return "wait_resume";
  if (/ADDRESS_PROOF_UNRESOLVED|MUTATION_NOT_GRANTED|OWNER_CHANGED|OWNER_UNKNOWN|VERSION_INCOMPATIBLE/.test(input.reason ?? "")) return "human_decision";
  if (input.crmDelta) return input.crmDelta.classification === "business_change" ? "human_decision" : "automatic_recheck";
  if (/CRM_READ_|GMAIL_|RECONCILIATION|PASS_LIMIT|INTERRUPTED/.test(input.reason ?? "")) return "automatic_recheck";
  return "unknown";
}
/** Allow-listed execution facts for the admin diagnostic: kinds, states, counters, dates. */
export function publicExecutionEffects(rows: { kind: string; state: string; reconcileAttempts: number; nextReconcileAt: Date | null; confirmedAt: Date | null }[]) {
  return rows.slice(0, 20).map(r => ({ kind: EFFECT_KINDS.has(r.kind) ? r.kind : null, state: EFFECT_STATES.has(r.state) ? r.state : null,
    reconcileAttempts: Number.isSafeInteger(r.reconcileAttempts) ? r.reconcileAttempts : null, nextReconcileAt: r.nextReconcileAt, confirmed: r.state === "confirmed" && Boolean(r.confirmedAt) }));
}
/** Allow-listed CRM schedule: counters, bound, cause and due date. */
export function publicCrmRecheck(raw: unknown) {
  const r = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (!r || !Number.isSafeInteger(r.attempts) || typeof r.humanRequired !== "boolean") return null;
  const nextAt = typeof r.nextAt === "string" && Number.isFinite(Date.parse(r.nextAt)) ? r.nextAt : null;
  return { attempts: r.attempts as number, max: CRM_RECHECK_POLICY.maxRechecks, humanRequired: r.humanRequired, nextAt,
    cause: ["business_change", "unattributed_email", "unknown", "read_incomplete", "deterministic"].includes(String(r.cause)) ? String(r.cause) : "unknown" };
}
