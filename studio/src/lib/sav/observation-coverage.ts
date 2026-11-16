/**
 * SAV-92 (dossiers bloqués, groupe A): a follow-up source code is either a real read error (the source could not be
 * read; the daily catch-up reads it again) or a coverage limit (a fixed size or count bound: the same source would hit
 * the same bound at every re-read). A limit never makes the follow-up "incomplete": it is a partial coverage, named.
 * Pure: no I/O. The stored `sourceErrors` keep every code, so the learning gates that require no code stay unchanged.
 */
/** A truncated message or note BODY is incomplete evidence (rule of review 575f21c, test « F4 reports a truncated
 * synchronized Gmail body as incomplete evidence »): it stays a real error below, never a coverage limit. Only bounds on
 * the NUMBER of items read (or the oldest timeline events dropped) are limits. */
const LIMITS: ReadonlyArray<[RegExp, string]> = [
  [/^gmail:message_limit_200$/, "gmail_messages_200"],
  [/^gmail:outbound_coverage_unverified$/, "gmail_outbound_unverified"],
  [/^[a-z_]+:association_limit_100$/, "hubspot_associations_100"],
  [/^emails:delivery_unverified$/, "hubspot_delivery_unverified"],
  [/^timeline:truncated_64k$/, "timeline_64k"],
  [/^status:history_limit_100$/, "status_history_100"],
  [/^studio:review_limit_200$/, "studio_reviews_200"],
  [/^studio:action_limit_200$/, "studio_actions_200"],
];
const LIMIT_LABELS: Record<string, string> = {
  gmail_messages_200: "fil de plus de 200 messages",
  gmail_outbound_unverified: "envois Gmail non vérifiables sans ticket",
  hubspot_associations_100: "plus de 100 éléments associés au ticket",
  hubspot_delivery_unverified: "remise d’un mail sortant HubSpot non confirmée",
  timeline_64k: "chronologie de plus de 64 Ko (début non conservé)",
  status_history_100: "historique de statut de plus de 100 changements",
  studio_reviews_200: "plus de 200 corrections Studio",
  studio_actions_200: "plus de 200 actions Studio",
};
/** Families of real read errors, without any id or provider message (allow-list). */
const ERRORS: ReadonlyArray<[RegExp, string]> = [
  [/^gmail:[^:]+:truncated_8000$/, "gmail_body_truncated_8000"],
  [/^(emails|notes|calls|meetings|tasks|communications):body_truncated$/, "hubspot_body_truncated_8000"],
  [/^studio:review_truncated_8000$/, "studio_review_truncated_8000"],
  [/^ticket_link_changed$/, "ticket_link_changed"],
  [/^intake:baseline_missing$/, "intake_baseline_missing"],
  [/^new_inbound_awaiting_sync$/, "new_inbound_awaiting_sync"],
  [/^dossier_review_awaiting_sync$/, "dossier_review_awaiting_sync"],
  [/^pipeline:/, "hubspot_pipeline_unavailable"],
  [/^[a-z_]+:partial_batch$/, "hubspot_partial_batch"],
  [/^[a-z_]+:unassociated_record$/, "hubspot_unassociated_record"],
  [/^[a-z_]+:timestamp_missing$/, "hubspot_timestamp_missing"],
  [/^SOURCE_UNAVAILABLE$/, "source_unavailable"],
  [/^SAV_[A-Z0-9_]+$/, "studio_read_failed"],
  [/^HUBSPOT_HTTP_\d{3}$/, "hubspot_http_error"],
  [/^(emails|notes|calls|meetings|tasks|communications):/, "hubspot_read_failed"],
];
export type ObservationSourceCode = { code: string; kind: "limit" | "error" };
export type ObservationCoverage = "complete" | "partial" | "incomplete";
/** One code, named without any id, address or provider message. Unknown codes are real errors (never hidden as a limit). */
export function observationSourceCode(raw: string): ObservationSourceCode {
  const limit = LIMITS.find(([pattern]) => pattern.test(raw));
  if (limit) return { code: limit[1], kind: "limit" };
  const error = ERRORS.find(([pattern]) => pattern.test(raw));
  return { code: error ? error[1] : "unknown_source_error", kind: "error" };
}
export function splitObservationSourceErrors(errors: readonly unknown[] | null | undefined) {
  const codes = (Array.isArray(errors) ? errors : []).filter((e): e is string => typeof e === "string").map(observationSourceCode);
  return { errors: codes.filter(c => c.kind === "error"), limits: codes.filter(c => c.kind === "limit") };
}
export function observationCoverage(errors: readonly unknown[] | null | undefined): ObservationCoverage {
  const split = splitObservationSourceErrors(errors);
  return split.errors.length ? "incomplete" : split.limits.length ? "partial" : "complete";
}
/** SAV-92 (stuck follow-ups): a body cut at 8 000 characters of TEXT is a real error for the learning gates and the
 * « résolu » qualification (review 575f21c; `sourceErrors` and the observation state keep it), but it is deterministic:
 * the same immutable object is cut the same way at every daily read. The CONSOLE therefore shows it as a named partial
 * follow-up instead of an endless "incomplete" one. Any other error still makes the console follow-up incomplete. */
const BODY_TRUNCATIONS: Record<string, string> = {
  gmail_body_truncated_8000: "un corps dépasse 8 000 caractères",
  hubspot_body_truncated_8000: "un corps dépasse 8 000 caractères",
  studio_review_truncated_8000: "une correction Studio dépasse 8 000 caractères",
};
export function observationConsoleCoverage(errors: readonly unknown[] | null | undefined): ObservationCoverage {
  const split = splitObservationSourceErrors(errors);
  const other = split.errors.filter(e => !(e.code in BODY_TRUNCATIONS));
  return other.length ? "incomplete" : split.errors.length || split.limits.length ? "partial" : "complete";
}
/** Diagnostic projection: distinct named codes, bounded, never the raw value. */
export function publicObservationSourceCodes(errors: readonly unknown[] | null | undefined, max = 20): ObservationSourceCode[] {
  const seen = new Map<string, ObservationSourceCode>();
  for (const c of [...splitObservationSourceErrors(errors).errors, ...splitObservationSourceErrors(errors).limits]) if (!seen.has(c.code)) seen.set(c.code, c);
  return [...seen.values()].slice(0, max);
}
/** "Suivi partiel : …" — the named limits of a partial coverage, for the console. */
export function observationLimitsLabel(errors: readonly unknown[] | null | undefined) {
  const split = splitObservationSourceErrors(errors);
  const cut = [...new Set(split.errors.filter(e => e.code in BODY_TRUNCATIONS).map(e => BODY_TRUNCATIONS[e.code]))];
  const names = [...new Set([...cut, ...split.limits.map(l => LIMIT_LABELS[l.code] ?? l.code)])];
  return names.length ? `Suivi partiel : ${names.join(" ; ")}. Couverture limitée assumée, sans relance en boucle.${cut.length ? " Texte tronqué : non qualifiable « résolu » ni apprenable sans relecture humaine." : ""}` : null;
}
