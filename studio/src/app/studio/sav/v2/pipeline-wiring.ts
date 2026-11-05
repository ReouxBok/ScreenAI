// What THIS build wires for each V2 step, as the operator must read it: a port or a pure decision without an application caller is not
// "work in progress". The list is static and checked against the sources by pipeline-wiring.test.ts (a new caller fails the test until this
// file says so). The only live inputs are the two existing flags, read as the domain reads them; nothing here reads a case or calls a port.
import { readCaseEffectsMode } from "@/lib/sav/cases/case-effects";
import { savCaseRecordingEnabled } from "@/lib/sav/cases/case-store";

export type V2WiringState = "wired_behind_flag" | "dormant" | "absent";
export type V2WiringStep = Readonly<{ step: string; label: string; state: V2WiringState; detail: string; flag?: "SAV_CASE_RECORDING" | "SAV_CASE_EFFECTS" }>;

export const V2_PIPELINE_WIRING: readonly V2WiringStep[] = [
  { step: "entry", label: "Entrée : mail confirmé par V1 → dossier V2", state: "wired_behind_flag", flag: "SAV_CASE_RECORDING",
    detail: "Relais après l’intake V1 confirmée, rattrapage des relais manqués ; un relais raté ne bloque jamais V1." },
  { step: "owner_admission", label: "Propriétaire V2 et admission automatique", state: "dormant",
    detail: "Le pilote traite les tickets admissibles déjà attribués à SAV Pilote. L’attribution automatique à la création reste à raccorder. Les tickets des personnes restent à l’équipe." },
  { step: "investigation", label: "Investigation de l’agent", state: "wired_behind_flag",
    detail: "À l’arrivée du mail, V2 peut lire le dossier et chercher une fiche si le pilote et sa politique l’autorisent." },
  { step: "proposal", label: "Préparation de la réponse", state: "wired_behind_flag",
    detail: "La décision retenue peut produire une réponse avec la mention IA." },
  { step: "validation", label: "Autorisation de la réponse accès", state: "wired_behind_flag",
    detail: "La règle du pilote peut autoriser la réponse précise. Cette page permet uniquement de consulter son état." },
  { step: "send", label: "File et envoi", state: "wired_behind_flag", flag: "SAV_CASE_EFFECTS",
    detail: "L’exécuteur vérifie l’autorisation avant envoi. Si le reçu manque, il vérifie l’envoi déjà engagé." },
  { step: "follow_up", label: "Relance J2", state: "wired_behind_flag",
    detail: "Le contrôle des échéances peut mettre en file une relance déjà approuvée si le client n’a pas répondu." },
  { step: "crm_note", label: "Note interne HubSpot V2", state: "absent", detail: "Texte et validation non définis : aucune note n’est créée par V2." },
];

const stateLabels: Record<V2WiringState, string> = { wired_behind_flag: "Branché", dormant: "Présent, non branché", absent: "Absent" };
export type V2WiringRow = V2WiringStep & Readonly<{ stateLabel: string; flagLabel: string | null }>;

/** The flags are read exactly as the domain reads them: anything but the exact enabling value is off. */
export function readV2PipelineWiring(env: Readonly<Record<string, string | undefined>> = process.env): V2WiringRow[] {
  const effects = readCaseEffectsMode(env);
  return V2_PIPELINE_WIRING.map(step => ({
    ...step, stateLabel: stateLabels[step.state],
    flagLabel: step.flag === "SAV_CASE_RECORDING" ? (savCaseRecordingEnabled(env) ? "réglage activé sur cet environnement" : "réglage désactivé sur cet environnement")
      : step.flag === "SAV_CASE_EFFECTS" ? (effects.mode === "supervised" ? "mode supervisé demandé" : effects.ignored ? "réglage non reconnu, traité comme désactivé" : "désactivé sur cet environnement")
      : null,
  }));
}
