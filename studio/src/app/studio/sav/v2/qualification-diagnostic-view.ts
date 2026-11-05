// UX lots 6-7: the read-only view of pole A6's qualification diagnostic (readCaseQualificationDiagnostic, revision sav-case-qualification-diagnostic.v1),
// composed with A6 8ab6507. The mapper is pure; `readQualificationDiagnostic` is the only I/O, called by the page AFTER its staff check.
import type { requireIntakeConsoleStaff } from "@/lib/sav/intake/console-auth";
//
// Rules of the operator wording:
// - `since` is when the INPUT that needs a requalification arrived; never "blocked since", "down since", nor the admission decision date;
// - `stale_ready` means only that the latest input passed the canonical journal precheck: identity, families, admission and attribution are not proven;
// - a technical cause (V1 reader, policy read) is never stored in phase 1: it reads "cause technique non enregistrée", never reconstructed;
// - unknown revision, state or code is said to be unknown; nothing outside the closed lists is echoed.

export const QUALIFICATION_DIAGNOSTIC_REVISION = "sav-case-qualification-diagnostic.v1";
/** Pole A6's DTO, read defensively: every field may be missing or of another type in a future revision. `inputKey` (an internal id) is never shown. */
export type ProposedQualificationDiagnostic = Readonly<{
  revision: unknown; caseId: unknown; caseVersion: unknown; state: unknown; inputVersion: unknown; since: unknown; block: unknown; nature: unknown;
  inputKey?: unknown; runtimeCause?: unknown;
}>;
export type QualificationRead =
  | { state: "absent" } | { state: "unavailable" } | { state: "not_found" }
  | { state: "ok"; diagnostic: ProposedQualificationDiagnostic };

const blockLabels: Readonly<Record<string, string>> = {
  handback_unproven: "la dernière entrée est un dossier rendu par une personne, sans entrée V1 désignée",
  acknowledgement_input: "la dernière entrée est un accusé de réception relayé, sans exécution V1",
  relay_proof_invalid: "la preuve de relais de la dernière entrée est illisible ou incohérente",
  v1_source_mismatch: "la cible du relais ne correspond pas à la source V1",
  v1_requests_mismatch: "les demandes du dossier ne correspondent pas à la décision V1",
  rule_invalid: "la règle de qualification ne s’applique pas à ces demandes",
};
/** Technical causes: seen only at run time in phase 1, never stored, so never shown as recorded. */
const TECHNICAL_BLOCKS = new Set(["v1_context_unavailable", "policy_unavailable"]);
const own = <T,>(labels: Readonly<Record<string, T>>, key: unknown) => typeof key === "string" && Object.hasOwn(labels, key) ? labels[key] : undefined;

type StaffSession = Awaited<ReturnType<typeof requireIntakeConsoleStaff>>;
export type QualificationDiagnosticReader = (caseId: string, caller: { kind: "staff_session_verified"; staffUserId: string }) => Promise<ProposedQualificationDiagnostic | null>;
/**
 * The page's only call to pole A6. `staff` is the value the existing staff check returned for this request: the caller A6 requires is built from it and from
 * nothing else (never a URL, a body or a client value). The caller is a statement of that check, not a proof by itself; the proof is the check that ran first.
 * `caseId` is the case the page already read for its ticket. A failed read is "unavailable", a null "not_found", a missing reader "absent".
 */
export async function readQualificationDiagnostic(reader: QualificationDiagnosticReader | null, staff: StaffSession, caseId: string): Promise<QualificationRead> {
  if (!reader) return { state: "absent" };
  try {
    const diagnostic = await reader(caseId, { kind: "staff_session_verified", staffUserId: staff.id });
    return diagnostic ? { state: "ok", diagnostic } : { state: "not_found" };
  } catch { return { state: "unavailable" }; }
}

export type QualificationDisplay = Readonly<{
  tone: "neutral" | "warning" | "danger"; title: string; detail: string | null;
  /** Never a permission: the page offers no action on any state. */
  actionable: false;
}>;

export function describeQualificationDiagnostic(read: QualificationRead, page: Readonly<{ caseId: string; version: number }>, date: (value: string) => string): QualificationDisplay {
  const show = (tone: QualificationDisplay["tone"], title: string, detail: string | null = null): QualificationDisplay => ({ tone, title, detail, actionable: false });
  if (read.state === "absent") return show("neutral", "Diagnostic de qualification non branché dans cette version : son absence ne veut pas dire que la qualification est à jour.");
  if (read.state === "unavailable") return show("danger", "Diagnostic de qualification indisponible : la lecture a échoué. Ce n’est pas un état « à jour ».");
  if (read.state === "not_found") return show("danger", "Aucun diagnostic de qualification pour ce dossier : ce n’est pas un état « à jour ».");
  const d = read.diagnostic;
  // A diagnostic of another case is a reader fault, never something to show here.
  if (d.caseId !== page.caseId) return show("danger", "Diagnostic de qualification rejeté : il ne concerne pas ce dossier.");
  if (d.revision !== QUALIFICATION_DIAGNOSTIC_REVISION) return show("warning", "Diagnostic de qualification dans un format que cette version ne lit pas.");
  const stale = typeof d.caseVersion === "number" && d.caseVersion !== page.version ? ` Établi sur la version ${d.caseVersion} ; le dossier est en version ${page.version}.` : "";
  const since = typeof d.since === "string" && Number.isFinite(Date.parse(d.since)) ? `Entrée à requalifier reçue le ${date(d.since)}.` : "Date de l’entrée à requalifier non enregistrée.";
  // A6 phase 1 records no cause seen by a V1 lookup or a run: said, never guessed.
  const runtime = d.runtimeCause === "not_recorded" ? " Cause éventuellement vue lors d’un passage : non enregistrée." : d.runtimeCause === undefined ? "" : " Cause vue lors d’un passage : format non reconnu par cette version.";
  const unproven = `Cette lecture ne prouve ni l’identité, ni les familles, ni l’admission, ni l’attribution ; aucune action n’en découle.${runtime}`;
  switch (d.state) {
    case "current": return show("neutral", `Qualification à jour : l’admission porte sur l’entrée la plus récente.${stale}`);
    case "no_customer_input": return show("neutral", `Aucune entrée client à qualifier.${stale}`);
    case "stale_ready": return show("warning", "À requalifier : la dernière entrée est un mail relayé lisible, la qualification doit repasser.", `${since} ${unproven}${stale}`);
    case "stale_unknown": return show("warning", "À requalifier : la dernière entrée n’est pas un mail ; la cause n’est pas déterminée par cette lecture.", `${since} ${unproven}${stale}`);
    case "stale_blocked": {
      const label = own(blockLabels, d.block);
      if (label && d.nature === "contract_blocked") return show("warning", `À requalifier, bloqué par le contrat : ${label}.`, `${since} ${unproven}${stale}`);
      const technical = typeof d.block === "string" && TECHNICAL_BLOCKS.has(d.block);
      return show("warning", technical || d.nature === "technical" ? "À requalifier : cause technique non enregistrée (une panne passée n’est pas conservée)." : "À requalifier : cause non reconnue par cette version.", `${since} ${unproven}${stale}`);
    }
    default: return show("warning", "État de qualification non reconnu par cette version.");
  }
}
