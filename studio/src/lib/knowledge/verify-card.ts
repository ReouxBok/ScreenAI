import { canonicalKnowledgeSchema, type CanonicalKnowledge } from "./contracts";
import { savCardCompletenessChecks, savCardFieldLabel, savCardVersionValidityChecks, type SavCardCheck, type SavCardCheckSeverity } from "./card-checks";
import { savCardTextProblemMessage, savCardTextProblems } from "./card-safety";
import { savQualifiedProjectionBody } from "./conversion";
import { unsafeKnowledgeDraftFields } from "./onboarding-extraction";
import { knowledgeInjectionPatterns } from "./paste-new";
import { savCardPublicationWarnings } from "./publication-check";
import { assertSavSupportDelivery, savSupportDeliverySchema, type SavSupportDelivery } from "./support-delivery";

/*
 * SAV-92 « Vérifier ma fiche » (harness gate 1): every existing card check at once, on the form as it is, with the field at fault. Before,
 * the checks fell one by one at different moments (save, preview, publication) and the save refusal named no field. Pure: no database,
 * network, model or effect; the day is given. It decides nothing: saving, submitting and publishing keep their own server checks, which use
 * the same rules (card-safety.ts, card-checks.ts, publication-check.ts, support-delivery.ts).
 */
export type SavCardVerificationInput = Readonly<{
  title: string; document: unknown; delivery?: unknown;
  sources?: ReadonlyArray<Readonly<{ ref?: string; label?: string }>>; reason?: string;
}>;
export type SavCardProblem = Readonly<{ field: string; fieldLabel: string; severity: SavCardCheckSeverity; code: string; message: string }>;
export type SavCardVerification = Readonly<{ ok: boolean; errors: number; warnings: number; problems: SavCardProblem[] }>;

const SOURCE_REF = /^(?:https:\/\/[^\s]+|(?:content|sav-learning|sav-observation|knowledge-source):[a-z0-9:._-]+)$/i;
const DELIVERY_MESSAGES: Record<string, string> = {
  SAV_DELIVERY_DIAGNOSTIC_REQUIRED: "Restitution « diagnostic » choisie, mais la fiche n’a aucun contrôle de diagnostic.",
  SAV_DELIVERY_PROCEDURE_HAS_DIAGNOSTIC: "Restitution « procédure » choisie, mais la fiche contient un diagnostic structuré : choisissez « diagnostic ».",
  SAV_DELIVERY_REFERENCE_INVALID: "La restitution cite une étape, un prérequis ou une exception qui n’existe plus : requalifiez-la.",
  SAV_DELIVERY_VARIANT_REQUIRES_REVIEW: "Une étape à variantes est affectée à un objectif client : séparez les variantes avant de qualifier.",
  SAV_DELIVERY_STEP_UNCLASSIFIED: "Chaque étape doit être affectée à un objectif client ou au SAV interne.",
};

function schemaMessage(issue: { code: string; maximum?: unknown; minimum?: unknown; message: string }) {
  if (issue.code === "too_big") return `Trop long${typeof issue.maximum === "number" || typeof issue.maximum === "bigint" ? ` (maximum ${issue.maximum})` : ""}.`;
  if (issue.code === "too_small") return "À compléter.";
  if (issue.message === "SEMANTIC_STEP_IDS_MUST_BE_UNIQUE") return "Deux étapes ont le même identifiant : recréez l’une des deux.";
  if (issue.message === "SAV_DIAGNOSTIC_STEP_REFERENCE_INVALID") return "Un contrôle de diagnostic cite une étape qui n’existe plus.";
  return "Valeur invalide.";
}

function stringsOf(value: unknown, path: string, out: Array<[string, string]>) {
  if (typeof value === "string") out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((child, index) => stringsOf(child, `${path}.${index}`, out));
  else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) if (key !== "id") stringsOf(child, path ? `${path}.${key}` : key, out);
  return out;
}

