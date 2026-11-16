/** Public, content-free outcomes. A parent conclusion never proves a provider effect. */
export type CaseComponentOutcome = Readonly<{ state: "absent" | "queued" | "confirmed" | "uncertain" | "blocked" | "skipped"; reason: string | null; message: string | null }>;
export type ComponentExecution = Readonly<{ id: string; key: string; state: string; reason: string | null; noteExpected: boolean;
  noteOutcome?: Record<string, unknown> | null; statusOutcome?: Record<string, unknown> | null }>;
export type ComponentEffect = Readonly<{ executionId: string; kind: string; state: string; confirmedAt: Date | null }>;
const explanations = {
  mapping_invalid: "Mapping de statut invalide ou incomplet.", owner_changed: "Le propriétaire du dossier a changé.",
  authority_changed: "L’autorité ou l’autorisation a changé.", new_mail: "Un nouveau mail rend cette action obsolète.",
  human_intervention: "Une intervention humaine est nécessaire.", paused: "L’agent est en pause.",
  disabled: "Cet effet est désactivé.", result_uncertain: "Résultat externe incertain : vérifier avant toute reprise.",
  effect_refused: "Effet refusé : une vérification est nécessaire.", note_pending: "La note attend une reprise supervisée.",
} as const;
function reasonOf(raw: unknown): keyof typeof explanations {
  const code = typeof raw === "string" ? raw.toLowerCase() : "";
  if (/stage_missing|stage_invalid|stages_equal|key_invalid|intent_invalid/.test(code)) return "mapping_invalid";
  if (/owner.*human|team_part|human/.test(code)) return "human_intervention";
  if (/owner/.test(code)) return "owner_changed";
  if (/new_input|customer_replied|inbound/.test(code)) return "new_mail";
  if (/authority|approval|policy|mutation|qualification|provenance|scope/.test(code)) return "authority_changed";
  if (/pause/.test(code)) return "paused";
  if (/disabled|_off/.test(code)) return "disabled";
  return "effect_refused";
}
const outcome = (state: CaseComponentOutcome["state"], reason: keyof typeof explanations | null = null): CaseComponentOutcome =>
  ({ state, reason, message: reason ? explanations[reason] : null });

export function caseComponentOutcomes(execution: ComponentExecution, executions: readonly ComponentExecution[], effects: readonly ComponentEffect[]): { mail: CaseComponentOutcome; note: CaseComponentOutcome; status: CaseComponentOutcome } {
  const own = effects.filter(e => e.executionId === execution.id);
  function component(kinds: string[], expected: boolean, stored?: Record<string, unknown> | null): CaseComponentOutcome {
    const rows = own.filter(e => kinds.includes(e.kind));
    if (kinds.every(kind => rows.some(e => e.kind === kind && e.state === "confirmed" && e.confirmedAt))) return outcome("confirmed");
    if (rows.some(e => ["dispatched", "acked", "uncertain"].includes(e.state))) return outcome("uncertain", "result_uncertain");
    if (kinds[0] === "note_create" && expected && execution.reason === "SAV_CASE_EFFECT_RECOVERY_NOTE_PENDING") return outcome("queued", "note_pending");
    if (stored?.state === "skipped") return outcome("skipped", reasonOf(stored.reason));
    if (stored?.state === "blocked") return outcome("blocked", reasonOf(stored.reason));
    if (rows.some(e => e.state === "failed") || (expected || rows.length > 0) && (execution.reason || ["refused", "cancelled"].includes(execution.state))) return outcome("blocked", reasonOf(execution.reason));
    return outcome(rows.length || expected ? "queued" : "absent");
  }
  const isStage = execution.key.startsWith("case-stage:");
  let status = isStage ? component(["ticket_stage"], true) : component(["ticket_stage"], false, execution.statusOutcome);
  const stageId = execution.statusOutcome?.executionId;
  if (typeof stageId === "string") {
    const stage = executions.find(e => e.id === stageId);
    status = stage?.key.startsWith("case-stage:") ? caseComponentOutcomes({ ...stage, statusOutcome: null }, [], effects).status : outcome("blocked", "effect_refused");
  } else if (!isStage && status.state === "absent" && execution.reason) {
    // A refused receipt has not queued a stage; it never means the ticket was moved.
    status = outcome("blocked", reasonOf(execution.reason));
  }
  return { mail: component(["reply_send"], !isStage && execution.key.startsWith("reply:")),
    note: component(["note_create", "note_associate"], execution.noteExpected, execution.noteOutcome), status };
}
