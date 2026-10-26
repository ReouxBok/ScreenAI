import { createHash } from "node:crypto";
import { z } from "zod";

export const monitorCodes = ["worker_missing", "worker_stalled", "worker_failed", "watch_unavailable", "ingestion_failed", "ingestion_delayed", "quarantine", "schema_missing", "configuration_invalid", "automation_off", "authority_expiring", "authority_admission_limit", "runtime_expiring", "intake_held", "sources_changed_waiting", "dossier_waiting", "intake_blocked", "other_rules_expiring", "analysis_delayed", "analysis_waiting", "analysis_uncertain", "execution_delayed", "effect_uncertain", "effect_failed", "daily_budget_low", "rolling_budget_low", "collection_failed"] as const;
export type MonitorCode = typeof monitorCodes[number];
const issue = z.object({ code: z.enum(monitorCodes), count: z.number().int().nonnegative().max(2_147_483_647), severity: z.enum(["warning", "critical"]) }).strict();
const event = issue.extend({ change: z.enum(["opened", "worsened", "recovered"]), at: z.iso.datetime() });
export const monitorStateSchema = z.object({
  revision: z.literal(1), owner: z.uuid(), leaseUntil: z.iso.datetime(), observedAt: z.iso.datetime().nullable(),
  issues: z.array(issue).max(monitorCodes.length), events: z.array(event).max(monitorCodes.length),
  delivery: z.object({ state: z.enum(["idle", "unconfigured", "dispatched", "sent", "failed", "uncertain"]), hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), attempts: z.number().int().min(0).max(3), at: z.iso.datetime().nullable() }).strict(),
}).strict();
export type MonitorState = z.infer<typeof monitorStateSchema>;
export type MonitorIssue = z.infer<typeof issue>;
export type MonitorSnapshot = { observedAt: string; complete: boolean; codeRevision: string; runtimeMode: string; executionMode: string; issues: MonitorIssue[]; metrics: Record<string, number> };

export function nextMonitorState(previous: MonitorState, snapshot: MonitorSnapshot): MonitorState {
  const events = new Map(previous.events.map(e => [e.code, e]));
  const current = new Map(previous.issues.map(i => [i.code, i]));
  for (const i of snapshot.issues) {
    const old = current.get(i.code);
    if (!old || i.count > old.count || i.severity === "critical" && old.severity !== "critical")
      events.set(i.code, { ...i, change: old ? "worsened" : "opened", at: snapshot.observedAt });
    current.set(i.code, i);
  }
  if (snapshot.complete) for (const [code, old] of current) {
    if (!snapshot.issues.some(i => i.code === code)) {
      events.set(code, { ...old, count: 0, change: "recovered", at: snapshot.observedAt }); current.delete(code);
    }
  }
  return { ...previous, observedAt: snapshot.observedAt, issues: [...current.values()], events: [...events.values()] };
}

export function monitorWebhook(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname === "hooks.slack.com" && !u.port && !u.username && !u.password && !u.search && !u.hash
      && /^\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[a-zA-Z0-9]+$/.test(u.pathname) ? u.href : null;
  } catch { return null; }
}

/** Only fixed codes, bounded integers, timestamps and validated SHA enter Slack. */
export function monitorSlackText(snapshot: MonitorSnapshot, events: MonitorState["events"]) {
  const sha = /^[a-f0-9]{40}$/.test(snapshot.codeRevision) ? snapshot.codeRevision.slice(0, 7) : "non vérifié";
  return [`*Studio — surveillance serveur*`, `Observation UTC : ${snapshot.observedAt} · code ${sha}`,
    `Couverture : ${snapshot.complete ? "collecte technique complète" : "collecte partielle ; aucun rétablissement déduit"}. La qualité métier nécessite une revue des dossiers.`,
    ...events.map(e => `• ${e.change === "recovered" ? "Rétabli" : e.severity === "critical" ? "Incident critique" : "Alerte"} : ${e.code} (${e.count}).`),
    "Diagnostic et rapprochement nécessaires ; aucune réparation CRM ou aucun envoi client déclenché par cette surveillance.",
    "https://studio.limova.ai/studio/sav"].join("\n");
}
export const monitorDeliveryHash = (text: string) => createHash("sha256").update(text).digest("hex");