export function verifySavKnowledgeCard(input: SavCardVerificationInput, now: Date): SavCardVerification {
  const checks: SavCardCheck[] = [];
  const add = (field: string, severity: SavCardCheckSeverity, code: string, message: string) => checks.push({ field, severity, code, message });
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title.length < 3) add("title", "error", "title_short", "Donner un titre clair à la connaissance (3 caractères au moins).");
  for (const problem of savCardTextProblems(title)) add("title", "error", `unsafe_${problem.code}`, savCardTextProblemMessage(problem));

  const parsed = canonicalKnowledgeSchema.safeParse(input.document);
  if (!parsed.success) for (const issue of parsed.error.issues) add(issue.path.join(".") || "document", "error", `schema_${issue.code}`, schemaMessage(issue as never));
  // The rest reads the document as written, even when incomplete: a draft is checked field by field, never refused as a whole.
  const raw = (input.document && typeof input.document === "object" ? input.document : {}) as Partial<CanonicalKnowledge>;
  const document = { ...raw, steps: Array.isArray(raw.steps) ? raw.steps : [], prerequisites: Array.isArray(raw.prerequisites) ? raw.prerequisites : [],
    exceptions: Array.isArray(raw.exceptions) ? raw.exceptions : [], expectedResult: typeof raw.expectedResult === "string" ? raw.expectedResult : "",
    escalation: typeof raw.escalation === "string" ? raw.escalation : "", objective: typeof raw.objective === "string" ? raw.objective : "",
    productVersion: typeof raw.productVersion === "string" ? raw.productVersion : "" } as CanonicalKnowledge;

  // Unsafe text, each field with every reason (the save check, now explained).
  try { for (const field of unsafeKnowledgeDraftFields(document)) for (const problem of field.problems) add(field.path, "error", `unsafe_${problem.code}`, savCardTextProblemMessage(problem)); }
  catch { add("diagnostic", "error", "diagnostic_unreadable", "Diagnostic structuré illisible : vérifiez ses faits, contrôles et causes."); }

  // Completeness: the preview's rules (one entry per step without its observable result).
  const sources = (input.sources ?? []).filter(source => (source.label ?? "").trim() || (source.ref ?? "").trim());
  for (const check of savCardCompletenessChecks(document, sources, input.reason ?? "", parsed.success)) if (check.code !== "schema_incomplete") checks.push(check);
  sources.forEach((source, index) => {
    if (!SOURCE_REF.test((source.ref ?? "").trim())) add(`sources.${index}.ref`, "error", "source_ref_invalid", "Référence attendue : une adresse https:// ou une référence Studio (content:…, knowledge-source:…).");
    if ((source.label ?? "").trim().length < 3) add(`sources.${index}.label`, "error", "source_label_short", "Donnez un nom d’au moins 3 caractères à la source.");
  });

  // Version and validity: the one rule shared with the paste screen and the server preview.
  checks.push(...savCardVersionValidityChecks(document, now));

  // Restitution: the classification every step needs before the agent may deliver the card.
  const delivery = savSupportDeliverySchema.safeParse(input.delivery ?? { version: 1, mode: "unclassified" });
  if (!delivery.success) add("delivery", "error", "delivery_invalid", "Restitution illisible : requalifiez-la.");
  else if (delivery.data.mode === "unclassified") add("delivery", "error", "delivery_unclassified", "Qualifier la restitution : procédure complète, diagnostic conditionnel ou consignes internes.");
  else {
    try { assertSavSupportDelivery(document, delivery.data as SavSupportDelivery); }
    catch (error) { const code = error instanceof Error ? error.message : "SAV_DELIVERY_REFERENCE_INVALID"; add("delivery", "error", code.toLowerCase(), DELIVERY_MESSAGES[code] ?? DELIVERY_MESSAGES.SAV_DELIVERY_REFERENCE_INVALID); }
  }

  // Publication budget: the warnings shown at publication, computed now on what would be published (same body and resolution as submit).
  try {
    const metadata = { resolution: { steps: document.steps.map(step => step.instruction), symptoms: document.supportContext?.symptoms ?? [document.objective], escalation: document.escalation } };
    for (const warning of savCardPublicationWarnings({ bodyMarkdown: savQualifiedProjectionBody(document), metadata }))
      add(warning.code === "card_too_many_steps" ? "steps" : warning.code === "card_symptoms_missing" ? "supportContext.symptoms" : warning.code === "card_escalation_missing" ? "escalation" : "card", "warning", warning.code, warning.label);
  } catch { /* An unreadable step list is already reported by the schema check above. */ }

  // Text addressed to the assistant: kept as data, flagged for review (the paste screen's rule).
  for (const [path, value] of stringsOf({ title, ...document }, "", [])) if (knowledgeInjectionPatterns.some(pattern => pattern.test(value)))
    add(path, "warning", "instruction_like_text", "Ce texte s’adresse à l’assistant (« ignore les consignes », « publie automatiquement »…) : il restera une donnée, jamais une consigne. Reformulez-le.");

  const seen = new Set<string>();
  const problems = checks.filter(check => { const key = `${check.field}|${check.code}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .map(check => ({ ...check, fieldLabel: savCardFieldLabel(check.field) }))
    .sort((a, b) => Number(a.severity === "warning") - Number(b.severity === "warning"));
  const errors = problems.filter(problem => problem.severity === "error").length;
  return { ok: errors === 0, errors, warnings: problems.length - errors, problems };
}
