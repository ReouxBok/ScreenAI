import { z } from "zod";

/** Closed technical metadata only. Never accept provider text, URLs, keys or customer content. */
export const caseModelTransportDiagnosticSchema = z.object({
  stage: z.enum(["preflight", "reservation", "network", "http", "envelope", "content", "json"]),
  code: z.enum(["key_unavailable", "model_invalid", "policy_invalid", "input_too_large", "preflight_failed", "reservation_missing", "reservation_policy_changed", "network_failed", "http_rejected", "envelope_invalid", "empty_response", "finish_not_stop", "output_json_invalid"]),
  networkAttempted: z.boolean(),
  inputBytes: z.number().int().nonnegative().max(100_000_000).optional(),
  maxInputBytes: z.number().int().positive().max(1_000_000).optional(),
  knowledgeCards: z.number().int().nonnegative().max(1000).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  finishReason: z.enum(["STOP", "MAX_TOKENS", "SAFETY", "RECITATION", "OTHER", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "UNKNOWN"]).optional(),
}).strict();
export type CaseModelTransportDiagnostic = z.infer<typeof caseModelTransportDiagnosticSchema>;
export const caseModelFinishReason = (value: string): NonNullable<CaseModelTransportDiagnostic["finishReason"]> => {
  const parsed = caseModelTransportDiagnosticSchema.shape.finishReason.unwrap().safeParse(value);
  return parsed.success ? parsed.data : "UNKNOWN";
};

/** Operator wording only; never changes admission, a decision, a retry or a customer reply. */
export function describeCaseModelTransportDiagnostic(value: unknown) {
  const parsed = caseModelTransportDiagnosticSchema.safeParse(value);
  if (!parsed.success) return null;
  const d = parsed.data;
  const label = d.code === "input_too_large" ? "Contexte trop volumineux : aucun appel de génération envoyé."
    : !d.networkAttempted ? "Génération refusée localement avant l'appel réseau."
    : d.stage === "http" ? "Requête de génération refusée par le fournisseur."
    : d.stage === "network" ? "Résultat de l'appel réseau inconnu : vérifier avant toute reprise."
    : "Réponse du modèle inexploitable : diagnostic conservé.";
  const detail = [d.code, d.stage, d.httpStatus === undefined ? null : `HTTP ${d.httpStatus}`,
    d.inputBytes === undefined ? null : `${d.inputBytes} octets / limite ${d.maxInputBytes ?? "inconnue"}`,
    d.knowledgeCards === undefined ? null : `${d.knowledgeCards} fiche(s)`, d.finishReason ?? null].filter(Boolean).join(" · ");
  return { label, detail };
}
